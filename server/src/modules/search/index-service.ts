import type {Pool, PoolClient} from 'pg';
import type {CommitteeContentSnapshot, ContentLanguage, LocalizedNames} from '@quorum/contracts';
import {formatCommitteeContent, normalizeSearchTerm} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import {generatedTerms, SEARCH_ALGORITHM_VERSION, searchSourceHash} from './terms.js';

export type SearchSubject = {kind: string; key: string; names: LocalizedNames; builtinCode?: string};
const identity = (subject: Pick<SearchSubject, 'kind' | 'key'>) => JSON.stringify([subject.kind, subject.key]);
export const searchKey = (...parts: string[]) => JSON.stringify(parts);

async function activeGeneration(pool: Pool): Promise<number> {
  const current = await pool.query<{active_generation_id: string | null; algorithm_version: string | null}>(
    `SELECT s.active_generation_id,g.algorithm_version FROM search_index_state s
     LEFT JOIN search_index_generations g ON g.id=s.active_generation_id WHERE s.singleton=true`);
  if (current.rows[0]?.active_generation_id && current.rows[0].algorithm_version === SEARCH_ALGORITHM_VERSION) {
    return Number(current.rows[0].active_generation_id);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM search_index_state WHERE singleton=true FOR UPDATE');
    const latest = await client.query<{active_generation_id: string | null; algorithm_version: string | null}>(
      `SELECT s.active_generation_id,g.algorithm_version FROM search_index_state s
       LEFT JOIN search_index_generations g ON g.id=s.active_generation_id WHERE s.singleton=true`);
    if (latest.rows[0]?.active_generation_id && latest.rows[0].algorithm_version === SEARCH_ALGORITHM_VERSION) {
      await client.query('COMMIT');
      return Number(latest.rows[0].active_generation_id);
    }
    const created = await client.query<{id: string}>(
      `INSERT INTO search_index_generations(algorithm_version,activated_at) VALUES ($1,now()) RETURNING id`,
      [SEARCH_ALGORITHM_VERSION]);
    const id = Number(created.rows[0]?.id);
    await client.query('UPDATE search_index_state SET active_generation_id=$1,updated_at=now() WHERE singleton=true', [id]);
    await client.query('COMMIT');
    return id;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** Reads a persisted projection, regenerating only a missing or changed subject. */
export async function indexedSearchTerms(pool: Pool, subjects: SearchSubject[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!subjects.length) return result;
  const generation = await activeGeneration(pool);
  const keys = subjects.map(subject => identity(subject));
  const rows = await pool.query<{subject_key: string; source_hash: string; terms: string[]}>(
    `SELECT subject_key,source_hash,terms FROM generated_search_terms
     WHERE generation_id=$1 AND subject_key=ANY($2::text[])`, [generation, keys]);
  const stored = new Map(rows.rows.map(row => [row.subject_key, row]));
  const changed: Array<{kind: string; key: string; hash: string; terms: string[]}> = [];
  for (const subject of subjects) {
    const key = identity(subject);
    const hash = searchSourceHash(subject.names, subject.builtinCode);
    const hit = stored.get(key);
    const terms = hit?.source_hash === hash ? hit.terms : generatedTerms(subject.names, subject.builtinCode);
    result.set(key, terms);
    if (hit?.source_hash !== hash) changed.push({kind: subject.kind, key, hash, terms});
  }
  if (changed.length) {
    await pool.query(`INSERT INTO generated_search_terms(generation_id,subject_kind,subject_key,source_hash,terms)
      SELECT $1,item->>'kind',item->>'key',item->>'hash',item->'terms'
      FROM jsonb_array_elements($2::jsonb) item
      ON CONFLICT (generation_id,subject_kind,subject_key) DO UPDATE
      SET source_hash=excluded.source_hash,terms=excluded.terms`, [generation, JSON.stringify(changed)]);
  }
  return result;
}

export function termsFor(index: Map<string, string[]>, subject: Pick<SearchSubject, 'kind' | 'key'>): string[] {
  return index.get(identity(subject)) ?? [];
}

export function namesForSeat(snapshot: CommitteeContentSnapshot, stableKey: string, displayName: string,
  language: string): LocalizedNames {
  return snapshot.committeeTemplate?.members.find(item => item.stableKey === stableKey)?.names
    ?? snapshot.countryTemplate.countries.find(item => item.stableKey === stableKey)?.names
    ?? {[language]: displayName};
}

export async function manualCountryTerms(pool: Pool, ownerId: string, templateKey: string,
  stableKeys: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (!stableKeys.length) return result;
  const rows = await pool.query<{country_stable_key: string; term: string}>(
    `SELECT country_stable_key,term FROM manual_country_search_terms
     WHERE owner_user_id=$1 AND country_template_key=$2 AND country_stable_key=ANY($3::text[])`,
    [ownerId, templateKey, stableKeys]);
  for (const row of rows.rows) result.set(row.country_stable_key,
    [...(result.get(row.country_stable_key) ?? []), row.term]);
  return result;
}

export async function replaceManualCountryTerms(client: PoolClient, ownerId: string, templateKey: string,
  stableKey: string, values: string[]): Promise<void> {
  const distinct = new Map<string, string>();
  for (const value of values) {
    const term = value.trim();
    const normalized = normalizeSearchTerm(term);
    if (!term || term.length > 64 || !normalized) throw new AppError({reason: 'INVALID_SEARCH_TERM',
      code: 'VALIDATION_FAILED', message: 'Country search term is invalid.'});
    distinct.set(normalized, term);
  }
  if (distinct.size > 20) throw new AppError({reason: 'TOO_MANY_SEARCH_TERMS',
    code: 'VALIDATION_FAILED', message: 'Too many country search terms.'});
  await client.query(`DELETE FROM manual_country_search_terms
    WHERE owner_user_id=$1 AND country_template_key=$2 AND country_stable_key=$3`, [ownerId, templateKey, stableKey]);
  for (const [normalized, term] of distinct) {
    await client.query(`INSERT INTO manual_country_search_terms
      (owner_user_id,country_template_key,country_stable_key,term,normalized_term) VALUES ($1,$2,$3,$4,$5)`,
    [ownerId, templateKey, stableKey, term, normalized]);
  }
}

async function allSubjects(client: PoolClient): Promise<SearchSubject[]> {
  const subjects: SearchSubject[] = [];
  const {builtinCountryTemplate} = await import('../stage4/service.js');
  const builtin = builtinCountryTemplate();
  const builtinCodes = new Set(builtin.countries.map(country => country.stableKey));
  for (const country of builtin.countries) subjects.push({kind: 'country',
    key: searchKey(builtin.key, country.stableKey), names: country.names, builtinCode: country.stableKey});
  const custom = await client.query<{template_id: string; stable_key: string; names: LocalizedNames}>(
    `SELECT c.country_template_id AS template_id,c.stable_key,c.names FROM country_template_countries c`);
  for (const row of custom.rows) subjects.push({kind: 'country',
    key: searchKey(`custom:${row.template_id}`, row.stable_key), names: row.names});
  const versions = await client.query<{id: string; definition: {motions?: Array<{id: string; names?: LocalizedNames}>;
    points?: Array<{id: string; names?: LocalizedNames}>}}>('SELECT id,definition FROM rule_package_versions');
  for (const row of versions.rows) {
    for (const item of row.definition.motions ?? []) if (item.names) subjects.push({kind: 'motion',
      key: searchKey(row.id, item.id), names: item.names});
    for (const item of row.definition.points ?? []) if (item.names) subjects.push({kind: 'point',
      key: searchKey(row.id, item.id), names: item.names});
  }
  const seats = await client.query<{id: string; stable_key: string; display_name: string; committee_language: string;
    content_snapshot: CommitteeContentSnapshot}>(`SELECT s.id,s.stable_key,s.display_name,c.committee_language,c.content_snapshot
      FROM committee_seats s JOIN committees c ON c.id=s.committee_id`);
  for (const row of seats.rows) subjects.push({kind: 'seat', key: row.id,
    names: namesForSeat(row.content_snapshot, row.stable_key, row.display_name, row.committee_language),
    ...(row.content_snapshot.countryTemplate.builtin && builtinCodes.has(row.stable_key)
      ? {builtinCode: row.stable_key} : {})});
  const documents = await client.query<{id: string; kind: 'RESOLUTION' | 'AMENDMENT'; ordinal: number;
    custom_title: string | null; session_ordinal: number; committee_language: ContentLanguage}>(
    `SELECT d.id,d.kind,d.ordinal,d.custom_title,ms.ordinal AS session_ordinal,c.committee_language
     FROM documents d JOIN committees c ON c.id=d.committee_id
     JOIN meeting_sessions ms ON ms.id=d.meeting_session_id`);
  for (const row of documents.rows) subjects.push({kind: 'document-title', key: row.id,
    names: {[row.committee_language]: formatCommitteeContent({kind: row.kind, ordinal: row.ordinal,
      customTitle: row.custom_title, sessionOrdinal: row.session_ordinal}, row.committee_language)}});
  return subjects;
}

/** Builds a complete replacement generation. Manual terms live in a different table. */
export async function rebuildSearchIndex(pool: Pool): Promise<{generation: number; count: number}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('quorum-search-rebuild',0))`);
    const subjects = await allSubjects(client);
    const generationRow = await client.query<{id: string}>(
      'INSERT INTO search_index_generations(algorithm_version) VALUES ($1) RETURNING id',
      [SEARCH_ALGORITHM_VERSION]);
    const generation = Number(generationRow.rows[0]?.id);
    for (let offset = 0; offset < subjects.length; offset += 200) {
      const batch = subjects.slice(offset, offset + 200).map(subject => ({kind: subject.kind, key: identity(subject),
        hash: searchSourceHash(subject.names, subject.builtinCode), terms: generatedTerms(subject.names, subject.builtinCode)}));
      await client.query(`INSERT INTO generated_search_terms(generation_id,subject_kind,subject_key,source_hash,terms)
        SELECT $1,item->>'kind',item->>'key',item->>'hash',item->'terms'
        FROM jsonb_array_elements($2::jsonb) item`, [generation, JSON.stringify(batch)]);
    }
    await client.query('SELECT active_generation_id FROM search_index_state WHERE singleton=true FOR UPDATE');
    await client.query('UPDATE search_index_generations SET activated_at=now() WHERE id=$1', [generation]);
    await client.query('UPDATE search_index_state SET active_generation_id=$1,last_error=NULL,updated_at=now() WHERE singleton=true',
      [generation]);
    // Readers may still be using the prior generation for one request.
    await client.query(`DELETE FROM search_index_generations
      WHERE activated_at < now()-interval '1 day' AND id<>$1`, [generation]);
    await client.query('COMMIT');
    return {generation, count: subjects.length};
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

import {createHash, randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {
  CommitteeSummary,
  CommitteeTemplate,
  CommitteeTemplateInput,
  CommitteeNote,
  CommitteeTextPost,
  CountryTemplate,
  CountryTemplateInput,
  FlagSnapshot,
  LocalizedNames,
  SeatRank,
  Stage4CommitteeSeat
} from '@quorum/contracts';
import {localizedDisplayName} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {
  appendEvent,
  audit,
  idempotentTransaction,
  isChair,
  lockedCommittee,
  requireBusinessIdentity,
  requireChair,
  requireEditable,
  transaction,
  type Stage4CommitteeRow,
  type Stage4Context
} from './database.js';
import {
  assertExactBody,
  validateCommitteeTemplate,
  validateCountryTemplate,
  validateFlag,
  validateLocalizedNames
} from './validation.js';

interface CountryTemplateRow extends QueryResultRow {
  id: string; names: LocalizedNames; default_language: string; country_languages: string[];
  revision: number; created_at: Date; updated_at: Date;
}
interface CountryRow extends QueryResultRow {
  id: string; stable_key: string; names: LocalizedNames; default_language: string; continent: string | null;
  sort_order: number; flag_type: FlagSnapshot['type']; flag_value: string; revision: number;
}
interface CommitteeTemplateRow extends QueryResultRow {
  id: string; names: LocalizedNames; default_language: string; country_template_key: string;
  revision: number; created_at: Date; updated_at: Date;
}
interface TemplateMemberRow extends QueryResultRow {
  id: string; stable_key: string; names: LocalizedNames; default_language: string; rank: SeatRank;
  can_vote: boolean; has_veto: boolean; must_vote: boolean; sort_order: number;
  flag_type: FlagSnapshot['type']; flag_value: string; revision: number;
}

const BUILTIN_COUNTRY_CODES = (`af al dz as ad ao ai aq ag ar am aw au at az bs bh bd bb by be bz bj bm bt bo bq ba bw bv br io bn bg bf bi cv kh cm ca ky cf td cl cn cx cc co km cg cd ck cr ci hr cu cw cy cz dk dj dm do ec eg sv gq er ee sz et fk fo fj fi fr gf pf tf ga gm ge de gh gi gr gl gd gp gu gt gg gn gw gy ht hm va hn hk hu is in id ir iq ie im il it jm jp je jo kz ke ki kp kr kw kg la lv lb ls lr ly li lt lu mo mg mw my mv ml mt mh mq mr mu yt mx fm md mc mn me ms ma mz mm na nr np nl nc nz ni ne ng nu nf mk mp no om pk pw ps pa pg py pe ph pn pl pt pr qa re ro ru rw bl sh kn lc mf pm vc ws sm st sa sn rs sc sl sg sx sk si sb so za gs ss es lk sd sr sj se ch sy tw tj tz th tl tg tk to tt tn tr tm tc tv ug ua ae gb us um uy uz vu ve vn vg vi wf eh ye zm zw eu un`).split(' ');

function builtInCountryName(code: string, language: string): string {
  if (code === 'un') return language === 'zh-CN' ? '联合国' : 'United Nations';
  if (code === 'eu') return language === 'zh-CN' ? '欧洲联盟' : 'European Union';
  try { return new Intl.DisplayNames([language], {type: 'region'}).of(code.toUpperCase()) || code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}

function builtinCountryTemplate(): CountryTemplate {
  return {
    id: 'builtin:default', key: 'builtin:default', builtin: true,
    names: {'zh-CN': '默认国家', en: 'Default countries'}, defaultLanguage: 'zh-CN',
    countryLanguages: ['zh-CN', 'en'], revision: 1, createdAt: null, updatedAt: null,
    countries: BUILTIN_COUNTRY_CODES.map((code, sortOrder) => ({
      id: `builtin:${code}`, stableKey: code,
      names: {'zh-CN': builtInCountryName(code, 'zh-CN'), en: builtInCountryName(code, 'en')},
      defaultLanguage: 'en', continent: null, sortOrder,
      flag: code === 'un' ? {type: 'EMOJI', value: '🇺🇳'} : {type: 'STANDARD', value: code}, revision: 1
    }))
  };
}

function committeeSummary(row: Stage4CommitteeRow): CommitteeSummary {
  return {id: row.id, ownerUserId: row.owner_user_id, name: row.name, chairLabel: row.chair_label,
    topic: row.topic, conference: row.conference, visibility: row.visibility, operationMode: row.operation_mode,
    status: row.status, activeRulePackageVersionId: row.active_rule_package_version_id, revision: row.revision};
}

function flag(type: FlagSnapshot['type'], value: string): FlagSnapshot { return {type, value} as FlagSnapshot; }

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Base revision is invalid.'});
  }
  return Number(value);
}

function requiredText(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function textContent(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Content is invalid.'});
  }
  return value;
}

function sortOrder(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Sort order is invalid.'});
  return Number(value);
}

function contentSummary(content: string): {characterCount: number; sha256: string} {
  return {characterCount: [...content].length, sha256: createHash('sha256').update(content).digest('hex')};
}

async function committeeAccess(client: PoolClient, row: Stage4CommitteeRow, userId: string): Promise<{
  audience: 'OWNER' | 'CHAIR' | 'MEMBER'; capabilities: string[]; seatId: string | null;
}> {
  if (row.owner_user_id === userId) return {audience: 'OWNER', capabilities: ['COMMITTEE_OWNER'], seatId: null};
  if (await isChair(client, row.id, userId)) return {audience: 'CHAIR', capabilities: ['CHAIR'], seatId: null};
  const member = await client.query<{seat_id: string | null}>(`SELECT a.seat_id FROM committee_memberships m
    LEFT JOIN seat_assignments a ON a.committee_id=m.committee_id AND a.user_id=m.user_id AND a.status='ACTIVE'
    WHERE m.committee_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'`, [row.id, userId]);
  if (!member.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  return {audience: 'MEMBER', capabilities: ['MEMBER'], seatId: member.rows[0].seat_id};
}

interface NoteRow extends QueryResultRow {
  id: string; committee_id: string; title: string; content: string; sort_order: number; revision: number;
  created_by_user_id: string; created_at: Date; updated_at: Date; deleted_at: Date | null;
}

interface TextPostRow extends QueryResultRow {
  id: string; committee_id: string; title: string; content: string; sort_order: number; revision: number;
  author_seat_id: string | null; author_display_name: string; actor_user_id: string;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
}

function note(row: NoteRow): CommitteeNote {
  return {id: row.id, title: row.title, content: row.content, sortOrder: row.sort_order, revision: row.revision,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null};
}

function textPost(row: TextPostRow): CommitteeTextPost {
  return {id: row.id, title: row.title, content: row.content, sortOrder: row.sort_order, revision: row.revision,
    authorSeatId: row.author_seat_id, authorDisplayName: row.author_display_name, actorUserId: row.actor_user_id,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null};
}

async function countryTemplateById(client: PoolClient, ownerId: string, id: string, lock = false): Promise<CountryTemplateRow> {
  const result = await client.query<CountryTemplateRow>(`SELECT * FROM country_templates
    WHERE id=$1 AND owner_user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId]);
  if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Country template not found.'});
  return result.rows[0];
}

async function committeeTemplateById(client: PoolClient, ownerId: string, id: string, lock = false): Promise<CommitteeTemplateRow> {
  const result = await client.query<CommitteeTemplateRow>(`SELECT * FROM committee_templates
    WHERE id=$1 AND owner_user_id=$2${lock ? ' FOR UPDATE' : ''}`, [id, ownerId]);
  if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Committee template not found.'});
  return result.rows[0];
}

async function countryTemplate(client: PoolClient, row: CountryTemplateRow): Promise<CountryTemplate> {
  const countries = await client.query<CountryRow>(`SELECT * FROM country_template_countries
    WHERE country_template_id=$1 ORDER BY sort_order,stable_key`, [row.id]);
  return {id: row.id, key: `custom:${row.id}`, builtin: false, names: row.names, defaultLanguage: row.default_language,
    countryLanguages: row.country_languages, revision: row.revision, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(), countries: countries.rows.map(item => ({
      id: item.id, stableKey: item.stable_key, names: item.names, defaultLanguage: item.default_language,
      continent: item.continent, sortOrder: item.sort_order, flag: flag(item.flag_type, item.flag_value), revision: item.revision
    }))};
}

async function committeeTemplate(client: PoolClient, row: CommitteeTemplateRow): Promise<CommitteeTemplate> {
  const members = await client.query<TemplateMemberRow>(`SELECT * FROM committee_template_members
    WHERE committee_template_id=$1 ORDER BY sort_order,stable_key`, [row.id]);
  return {id: row.id, names: row.names, defaultLanguage: row.default_language,
    countryTemplateKey: row.country_template_key, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    members: members.rows.map(item => ({id: item.id, stableKey: item.stable_key, names: item.names,
      defaultLanguage: item.default_language, rank: item.rank, canVote: item.can_vote, hasVeto: item.has_veto,
      mustVote: item.must_vote, sortOrder: item.sort_order, flag: flag(item.flag_type, item.flag_value), revision: item.revision}))};
}

async function resolveCountryTemplateReference(client: PoolClient, ownerId: string, key: string): Promise<string | null> {
  if (key === 'builtin:default') return null;
  const match = /^custom:([0-9a-f-]{36})$/.exec(key);
  if (!match) throw new AppError({code: 'VALIDATION_FAILED', message: 'Country template key is invalid.'});
  await countryTemplateById(client, ownerId, match[1] as string);
  return match[1] as string;
}

async function replaceCountries(client: PoolClient, templateId: string, value: CountryTemplateInput): Promise<void> {
  await client.query('DELETE FROM country_template_countries WHERE country_template_id=$1', [templateId]);
  for (const country of value.countries) {
    await client.query(`INSERT INTO country_template_countries
      (id,country_template_id,stable_key,names,default_language,continent,sort_order,flag_type,flag_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(), templateId, country.stableKey, country.names, country.defaultLanguage, country.continent ?? null,
      country.sortOrder, country.flag.type, country.flag.value]);
  }
}

async function replaceMembers(client: PoolClient, templateId: string, value: CommitteeTemplateInput): Promise<void> {
  await client.query('DELETE FROM committee_template_members WHERE committee_template_id=$1', [templateId]);
  for (const member of value.members) {
    await client.query(`INSERT INTO committee_template_members
      (id,committee_template_id,stable_key,names,default_language,rank,can_vote,has_veto,must_vote,sort_order,flag_type,flag_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), templateId, member.stableKey, member.names, member.defaultLanguage, member.rank,
      member.canVote, member.hasVeto, member.mustVote, member.sortOrder, member.flag.type, member.flag.value]);
  }
}

export class Stage4Service {
  constructor(private readonly pool: Pool) {}

  async listCountryTemplates(auth: AuthenticatedSession): Promise<CountryTemplate[]> {
    requireBusinessIdentity(auth);
    const client = await this.pool.connect();
    try {
      const rows = await client.query<CountryTemplateRow>('SELECT * FROM country_templates WHERE owner_user_id=$1 ORDER BY created_at,id', [auth.user.id]);
      return [builtinCountryTemplate(), ...await Promise.all(rows.rows.map(row => countryTemplate(client, row)))];
    } finally { client.release(); }
  }

  async getCountryTemplate(auth: AuthenticatedSession, id: string): Promise<CountryTemplate> {
    requireBusinessIdentity(auth);
    if (id === 'builtin:default') return builtinCountryTemplate();
    const client = await this.pool.connect();
    try { return countryTemplate(client, await countryTemplateById(client, auth.user.id, id)); }
    finally { client.release(); }
  }

  async createCountryTemplate(auth: AuthenticatedSession, input: unknown, idempotencyKey: string, context: Stage4Context): Promise<CountryTemplate> {
    requireBusinessIdentity(auth);
    const value = validateCountryTemplate(input);
    return idempotentTransaction({pool: this.pool, auth, route: 'POST /api/v1/country-templates', key: idempotencyKey,
      request: value, status: 201, work: async client => {
        const id = randomUUID();
        const inserted = await client.query<CountryTemplateRow>(`INSERT INTO country_templates
          (id,owner_user_id,names,default_language,country_languages) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, auth.user.id, value.names, value.defaultLanguage, value.countryLanguages]);
        await replaceCountries(client, id, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.country_created', resourceType: 'country_template', resourceId: id,
          after: {countryCount: value.countries.length}});
        return countryTemplate(client, inserted.rows[0] as CountryTemplateRow);
      }});
  }

  async updateCountryTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>, context: Stage4Context): Promise<CountryTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'template']);
    const revision = positiveRevision(input.baseRevision); const value = validateCountryTemplate(input.template);
    return transaction(this.pool, async client => {
      const current = await countryTemplateById(client, auth.user.id, id, true);
      if (current.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This template changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const updated = await client.query<CountryTemplateRow>(`UPDATE country_templates SET names=$2,default_language=$3,
        country_languages=$4,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, value.names, value.defaultLanguage, value.countryLanguages]);
      await replaceCountries(client, id, value);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.country_updated', resourceType: 'country_template', resourceId: id,
        before: {revision: current.revision}, after: {revision: current.revision + 1, countryCount: value.countries.length}});
      return countryTemplate(client, updated.rows[0] as CountryTemplateRow);
    });
  }

  async cloneCountryTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CountryTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['names', 'defaultLanguage']);
    const source = await this.getCountryTemplate(auth, id);
    const localized = input.names === undefined && input.defaultLanguage === undefined
      ? {names: source.names, defaultLanguage: source.defaultLanguage}
      : validateLocalizedNames(input.names, input.defaultLanguage);
    const value: CountryTemplateInput = {names: localized.names, defaultLanguage: localized.defaultLanguage,
      countryLanguages: source.countryLanguages, countries: source.countries.map(item => ({stableKey: item.stableKey,
        names: item.names, defaultLanguage: item.defaultLanguage, continent: item.continent,
        sortOrder: item.sortOrder, flag: item.flag}))};
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/country-templates/${id}/clone`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const cloneId = randomUUID();
        const inserted = await client.query<CountryTemplateRow>(`INSERT INTO country_templates
          (id,owner_user_id,names,default_language,country_languages) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [cloneId, auth.user.id, value.names, value.defaultLanguage, value.countryLanguages]);
        await replaceCountries(client, cloneId, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.country_cloned', resourceType: 'country_template', resourceId: cloneId,
          after: {sourceTemplateId: id, countryCount: value.countries.length}});
        return countryTemplate(client, inserted.rows[0] as CountryTemplateRow);
      }});
  }

  async deleteCountryTemplate(auth: AuthenticatedSession, id: string, context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth);
    if (id === 'builtin:default') throw new AppError({code: 'FORBIDDEN', message: 'Built-in templates cannot be deleted.'});
    await transaction(this.pool, async client => {
      const current = await countryTemplateById(client, auth.user.id, id, true);
      const used = await client.query<{id: string; names: LocalizedNames; default_language: string}>(`SELECT id,names,default_language
        FROM committee_templates WHERE owner_user_id=$1 AND country_template_id=$2 ORDER BY created_at,id`, [auth.user.id, id]);
      if (used.rowCount) throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This country template is still in use.',
        details: {templates: used.rows.map(item => ({id: item.id, name: localizedDisplayName(item.names, item.default_language, item.default_language)}))}});
      await client.query('DELETE FROM country_template_countries WHERE country_template_id=$1', [id]);
      await client.query('DELETE FROM country_templates WHERE id=$1', [id]);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.country_deleted', resourceType: 'country_template', resourceId: id,
        before: {revision: current.revision}});
    });
  }

  async listCommitteeTemplates(auth: AuthenticatedSession): Promise<CommitteeTemplate[]> {
    requireBusinessIdentity(auth); const client = await this.pool.connect();
    try {
      const rows = await client.query<CommitteeTemplateRow>('SELECT * FROM committee_templates WHERE owner_user_id=$1 ORDER BY created_at,id', [auth.user.id]);
      return Promise.all(rows.rows.map(row => committeeTemplate(client, row)));
    } finally { client.release(); }
  }

  async getCommitteeTemplate(auth: AuthenticatedSession, id: string): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); const client = await this.pool.connect();
    try { return committeeTemplate(client, await committeeTemplateById(client, auth.user.id, id)); }
    finally { client.release(); }
  }

  async createCommitteeTemplate(auth: AuthenticatedSession, input: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); const value = validateCommitteeTemplate(input);
    return idempotentTransaction({pool: this.pool, auth, route: 'POST /api/v1/committee-templates', key: idempotencyKey,
      request: value, status: 201, work: async client => {
        const countryTemplateId = await resolveCountryTemplateReference(client, auth.user.id, value.countryTemplateKey);
        const id = randomUUID();
        const inserted = await client.query<CommitteeTemplateRow>(`INSERT INTO committee_templates
          (id,owner_user_id,names,default_language,country_template_key,country_template_id)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, auth.user.id, value.names, value.defaultLanguage, value.countryTemplateKey, countryTemplateId]);
        await replaceMembers(client, id, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.committee_created', resourceType: 'committee_template', resourceId: id,
          after: {countryTemplateKey: value.countryTemplateKey, memberCount: value.members.length}});
        return committeeTemplate(client, inserted.rows[0] as CommitteeTemplateRow);
      }});
  }

  async updateCommitteeTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'template']);
    const baseRevision = positiveRevision(input.baseRevision); const value = validateCommitteeTemplate(input.template);
    return transaction(this.pool, async client => {
      const current = await committeeTemplateById(client, auth.user.id, id, true);
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT',
        message: 'This template changed since it was loaded.', details: {currentRevision: current.revision}});
      const countryTemplateId = await resolveCountryTemplateReference(client, auth.user.id, value.countryTemplateKey);
      const updated = await client.query<CommitteeTemplateRow>(`UPDATE committee_templates SET names=$2,default_language=$3,
        country_template_key=$4,country_template_id=$5,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, value.names, value.defaultLanguage, value.countryTemplateKey, countryTemplateId]);
      await replaceMembers(client, id, value);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.committee_updated', resourceType: 'committee_template', resourceId: id,
        before: {revision: current.revision}, after: {revision: current.revision + 1,
          countryTemplateKey: value.countryTemplateKey, memberCount: value.members.length}});
      return committeeTemplate(client, updated.rows[0] as CommitteeTemplateRow);
    });
  }

  async cloneCommitteeTemplate(auth: AuthenticatedSession, id: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeTemplate> {
    requireBusinessIdentity(auth); assertExactBody(input, ['names', 'defaultLanguage']);
    const source = await this.getCommitteeTemplate(auth, id);
    const localized = input.names === undefined && input.defaultLanguage === undefined
      ? {names: source.names, defaultLanguage: source.defaultLanguage}
      : validateLocalizedNames(input.names, input.defaultLanguage);
    const value: CommitteeTemplateInput = {names: localized.names, defaultLanguage: localized.defaultLanguage,
      countryTemplateKey: source.countryTemplateKey, members: source.members.map(item => ({stableKey: item.stableKey,
        names: item.names, defaultLanguage: item.defaultLanguage, rank: item.rank, canVote: item.canVote,
        hasVeto: item.hasVeto, mustVote: item.mustVote, sortOrder: item.sortOrder, flag: item.flag}))};
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committee-templates/${id}/clone`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const countryTemplateId = await resolveCountryTemplateReference(client, auth.user.id, value.countryTemplateKey);
        const cloneId = randomUUID();
        const inserted = await client.query<CommitteeTemplateRow>(`INSERT INTO committee_templates
          (id,owner_user_id,names,default_language,country_template_key,country_template_id)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [cloneId, auth.user.id, value.names, value.defaultLanguage, value.countryTemplateKey, countryTemplateId]);
        await replaceMembers(client, cloneId, value);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
          action: 'templates.committee_cloned', resourceType: 'committee_template', resourceId: cloneId,
          after: {sourceTemplateId: id, memberCount: value.members.length}});
        return committeeTemplate(client, inserted.rows[0] as CommitteeTemplateRow);
      }});
  }

  async deleteCommitteeTemplate(auth: AuthenticatedSession, id: string, context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth);
    await transaction(this.pool, async client => {
      const current = await committeeTemplateById(client, auth.user.id, id, true);
      await client.query('DELETE FROM committee_template_members WHERE committee_template_id=$1', [id]);
      await client.query('DELETE FROM committee_templates WHERE id=$1', [id]);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['ACCOUNT_OWNER'],
        action: 'templates.committee_deleted', resourceType: 'committee_template', resourceId: id,
        before: {revision: current.revision}});
    });
  }

  async listCommittees(auth: AuthenticatedSession): Promise<CommitteeSummary[]> {
    requireBusinessIdentity(auth);
    const result = await this.pool.query<Stage4CommitteeRow>(`SELECT DISTINCT c.* FROM committees c
      LEFT JOIN committee_memberships m ON m.committee_id=c.id AND m.user_id=$1 AND m.status='ACTIVE'
      LEFT JOIN committee_capabilities p ON p.committee_id=c.id AND p.user_id=$1 AND p.capability='CHAIR' AND p.revoked_at IS NULL
      WHERE c.status<>'DELETING' AND (c.owner_user_id=$1 OR m.user_id IS NOT NULL OR p.user_id IS NOT NULL)
      ORDER BY c.updated_at DESC,c.id`, [auth.user.id]);
    return result.rows.map(committeeSummary);
  }

  async createCommittee(auth: AuthenticatedSession, input: Record<string, unknown>, idempotencyKey: string,
    context: Stage4Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['name', 'visibility', 'operationMode', 'activeRulePackageVersionId', 'committeeTemplateId', 'countryTemplateKey']);
    const name = requiredText(input.name, 'Committee name');
    if (!['PUBLIC', 'PRIVATE'].includes(input.visibility as string)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee visibility is invalid.'});
    const operationMode = input.operationMode ?? 'DELEGATE_OPERATED';
    if (!['DELEGATE_OPERATED', 'CHAIR_OPERATED'].includes(operationMode as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee operation mode is invalid.'});
    }
    const committeeTemplateId = input.committeeTemplateId == null ? null : requiredText(input.committeeTemplateId, 'Committee template ID');
    const requestedCountryKey = input.countryTemplateKey == null ? null : requiredText(input.countryTemplateKey, 'Country template key');
    if ((committeeTemplateId === null) === (requestedCountryKey === null)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Choose one committee template or one country template.'});
    }
    return idempotentTransaction({pool: this.pool, auth, route: 'POST /api/v1/committees', key: idempotencyKey,
      request: input, status: 201, work: async client => {
        let versionId = typeof input.activeRulePackageVersionId === 'string' ? input.activeRulePackageVersionId : null;
        if (!versionId) {
          const builtin = await client.query<{id: string}>(`SELECT v.id FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
            WHERE p.stable_key='builtin:quorum-default' AND v.status='PUBLISHED'`);
          versionId = builtin.rows[0]?.id ?? null;
        }
        if (!versionId) throw new AppError({code: 'SERVICE_NOT_READY', message: 'Built-in rules are not installed.'});
        const available = await client.query(`SELECT 1 FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
          WHERE v.id=$1 AND v.status='PUBLISHED' AND p.scope IN ('BUILTIN','SYSTEM')`, [versionId]);
        if (!available.rowCount) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package version is not published.'});
        let template: CommitteeTemplate | null = null;
        if (committeeTemplateId) template = await committeeTemplate(client,
          await committeeTemplateById(client, auth.user.id, committeeTemplateId, true));
        const countryTemplateKey = template?.countryTemplateKey ?? requestedCountryKey as string;
        await resolveCountryTemplateReference(client, auth.user.id, countryTemplateKey);
        const id = randomUUID();
        const inserted = await client.query<Stage4CommitteeRow>(`INSERT INTO committees
          (id,owner_user_id,name,visibility,operation_mode,active_rule_package_version_id,
           source_committee_template_id,country_template_key,temporary_template,next_event_sequence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2) RETURNING *`,
        [id, auth.user.id, name, input.visibility, operationMode, versionId, committeeTemplateId,
          countryTemplateKey, !template]);
        const row = inserted.rows[0] as Stage4CommitteeRow;
        await client.query(`INSERT INTO committee_rule_bindings
          (id,committee_id,package_version_id,effective_from_event_sequence,activated_by_user_id)
          VALUES ($1,$2,$3,1,$4)`, [randomUUID(), id, versionId, auth.user.id]);
        await client.query(`INSERT INTO committee_events
          (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
          VALUES ($1,1,'committee.created','committee',$1,1,$2,'MEMBER')`,
        [id, {sourceCommitteeTemplateId: committeeTemplateId, countryTemplateKey}]);
        if (template) {
          for (const member of template.members) {
            await client.query(`INSERT INTO committee_seats
              (id,committee_id,stable_key,display_name,rank,can_vote,has_veto,must_vote,sort_order,flag_type,flag_value)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [randomUUID(), id, member.stableKey, localizedDisplayName(member.names, member.defaultLanguage, member.defaultLanguage),
              member.rank, member.canVote, member.hasVeto, member.mustVote, member.sortOrder, member.flag.type, member.flag.value]);
          }
        }
        await audit(client, context, {committeeId: id, actorUserId: auth.user.id, capabilities: ['COMMITTEE_OWNER'],
          action: 'committee.created', resourceType: 'committee', resourceId: id,
          after: {name, sourceCommitteeTemplateId: committeeTemplateId, countryTemplateKey, seatCount: template?.members.length ?? 0}});
        return committeeSummary(row);
      }});
  }

  async createSeat(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<Stage4CommitteeSeat> {
    requireBusinessIdentity(auth);
    assertExactBody(input, ['stableKey', 'displayName', 'rank', 'canVote', 'hasVeto', 'mustVote', 'sortOrder', 'flag']);
    const stableKey = requiredText(input.stableKey, 'Seat stable key', 128);
    const displayName = requiredText(input.displayName, 'Seat display name');
    const rank = (input.rank ?? 'STANDARD') as SeatRank;
    const canVote = input.canVote ?? ['STANDARD', 'VETO'].includes(rank);
    const hasVeto = input.hasVeto ?? rank === 'VETO'; const mustVote = input.mustVote ?? false;
    const sortOrder = input.sortOrder ?? 0; const seatFlag = validateFlag(input.flag ?? {type: 'EMOJI', value: '🏳️'});
    if (!['STANDARD', 'VETO', 'NGO', 'OBSERVER'].includes(rank) || typeof canVote !== 'boolean'
      || typeof hasVeto !== 'boolean' || typeof mustVote !== 'boolean' || !Number.isSafeInteger(sortOrder)
      || (hasVeto && !canVote)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat properties are invalid.'});
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/seats`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
        const id = randomUUID();
        const result = await client.query(`INSERT INTO committee_seats
          (id,committee_id,stable_key,display_name,rank,can_vote,has_veto,must_vote,sort_order,flag_type,flag_value)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING id,stable_key AS "stableKey",display_name AS "displayName",rank,can_vote AS "canVote",
            has_veto AS "hasVeto",must_vote AS "mustVote",sort_order AS "sortOrder",active,revision,
            json_build_object('type',flag_type,'value',flag_value) AS flag`,
        [id, committeeId, stableKey, displayName, rank, canVote, hasVeto, mustVote, sortOrder, seatFlag.type, seatFlag.value]);
        await appendEvent(client, row, {type: 'seat.created', resourceType: 'seat', resourceId: id, revision: 1,
          payload: {stableKey, displayName, rank, canVote, hasVeto, mustVote, sortOrder, flagType: seatFlag.type}});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'committee.seat_created', resourceType: 'seat', resourceId: id,
          after: {stableKey, displayName, rank, canVote, hasVeto, mustVote, sortOrder, flagType: seatFlag.type}});
        return result.rows[0] as Stage4CommitteeSeat;
      }});
  }

  async updateSeat(auth: AuthenticatedSession, committeeId: string, seatId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<Stage4CommitteeSeat> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'patch']);
    const baseRevision = positiveRevision(input.baseRevision);
    if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat patch is invalid.'});
    }
    const patch = input.patch as Record<string, unknown>;
    assertExactBody(patch, ['displayName', 'rank', 'canVote', 'hasVeto', 'mustVote', 'sortOrder', 'flag', 'active'], 'Seat patch');
    if (Object.keys(patch).length === 0) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat patch is empty.'});
    return transaction(this.pool, async client => {
      const committee = await lockedCommittee(client, committeeId); await requireChair(client, committee, auth.user.id); requireEditable(committee);
      const found = await client.query<{
        revision: number; display_name: string; rank: SeatRank; can_vote: boolean; has_veto: boolean; must_vote: boolean;
        sort_order: number; flag_type: FlagSnapshot['type']; flag_value: string; active: boolean;
      }>('SELECT * FROM committee_seats WHERE id=$1 AND committee_id=$2 FOR UPDATE', [seatId, committeeId]);
      const current = found.rows[0];
      if (!current) throw new AppError({code: 'NOT_FOUND', message: 'Seat not found.'});
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This seat changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const displayName = patch.displayName === undefined ? current.display_name : requiredText(patch.displayName, 'Seat display name');
      const rank = (patch.rank ?? current.rank) as SeatRank;
      const canVote = patch.canVote ?? current.can_vote; const hasVeto = patch.hasVeto ?? current.has_veto;
      const mustVote = patch.mustVote ?? current.must_vote; const sortOrder = patch.sortOrder ?? current.sort_order;
      const active = patch.active ?? current.active; const seatFlag = patch.flag === undefined
        ? flag(current.flag_type, current.flag_value) : validateFlag(patch.flag);
      if (!['STANDARD', 'VETO', 'NGO', 'OBSERVER'].includes(rank) || typeof canVote !== 'boolean'
        || typeof hasVeto !== 'boolean' || typeof mustVote !== 'boolean' || !Number.isSafeInteger(sortOrder)
        || typeof active !== 'boolean' || (hasVeto && !canVote)) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat properties are invalid.'});
      }
      const result = await client.query(`UPDATE committee_seats SET display_name=$3,rank=$4,can_vote=$5,has_veto=$6,
        must_vote=$7,sort_order=$8,flag_type=$9,flag_value=$10,active=$11,revision=revision+1,updated_at=now()
        WHERE id=$1 AND committee_id=$2 RETURNING id,stable_key AS "stableKey",display_name AS "displayName",rank,
        can_vote AS "canVote",has_veto AS "hasVeto",must_vote AS "mustVote",sort_order AS "sortOrder",active,revision,
        json_build_object('type',flag_type,'value',flag_value) AS flag`,
      [seatId, committeeId, displayName, rank, canVote, hasVeto, mustVote, sortOrder, seatFlag.type, seatFlag.value, active]);
      await appendEvent(client, committee, {type: active ? 'seat.updated' : 'seat.deactivated', resourceType: 'seat',
        resourceId: seatId, revision: baseRevision + 1,
        payload: {displayName, rank, canVote, hasVeto, mustVote, sortOrder, active, flagType: seatFlag.type}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: active ? 'committee.seat_updated' : 'committee.seat_deactivated', resourceType: 'seat', resourceId: seatId,
        before: {revision: current.revision}, after: {revision: current.revision + 1, displayName, rank,
          canVote, hasVeto, mustVote, sortOrder, active, flagType: seatFlag.type}});
      return result.rows[0] as Stage4CommitteeSeat;
    });
  }

  async createNote(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeNote> {
    requireBusinessIdentity(auth); assertExactBody(input, ['title', 'content', 'sortOrder']);
    const title = optionalText(input.title, 'Title', 200); const content = textContent(input.content, 100000);
    const order = sortOrder(input.sortOrder);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/notes`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireEditable(committee);
        const access = await committeeAccess(client, committee, auth.user.id); const id = randomUUID();
        const result = await client.query<NoteRow>(`INSERT INTO committee_notes
          (id,committee_id,title,content,sort_order,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, committeeId, title, content, order, auth.user.id]);
        const summary = {...contentSummary(content), titleCharacterCount: [...title].length, sortOrder: order};
        await appendEvent(client, committee, {type: 'note.created', resourceType: 'note', resourceId: id, revision: 1,
          payload: summary});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: access.capabilities,
          action: 'proceedings.note_created', resourceType: 'note', resourceId: id, after: summary});
        return note(result.rows[0] as NoteRow);
      }});
  }

  async updateNote(auth: AuthenticatedSession, noteId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteeNote> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'patch']);
    const baseRevision = positiveRevision(input.baseRevision); const patch = this.textPatch(input.patch, 100000);
    return transaction(this.pool, async client => {
      const found = await client.query<NoteRow>('SELECT * FROM committee_notes WHERE id=$1 FOR UPDATE', [noteId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Note not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This note changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const title = patch.title ?? current.title; const content = patch.content ?? current.content;
      const order = patch.sortOrder ?? current.sort_order;
      const result = await client.query<NoteRow>(`UPDATE committee_notes SET title=$2,content=$3,sort_order=$4,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [noteId, title, content, order]);
      const before = {...contentSummary(current.content), revision: current.revision};
      const after = {...contentSummary(content), revision: current.revision + 1, titleCharacterCount: [...title].length, sortOrder: order};
      await appendEvent(client, committee, {type: 'note.updated', resourceType: 'note', resourceId: noteId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.note_updated', resourceType: 'note', resourceId: noteId, before, after});
      return note(result.rows[0] as NoteRow);
    });
  }

  async deleteNote(auth: AuthenticatedSession, noteId: string, baseRevision: number,
    context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth); const revision = positiveRevision(baseRevision);
    await transaction(this.pool, async client => {
      const found = await client.query<NoteRow>('SELECT * FROM committee_notes WHERE id=$1 FOR UPDATE', [noteId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Note not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (current.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This note changed since it was loaded.',
        details: {currentRevision: current.revision}});
      await client.query(`UPDATE committee_notes SET title='',content='',revision=revision+1,updated_at=now(),deleted_at=now() WHERE id=$1`, [noteId]);
      const before = {...contentSummary(current.content), revision: current.revision}; const after = {revision: current.revision + 1};
      await appendEvent(client, committee, {type: 'note.deleted', resourceType: 'note', resourceId: noteId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.note_deleted', resourceType: 'note', resourceId: noteId, before, after});
    });
  }

  async createTextPost(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>,
    idempotencyKey: string, context: Stage4Context): Promise<CommitteeTextPost> {
    requireBusinessIdentity(auth); assertExactBody(input, ['title', 'content', 'sortOrder', 'onBehalfOfSeatId']);
    const title = optionalText(input.title, 'Title', 200); const content = textContent(input.content, 20000);
    const order = sortOrder(input.sortOrder);
    return idempotentTransaction({pool: this.pool, auth, route: `POST /api/v1/committees/${committeeId}/text-posts`,
      key: idempotencyKey, request: input, status: 201, work: async client => {
        const committee = await lockedCommittee(client, committeeId); requireEditable(committee);
        const access = await committeeAccess(client, committee, auth.user.id);
        let authorSeatId = access.seatId; let authorDisplayName = auth.user.displayName;
        if (input.onBehalfOfSeatId !== undefined) {
          if (access.audience !== 'CHAIR') throw new AppError({code: 'FORBIDDEN', message: 'Chair capability is required.'});
          authorSeatId = requiredText(input.onBehalfOfSeatId, 'Seat ID');
        }
        if (authorSeatId) {
          const seat = await client.query<{display_name: string}>(`SELECT display_name FROM committee_seats
            WHERE id=$1 AND committee_id=$2 AND active=true`, [authorSeatId, committeeId]);
          if (!seat.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Seat is invalid.'});
          authorDisplayName = seat.rows[0].display_name;
        }
        const id = randomUUID(); const result = await client.query<TextPostRow>(`INSERT INTO committee_text_posts
          (id,committee_id,title,content,sort_order,author_seat_id,author_display_name,actor_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, committeeId, title, content, order, authorSeatId, authorDisplayName, auth.user.id]);
        const summary = {...contentSummary(content), titleCharacterCount: [...title].length, sortOrder: order,
          authorSeatId, actedOnBehalf: Boolean(input.onBehalfOfSeatId)};
        await appendEvent(client, committee, {type: 'text_post.created', resourceType: 'text_post', resourceId: id,
          revision: 1, payload: summary});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: access.capabilities,
          onBehalfOfSeatId: authorSeatId ?? undefined, action: 'proceedings.text_post_created', resourceType: 'text_post',
          resourceId: id, after: summary});
        return textPost(result.rows[0] as TextPostRow);
      }});
  }

  async updateTextPost(auth: AuthenticatedSession, postId: string, input: Record<string, unknown>,
    context: Stage4Context): Promise<CommitteeTextPost> {
    requireBusinessIdentity(auth); assertExactBody(input, ['baseRevision', 'patch']);
    const baseRevision = positiveRevision(input.baseRevision); const patch = this.textPatch(input.patch, 20000);
    return transaction(this.pool, async client => {
      const found = await client.query<TextPostRow>('SELECT * FROM committee_text_posts WHERE id=$1 FOR UPDATE', [postId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Text post not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (access.audience === 'MEMBER' && current.actor_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'You can only edit your own text posts.'});
      }
      if (current.revision !== baseRevision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This text post changed since it was loaded.',
        details: {currentRevision: current.revision}});
      const title = patch.title ?? current.title; const content = patch.content ?? current.content;
      const order = patch.sortOrder ?? current.sort_order;
      const result = await client.query<TextPostRow>(`UPDATE committee_text_posts SET title=$2,content=$3,sort_order=$4,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [postId, title, content, order]);
      const before = {...contentSummary(current.content), revision: current.revision};
      const after = {...contentSummary(content), revision: current.revision + 1, titleCharacterCount: [...title].length, sortOrder: order};
      await appendEvent(client, committee, {type: 'text_post.updated', resourceType: 'text_post', resourceId: postId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.text_post_updated', resourceType: 'text_post', resourceId: postId, before, after});
      return textPost(result.rows[0] as TextPostRow);
    });
  }

  async deleteTextPost(auth: AuthenticatedSession, postId: string, baseRevision: number,
    context: Stage4Context): Promise<void> {
    requireBusinessIdentity(auth); const revision = positiveRevision(baseRevision);
    await transaction(this.pool, async client => {
      const found = await client.query<TextPostRow>('SELECT * FROM committee_text_posts WHERE id=$1 FOR UPDATE', [postId]);
      const current = found.rows[0]; if (!current || current.deleted_at) throw new AppError({code: 'NOT_FOUND', message: 'Text post not found.'});
      const committee = await lockedCommittee(client, current.committee_id); requireEditable(committee);
      const access = await committeeAccess(client, committee, auth.user.id);
      if (access.audience === 'MEMBER' && current.actor_user_id !== auth.user.id) {
        throw new AppError({code: 'FORBIDDEN', message: 'You can only delete your own text posts.'});
      }
      if (current.revision !== revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'This text post changed since it was loaded.',
        details: {currentRevision: current.revision}});
      await client.query(`UPDATE committee_text_posts SET title='',content='',revision=revision+1,updated_at=now(),deleted_at=now() WHERE id=$1`, [postId]);
      const before = {...contentSummary(current.content), revision: current.revision}; const after = {revision: current.revision + 1};
      await appendEvent(client, committee, {type: 'text_post.deleted', resourceType: 'text_post', resourceId: postId,
        revision: current.revision + 1, payload: after});
      await audit(client, context, {committeeId: committee.id, actorUserId: auth.user.id, capabilities: access.capabilities,
        action: 'proceedings.text_post_deleted', resourceType: 'text_post', resourceId: postId, before, after});
    });
  }

  private textPatch(value: unknown, contentLimit: number): {title?: string; content?: string; sortOrder?: number} {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Text resource patch is invalid.'});
    }
    const patch = value as Record<string, unknown>; assertExactBody(patch, ['title', 'content', 'sortOrder'], 'Text resource patch');
    if (Object.keys(patch).length === 0) throw new AppError({code: 'VALIDATION_FAILED', message: 'Text resource patch is empty.'});
    return {title: patch.title === undefined ? undefined : optionalText(patch.title, 'Title', 200),
      content: patch.content === undefined ? undefined : textContent(patch.content, contentLimit),
      sortOrder: patch.sortOrder === undefined ? undefined : sortOrder(patch.sortOrder)};
  }
}

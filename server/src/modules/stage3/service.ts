import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import {
  type CommitteeOperationMode,
  type CommitteeSnapshot,
  type CommitteeSummary,
  type CommitteeVisibility,
  type RulePackageSummary
} from '@quorum/contracts';
import {
  RULE_SCHEMA_VERSION,
  simulateRulePackage,
  validateRulePackage,
  validateRulePackageSet,
  type RulePackageDefinition
} from '@quorum/rule-schema';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';

type Context = {requestId: string; sourceIp?: string; userAgent?: string};
type Audience = 'PUBLIC' | 'MEMBER' | 'CHAIR' | 'OWNER';

interface CommitteeRow extends QueryResultRow {
  id: string; owner_user_id: string; name: string; chair_label: string; topic: string; conference: string;
  visibility: CommitteeVisibility; operation_mode: CommitteeOperationMode;
  status: CommitteeSummary['status']; active_rule_package_version_id: string;
  revision: number; next_event_sequence: string | number;
}

function committee(row: CommitteeRow): CommitteeSummary {
  return {id: row.id, ownerUserId: row.owner_user_id, name: row.name, chairLabel: row.chair_label,
    topic: row.topic, conference: row.conference, visibility: row.visibility, operationMode: row.operation_mode,
    status: row.status, activeRulePackageVersionId: row.active_rule_package_version_id, revision: row.revision};
}

function hashSecret(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function requiredString(value: unknown, name: string, max = 200): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function textField(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function requireBusinessIdentity(auth: AuthenticatedSession): void {
  if (auth.user.mustChangePassword) {
    throw new AppError({code: 'FORBIDDEN', message: 'Change the temporary password first.'});
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if ((error as {code?: string}).code === '23505') {
      throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The requested active assignment or stable key already exists.'});
    }
    if (['23503', '23514', '22P02'].includes((error as {code?: string}).code ?? '')) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'The request contains an invalid reference or value.'});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function audit(client: PoolClient, context: Context, input: {
  committeeId?: string; actorUserId: string; capabilities: string[]; action: string;
  resourceType: string; resourceId?: string; before?: unknown; after?: unknown;
}): Promise<void> {
  await client.query(`INSERT INTO audit_log
    (id, request_id, committee_id, actor_user_id, effective_capabilities, action, resource_type,
     resource_id, result, before_summary, after_summary, user_agent_summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SUCCEEDED',$9,$10,$11)`,
  [randomUUID(), context.requestId, input.committeeId ?? null, input.actorUserId, input.capabilities,
    input.action, input.resourceType, input.resourceId ?? null, input.before ?? null, input.after ?? null,
    context.userAgent?.slice(0, 240) ?? null]);
}

async function appendEvent(client: PoolClient, row: CommitteeRow, input: {
  type: string; resourceType: string; resourceId: string; revision: number; audience?: 'PUBLIC' | 'MEMBER' | 'CHAIR';
  payload?: Record<string, unknown>;
}): Promise<number> {
  const sequence = Number(row.next_event_sequence);
  await client.query('UPDATE committees SET next_event_sequence = next_event_sequence + 1 WHERE id = $1', [row.id]);
  row.next_event_sequence = sequence + 1;
  await client.query(`INSERT INTO committee_events
    (committee_id, sequence, event_type, resource_type, resource_id, resource_revision, payload, audience)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [row.id, sequence, input.type, input.resourceType, input.resourceId, input.revision,
    input.payload ?? {}, input.audience ?? 'MEMBER']);
  return sequence;
}

async function lockedCommittee(client: PoolClient, committeeId: string): Promise<CommitteeRow> {
  const result = await client.query<CommitteeRow>('SELECT * FROM committees WHERE id = $1 FOR UPDATE', [committeeId]);
  const row = result.rows[0];
  if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  return row;
}

function revision(row: CommitteeRow, baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || row.revision !== baseRevision) {
    throw new AppError({code: 'REVISION_CONFLICT', message: 'This committee changed since it was loaded.',
      details: {currentRevision: row.revision}});
  }
}

function requireEditable(row: CommitteeRow): void {
  if (row.status === 'ARCHIVED' || row.status === 'DELETING') {
    throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The committee is read-only.'});
  }
}

async function isChair(client: PoolClient, committeeId: string, userId: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM committee_capabilities c JOIN users u ON u.id=c.user_id
    WHERE c.committee_id=$1 AND c.user_id=$2 AND c.capability='CHAIR' AND c.revoked_at IS NULL
      AND u.is_system_admin=false`, [committeeId, userId]);
  return Boolean(result.rowCount);
}

async function requireChair(client: PoolClient, row: CommitteeRow, userId: string): Promise<void> {
  if (!(await isChair(client, row.id, userId))) {
    throw new AppError({code: 'FORBIDDEN', message: 'Chair capability is required.'});
  }
}

function requireOwner(row: CommitteeRow, userId: string): void {
  if (row.owner_user_id !== userId) throw new AppError({code: 'FORBIDDEN', message: 'Committee owner access is required.'});
}

async function viewerAudience(client: PoolClient, row: CommitteeRow, userId?: string): Promise<{audience: Audience; seatId: string | null}> {
  if (userId === row.owner_user_id) return {audience: 'OWNER', seatId: null};
  if (userId && await isChair(client, row.id, userId)) return {audience: 'CHAIR', seatId: null};
  if (userId) {
    const member = await client.query<{seat_id: string | null}>(`SELECT sa.seat_id
      FROM committee_memberships m
      LEFT JOIN seat_assignments sa ON sa.committee_id=m.committee_id AND sa.user_id=m.user_id AND sa.status='ACTIVE'
      WHERE m.committee_id=$1 AND m.user_id=$2 AND m.status='ACTIVE'`, [row.id, userId]);
    if (member.rows[0]) return {audience: 'MEMBER', seatId: member.rows[0].seat_id};
  }
  if (row.visibility === 'PRIVATE') throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
  return {audience: 'PUBLIC', seatId: null};
}

function setDefinitionPath(definition: RulePackageDefinition, path: string, value: unknown): RulePackageDefinition {
  const parts = path.split('.');
  if (parts.length < 2 || parts.some(part => !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(part))) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule path is invalid.'});
  }
  const copy = structuredClone(definition) as unknown as Record<string, unknown>;
  let cursor = copy;
  for (const part of parts.slice(0, -1)) {
    const child = cursor[part];
    if (!child || typeof child !== 'object' || Array.isArray(child)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule path does not identify a configurable value.'});
    }
    cursor = child as Record<string, unknown>;
  }
  cursor[parts.at(-1) as string] = structuredClone(value);
  return copy as unknown as RulePackageDefinition;
}

export class Stage3Service {
  constructor(private readonly pool: Pool) {}

  private async validateDefinition(definition: unknown): Promise<RulePackageDefinition> {
    const direct = validateRulePackage(definition);
    if (!direct.ok) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package is invalid.', details: {issues: direct.issues}});
    }
    const existing = await this.pool.query<{definition: unknown}>(`SELECT DISTINCT ON (p.stable_key) v.definition
      FROM rule_packages p JOIN rule_package_versions v ON v.package_id=p.id
      WHERE v.status='PUBLISHED' ORDER BY p.stable_key,v.version DESC`);
    const result = validateRulePackageSet([...existing.rows.map(row => row.definition), direct.value]).at(-1);
    if (!result?.ok) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package inheritance is invalid.',
        details: {issues: result?.issues ?? []}});
    }
    return result.value;
  }

  private async accessibleRuleVersion(versionId: string, auth: AuthenticatedSession): Promise<RulePackageDefinition> {
    requireBusinessIdentity(auth);
    const result = await this.pool.query<{definition: RulePackageDefinition; scope: string; committee_id: string | null; status: string}>(
      `SELECT v.definition,v.status,p.scope,p.committee_id FROM rule_package_versions v
       JOIN rule_packages p ON p.id=v.package_id WHERE v.id=$1`, [versionId]);
    const row = result.rows[0];
    if (!row) throw new AppError({code: 'NOT_FOUND', message: 'Rule package version not found.'});
    if (row.scope === 'COMMITTEE') {
      const allowed = await this.pool.query(`SELECT 1 FROM committee_capabilities c JOIN users u ON u.id=c.user_id
        WHERE c.committee_id=$1 AND c.user_id=$2 AND c.capability='CHAIR' AND c.revoked_at IS NULL
          AND u.is_system_admin=false`, [row.committee_id, auth.user.id]);
      if (!allowed.rowCount) throw new AppError({code: 'NOT_FOUND', message: 'Rule package version not found.'});
    } else if (row.scope === 'SYSTEM' && row.status !== 'PUBLISHED' && !auth.user.isSystemAdmin) {
      throw new AppError({code: 'NOT_FOUND', message: 'Rule package version not found.'});
    }
    return row.definition;
  }

  async ensureBuiltins(): Promise<void> {
    const definitions = await Promise.all(['quorum-default.v1.json', 'beijing-academic.v1.json'].map(async name =>
      JSON.parse(await readFile(new URL(`../../../../packages/rule-schema/fixtures/${name}`, import.meta.url), 'utf8')) as RulePackageDefinition));
    await transaction(this.pool, async client => {
      for (const definition of definitions) {
        const validated = validateRulePackage(definition);
        if (!validated.ok) throw new Error(`Invalid built-in rule package: ${definition.key}`);
        const packageId = randomUUID();
        const inserted = await client.query<{id: string}>(`INSERT INTO rule_packages
          (id, scope, stable_key) VALUES ($1,'BUILTIN',$2)
          ON CONFLICT (scope, stable_key) DO UPDATE SET stable_key=EXCLUDED.stable_key RETURNING id`, [packageId, definition.key]);
        await client.query(`INSERT INTO rule_package_versions
          (id, package_id, version, status, definition, schema_version, validation_result, published_at)
          VALUES ($1,$2,1,'PUBLISHED',$3,$4,$5,now()) ON CONFLICT (package_id, version) DO NOTHING`,
        [randomUUID(), inserted.rows[0]?.id, definition, RULE_SCHEMA_VERSION, {valid: true, issues: []}]);
      }
    });
  }

  async createCommittee(auth: AuthenticatedSession, input: {
    name: unknown; visibility: unknown; operationMode?: unknown; activeRulePackageVersionId?: unknown;
  }, context: Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    if (!['PUBLIC', 'PRIVATE'].includes(input.visibility as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee visibility is invalid.'});
    }
    const operationMode = input.operationMode ?? 'DELEGATE_OPERATED';
    if (!['DELEGATE_OPERATED', 'CHAIR_OPERATED'].includes(operationMode as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee operation mode is invalid.'});
    }
    return transaction(this.pool, async client => {
      let versionId = typeof input.activeRulePackageVersionId === 'string' ? input.activeRulePackageVersionId : undefined;
      if (!versionId) {
        const builtin = await client.query<{id: string}>(`SELECT v.id FROM rule_package_versions v
          JOIN rule_packages p ON p.id=v.package_id WHERE p.stable_key='builtin:quorum-default' AND v.status='PUBLISHED'`);
        versionId = builtin.rows[0]?.id;
      }
      if (!versionId) throw new AppError({code: 'SERVICE_NOT_READY', message: 'Built-in rules are not installed.'});
      const available = await client.query(`SELECT 1 FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
        WHERE v.id=$1 AND v.status='PUBLISHED' AND p.scope IN ('BUILTIN','SYSTEM')`, [versionId]);
      if (!available.rowCount) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package version is not published.'});
      const id = randomUUID();
      const inserted = await client.query<CommitteeRow>(`INSERT INTO committees
        (id, owner_user_id, name, visibility, operation_mode, active_rule_package_version_id, next_event_sequence)
        VALUES ($1,$2,$3,$4,$5,$6,2) RETURNING *`,
      [id, auth.user.id, requiredString(input.name, 'Committee name'), input.visibility, operationMode, versionId]);
      const row = inserted.rows[0] as CommitteeRow;
      await client.query(`INSERT INTO committee_rule_bindings
        (id, committee_id, package_version_id, effective_from_event_sequence, activated_by_user_id)
        VALUES ($1,$2,$3,1,$4)`, [randomUUID(), id, versionId, auth.user.id]);
      await client.query(`INSERT INTO committee_events
        (committee_id, sequence, event_type, resource_type, resource_id, resource_revision, payload, audience)
        VALUES ($1,1,'committee.created','committee',$1,1,$2,'MEMBER')`, [id, {created: true}]);
      await audit(client, context, {committeeId: id, actorUserId: auth.user.id, capabilities: ['COMMITTEE_OWNER'],
        action: 'committee.created', resourceType: 'committee', resourceId: id, after: committee(row)});
      return committee(row);
    });
  }

  async snapshot(committeeId: string, auth?: AuthenticatedSession): Promise<CommitteeSnapshot> {
    if (auth) requireBusinessIdentity(auth);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query<CommitteeRow>('SELECT * FROM committees WHERE id=$1', [committeeId]);
      const row = result.rows[0];
      if (!row || row.status === 'DELETING') throw new AppError({code: 'NOT_FOUND', message: 'Committee not found.'});
      const viewer = await viewerAudience(client, row, auth?.user.id);
      const seats = await client.query(`SELECT id, stable_key AS "stableKey", display_name AS "displayName", rank,
        can_vote AS "canVote", has_veto AS "hasVeto", sort_order AS "sortOrder", active, revision
        FROM committee_seats WHERE committee_id=$1 AND active=true ORDER BY sort_order, stable_key`, [committeeId]);
      const visibleCommittee = committee(row);
      if (viewer.audience === 'PUBLIC' || viewer.audience === 'MEMBER') delete visibleCommittee.ownerUserId;
      const snapshot: CommitteeSnapshot = {schemaVersion: 1, committee: visibleCommittee, seats: seats.rows as CommitteeSnapshot['seats'],
        viewer, sync: {committeeEventSequence: Number(row.next_event_sequence) - 1}};
      if (viewer.audience === 'OWNER' || viewer.audience === 'CHAIR') {
        const [memberships, chairs, assignments] = await Promise.all([
          client.query(`SELECT user_id AS "userId", status FROM committee_memberships WHERE committee_id=$1`, [committeeId]),
          client.query(`SELECT user_id AS "userId" FROM committee_capabilities
            WHERE committee_id=$1 AND capability='CHAIR' AND revoked_at IS NULL`, [committeeId]),
          client.query(`SELECT id, seat_id AS "seatId", user_id AS "userId", status FROM seat_assignments WHERE committee_id=$1`, [committeeId])
        ]);
        snapshot.memberships = memberships.rows as CommitteeSnapshot['memberships'];
        snapshot.chairs = chairs.rows as CommitteeSnapshot['chairs'];
        snapshot.assignments = assignments.rows as CommitteeSnapshot['assignments'];
      } else if (viewer.audience === 'MEMBER' && auth) {
        const [membership, assignment] = await Promise.all([
          client.query(`SELECT user_id AS "userId", status FROM committee_memberships WHERE committee_id=$1 AND user_id=$2`, [committeeId, auth.user.id]),
          client.query(`SELECT id, seat_id AS "seatId", user_id AS "userId", status FROM seat_assignments
            WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [committeeId, auth.user.id])
        ]);
        snapshot.memberships = membership.rows as CommitteeSnapshot['memberships'];
        snapshot.assignments = assignment.rows as CommitteeSnapshot['assignments'];
      }
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async updateCommittee(auth: AuthenticatedSession, committeeId: string, baseRevision: number,
    patch: Record<string, unknown>, context: Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    const allowed = new Set(['name', 'chairLabel', 'topic', 'conference', 'visibility']);
    if (Object.keys(patch).some(key => !allowed.has(key))) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee patch contains an unsupported field.'});
    }
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); requireOwner(row, auth.user.id); requireEditable(row); revision(row, baseRevision);
      const next = {
        name: patch.name === undefined ? row.name : requiredString(patch.name, 'Committee name'),
        chairLabel: patch.chairLabel === undefined ? row.chair_label : textField(patch.chairLabel, 'Chair label', 200),
        topic: patch.topic === undefined ? row.topic : textField(patch.topic, 'Committee topic', 500),
        conference: patch.conference === undefined ? row.conference : textField(patch.conference, 'Conference name', 200),
        visibility: patch.visibility === undefined ? row.visibility : patch.visibility
      };
      if (!['PUBLIC', 'PRIVATE'].includes(next.visibility as string)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee visibility is invalid.'});
      const updated = await client.query<CommitteeRow>(`UPDATE committees SET name=$2,chair_label=$3,topic=$4,conference=$5,
        visibility=$6,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
      [committeeId, next.name, next.chairLabel, next.topic, next.conference, next.visibility]);
      const changed = updated.rows[0] as CommitteeRow;
      await appendEvent(client, changed, {type: 'committee.updated', resourceType: 'committee', resourceId: committeeId,
        revision: changed.revision, payload: {revision: changed.revision}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['COMMITTEE_OWNER'],
        action: 'committee.updated', resourceType: 'committee', resourceId: committeeId, before: committee(row), after: committee(changed)});
      return committee(changed);
    });
  }

  async archiveCommittee(auth: AuthenticatedSession, committeeId: string, baseRevision: number, context: Context): Promise<CommitteeSummary> {
    return this.setOwnerStatus(auth, committeeId, baseRevision, 'ARCHIVED', 'committee.archived', context);
  }

  async deleteCommittee(auth: AuthenticatedSession, committeeId: string, baseRevision: number, context: Context): Promise<CommitteeSummary> {
    return this.setOwnerStatus(auth, committeeId, baseRevision, 'DELETING', 'committee.deletion_started', context);
  }

  private async setOwnerStatus(auth: AuthenticatedSession, committeeId: string, baseRevision: number,
    status: 'ARCHIVED' | 'DELETING', action: 'committee.archived' | 'committee.deletion_started', context: Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); requireOwner(row, auth.user.id);
      if (status === 'ARCHIVED') requireEditable(row);
      if (status === 'DELETING' && row.status === 'DELETING') {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'Committee deletion has already started.'});
      }
      revision(row, baseRevision);
      const updated = await client.query<CommitteeRow>(`UPDATE committees SET status=$2,revision=revision+1,updated_at=now(),
        archived_at=CASE WHEN $2='ARCHIVED' THEN now() ELSE archived_at END WHERE id=$1 RETURNING *`, [committeeId, status]);
      const changed = updated.rows[0] as CommitteeRow;
      await appendEvent(client, changed, {type: status === 'ARCHIVED' ? 'committee.archived' : 'committee.deletion_started',
        resourceType: 'committee', resourceId: committeeId, revision: changed.revision, payload: {status}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['COMMITTEE_OWNER'], action,
        resourceType: 'committee', resourceId: committeeId, before: {status: row.status}, after: {status}});
      return committee(changed);
    });
  }

  async setChair(auth: AuthenticatedSession, committeeId: string, userId: string, grant: boolean,
    baseRevision: number, context: Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); requireOwner(row, auth.user.id); requireEditable(row); revision(row, baseRevision);
      const user = await client.query<{is_system_admin: boolean}>(`SELECT is_system_admin FROM users WHERE id=$1 AND status='ACTIVE'`, [userId]);
      if (!user.rowCount) throw new AppError({code: 'NOT_FOUND', message: 'User not found.'});
      if (grant && user.rows[0]?.is_system_admin) {
        throw new AppError({code: 'FORBIDDEN', message: 'The system administrator cannot receive Chair capability.'});
      }
      if (grant) await client.query(`INSERT INTO committee_capabilities
        (committee_id,user_id,capability,granted_by_user_id) VALUES ($1,$2,'CHAIR',$3)
        ON CONFLICT (committee_id,user_id,capability) DO UPDATE SET granted_by_user_id=EXCLUDED.granted_by_user_id,
        granted_at=now(),revoked_at=NULL`, [committeeId, userId, auth.user.id]);
      else await client.query(`UPDATE committee_capabilities SET revoked_at=now()
        WHERE committee_id=$1 AND user_id=$2 AND capability='CHAIR' AND revoked_at IS NULL`, [committeeId, userId]);
      const updated = await client.query<CommitteeRow>('UPDATE committees SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *', [committeeId]);
      const changed = updated.rows[0] as CommitteeRow;
      await appendEvent(client, changed, {type: grant ? 'committee.chair_granted' : 'committee.chair_revoked', resourceType: 'committee', resourceId: committeeId,
        revision: changed.revision, audience: 'MEMBER', payload: {chairUserId: userId, granted: grant}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['COMMITTEE_OWNER'],
        action: grant ? 'committee.chair_granted' : 'committee.chair_revoked', resourceType: 'committee_capability', resourceId: userId});
      return committee(changed);
    });
  }

  async setOperationMode(auth: AuthenticatedSession, committeeId: string, mode: unknown, baseRevision: number,
    context: Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    if (!['DELEGATE_OPERATED', 'CHAIR_OPERATED'].includes(mode as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee operation mode is invalid.'});
    }
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row); revision(row, baseRevision);
      const updated = await client.query<CommitteeRow>(`UPDATE committees SET operation_mode=$2,revision=revision+1,
        updated_at=now() WHERE id=$1 RETURNING *`, [committeeId, mode]);
      const changed = updated.rows[0] as CommitteeRow;
      await appendEvent(client, changed, {type: 'operation_mode.changed', resourceType: 'committee', resourceId: committeeId,
        revision: changed.revision, payload: {operationMode: mode as string}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'committee.operation_mode_changed', resourceType: 'committee', resourceId: committeeId,
        before: {operationMode: row.operation_mode}, after: {operationMode: mode}});
      return committee(changed);
    });
  }

  async setCommitteeStatus(auth: AuthenticatedSession, committeeId: string, status: unknown, baseRevision: number,
    context: Context): Promise<CommitteeSummary> {
    requireBusinessIdentity(auth);
    if (!['ACTIVE', 'PAUSED'].includes(status as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Committee status is invalid.'});
    }
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id);
      requireEditable(row); revision(row, baseRevision);
      const updated = await client.query<CommitteeRow>(`UPDATE committees SET status=$2,revision=revision+1,
        updated_at=now() WHERE id=$1 RETURNING *`, [committeeId, status]);
      const changed = updated.rows[0] as CommitteeRow;
      await appendEvent(client, changed, {type: 'committee.status_changed', resourceType: 'committee', resourceId: committeeId,
        revision: changed.revision, payload: {status: status as string}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'committee.status_changed', resourceType: 'committee', resourceId: committeeId,
        before: {status: row.status}, after: {status}});
      return committee(changed);
    });
  }

  async createSeat(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, context: Context) {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
      const id = randomUUID();
      const result = await client.query(`INSERT INTO committee_seats
        (id,committee_id,stable_key,display_name,rank,can_vote,has_veto,sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,stable_key AS "stableKey",display_name AS "displayName",rank,
        can_vote AS "canVote",has_veto AS "hasVeto",sort_order AS "sortOrder",active,revision`,
      [id, committeeId, requiredString(input.stableKey, 'Seat stable key', 128), requiredString(input.displayName, 'Seat name'),
        typeof input.rank === 'string' ? input.rank.slice(0, 80) : null, input.canVote !== false, input.hasVeto === true,
        Number.isSafeInteger(input.sortOrder) ? input.sortOrder : 0]);
      await appendEvent(client, row, {type: 'seat.created', resourceType: 'seat', resourceId: id, revision: 1,
        payload: {seatId: id}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'committee.seat_created', resourceType: 'seat', resourceId: id, after: result.rows[0]});
      return result.rows[0];
    });
  }

  async assignSeat(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, context: Context) {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
      if (input.action === 'END') {
        const assignmentId = requiredString(input.assignmentId, 'Assignment ID');
        const ended = await client.query(`UPDATE seat_assignments SET status='ENDED',ended_at=now()
          WHERE id=$1 AND committee_id=$2 AND status='ACTIVE' RETURNING id,seat_id AS "seatId",user_id AS "userId",status`,
        [assignmentId, committeeId]);
        if (!ended.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Active seat assignment not found.'});
        await appendEvent(client, row, {type: 'seat.assignment_ended', resourceType: 'seat_assignment', resourceId: assignmentId,
          revision: 1, payload: {ended: true}});
        await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
          action: 'committee.seat_assignment_ended', resourceType: 'seat_assignment', resourceId: assignmentId});
        return ended.rows[0];
      }
      const seatId = requiredString(input.seatId, 'Seat ID'); const userId = requiredString(input.userId, 'User ID');
      const id = randomUUID();
      const inserted = await client.query(`INSERT INTO seat_assignments
        (id,committee_id,seat_id,user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4,$5)
        RETURNING id,seat_id AS "seatId",user_id AS "userId",status`, [id, committeeId, seatId, userId, auth.user.id]);
      await client.query(`INSERT INTO committee_memberships (committee_id,user_id,status)
        VALUES ($1,$2,'ACTIVE') ON CONFLICT (committee_id,user_id) DO UPDATE SET status='ACTIVE',updated_at=now()`, [committeeId, userId]);
      await appendEvent(client, row, {type: 'seat.assignment_started', resourceType: 'seat_assignment', resourceId: id,
        revision: 1, audience: 'MEMBER', payload: {seatId}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'committee.seat_assigned', resourceType: 'seat_assignment', resourceId: id, after: {seatId, userId}});
      return inserted.rows[0];
    });
  }

  async createInvitation(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, context: Context) {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
      const seatId = requiredString(input.seatId, 'Seat ID');
      const maxUses = Number(input.maxUses ?? 1); const expiresAt = new Date(String(input.expiresAt));
      if (!Number.isSafeInteger(maxUses) || maxUses < 1 || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
        throw new AppError({code: 'VALIDATION_FAILED', message: 'Invitation expiry or use limit is invalid.'});
      }
      const code = `${randomUUID()}${randomUUID()}`.replaceAll('-', ''); const id = randomUUID();
      await client.query(`INSERT INTO seat_invitations
        (id,committee_id,seat_id,code_hash,max_uses,expires_at,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, committeeId, seatId, hashSecret(code), maxUses, expiresAt, auth.user.id]);
      await appendEvent(client, row, {type: 'seat.invitation_created', resourceType: 'seat_invitation', resourceId: id,
        revision: 1, audience: 'CHAIR', payload: {invitationId: id}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'committee.seat_invitation_created', resourceType: 'seat_invitation', resourceId: id,
        after: {seatId, maxUses, expiresAt: expiresAt.toISOString()}});
      return {id, code, seatId, maxUses, expiresAt: expiresAt.toISOString()};
    });
  }

  async redeemInvitation(auth: AuthenticatedSession, code: unknown, context: Context) {
    requireBusinessIdentity(auth);
    const invitationCode = requiredString(code, 'Invitation code', 256);
    return transaction(this.pool, async client => {
      const invitation = await client.query<{id: string; committee_id: string; seat_id: string; use_count: number; max_uses: number}>(
        `SELECT id,committee_id,seat_id,use_count,max_uses FROM seat_invitations
         WHERE code_hash=$1 AND revoked_at IS NULL AND expires_at>now() AND use_count<max_uses FOR UPDATE`, [hashSecret(invitationCode)]);
      const found = invitation.rows[0];
      if (!found) throw new AppError({code: 'LINK_EXPIRED', message: 'Invitation is invalid or no longer available.'});
      const row = await lockedCommittee(client, found.committee_id);
      requireEditable(row);
      const existing = await client.query<{id: string; seat_id: string}>(`SELECT id,seat_id FROM seat_assignments
        WHERE committee_id=$1 AND user_id=$2 AND status='ACTIVE'`, [found.committee_id, auth.user.id]);
      if (existing.rows[0] && existing.rows[0].seat_id !== found.seat_id) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'This account already has an active seat in the committee.'});
      }
      await client.query(`INSERT INTO committee_memberships (committee_id,user_id,status)
        VALUES ($1,$2,'ACTIVE') ON CONFLICT (committee_id,user_id) DO UPDATE SET status='ACTIVE',updated_at=now()`,
      [found.committee_id, auth.user.id]);
      let assignmentId = existing.rows[0]?.id;
      if (!assignmentId) {
        assignmentId = randomUUID();
        await client.query(`INSERT INTO seat_assignments
          (id,committee_id,seat_id,user_id,assigned_by_user_id) VALUES ($1,$2,$3,$4,$4)`,
        [assignmentId, found.committee_id, found.seat_id, auth.user.id]);
        await client.query('UPDATE seat_invitations SET use_count=use_count+1 WHERE id=$1', [found.id]);
      }
      await appendEvent(client, row, {type: 'seat.invitation_redeemed', resourceType: 'seat_assignment', resourceId: assignmentId,
        revision: 1, audience: 'MEMBER', payload: {seatId: found.seat_id}});
      await audit(client, context, {committeeId: found.committee_id, actorUserId: auth.user.id, capabilities: ['MEMBER'],
        action: 'committee.seat_invitation_redeemed', resourceType: 'seat_assignment', resourceId: assignmentId,
        after: {seatId: found.seat_id}});
      return {committeeId: found.committee_id, seatId: found.seat_id, assignmentId};
    });
  }

  async revokeInvitation(auth: AuthenticatedSession, committeeId: string, invitationId: string, context: Context): Promise<void> {
    requireBusinessIdentity(auth);
    await transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
      const result = await client.query('UPDATE seat_invitations SET revoked_at=now() WHERE id=$1 AND committee_id=$2 AND revoked_at IS NULL',
        [invitationId, committeeId]);
      if (!result.rowCount) throw new AppError({code: 'NOT_FOUND', message: 'Invitation not found.'});
      await appendEvent(client, row, {type: 'seat.invitation_revoked', resourceType: 'seat_invitation', resourceId: invitationId,
        revision: 1, audience: 'CHAIR', payload: {revoked: true}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'committee.seat_invitation_revoked', resourceType: 'seat_invitation', resourceId: invitationId});
    });
  }

  async listRulePackages(auth?: AuthenticatedSession): Promise<RulePackageSummary[]> {
    if (auth) requireBusinessIdentity(auth);
    const result = await this.pool.query(`SELECT p.id,p.scope,p.stable_key AS key,p.committee_id AS "committeeId",
      json_agg(json_build_object('id',v.id,'version',v.version,'status',v.status,'schemaVersion',v.schema_version,
        'publishedAt',v.published_at) ORDER BY v.version) AS versions
      FROM rule_packages p JOIN rule_package_versions v ON v.package_id=p.id
      WHERE (p.scope IN ('BUILTIN','SYSTEM') OR ($1::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM committee_capabilities c JOIN users u ON u.id=c.user_id
        WHERE c.committee_id=p.committee_id AND c.user_id=$1 AND c.revoked_at IS NULL AND u.is_system_admin=false)))
        AND (v.status='PUBLISHED' OR (p.scope='SYSTEM' AND $2::boolean=true) OR (p.scope='COMMITTEE' AND EXISTS (
          SELECT 1 FROM committee_capabilities c JOIN users u ON u.id=c.user_id
          WHERE c.committee_id=p.committee_id AND c.user_id=$1 AND c.revoked_at IS NULL AND u.is_system_admin=false)))
      GROUP BY p.id ORDER BY p.scope,p.stable_key`, [auth?.user.id ?? null, auth?.user.isSystemAdmin ?? false]);
    return result.rows as RulePackageSummary[];
  }

  async importRulePackage(auth: AuthenticatedSession, input: Record<string, unknown>, context: Context,
    auditAction: 'rules.package_imported' | 'rules.package_cloned' = 'rules.package_imported'): Promise<RulePackageSummary> {
    requireBusinessIdentity(auth);
    const scope = input.scope; const definition = input.definition;
    const validated = await this.validateDefinition(definition);
    if (scope === 'SYSTEM' && !auth.user.isSystemAdmin) throw new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
    if (!['SYSTEM', 'COMMITTEE'].includes(scope as string)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package scope is invalid.'});
    const committeeId = scope === 'COMMITTEE' ? requiredString(input.committeeId, 'Committee ID') : null;
    return transaction(this.pool, async client => {
      if (committeeId) {const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);}
      const packageId = randomUUID(); const versionId = randomUUID();
      await client.query(`INSERT INTO rule_packages (id,scope,owner_user_id,committee_id,stable_key)
        VALUES ($1,$2,$3,$4,$5)`, [packageId, scope, auth.user.id, committeeId, validated.key]);
      await client.query(`INSERT INTO rule_package_versions
        (id,package_id,version,status,definition,schema_version,validation_result,created_by_user_id,published_at)
        VALUES ($1,$2,1,'PUBLISHED',$3,$4,$5,$6,now())`,
      [versionId, packageId, validated, RULE_SCHEMA_VERSION, {valid: true, issues: []}, auth.user.id]);
      if (committeeId) {
        const row = await lockedCommittee(client, committeeId);
        await appendEvent(client, row, {type: 'rule_package.version_created', resourceType: 'rule_package_version',
          resourceId: versionId, revision: 1, audience: 'CHAIR', payload: {packageId, version: 1}});
      }
      await audit(client, context, {committeeId: committeeId ?? undefined, actorUserId: auth.user.id,
        capabilities: scope === 'SYSTEM' ? ['SYSTEM_ADMIN'] : ['CHAIR'], action: auditAction,
        resourceType: 'rule_package', resourceId: packageId, after: {scope, key: validated.key}});
      return {id: packageId, scope: scope as 'SYSTEM' | 'COMMITTEE', key: validated.key, committeeId,
        versions: [{id: versionId, version: 1, status: 'PUBLISHED', schemaVersion: RULE_SCHEMA_VERSION,
          publishedAt: new Date().toISOString()}]};
    });
  }

  async cloneRulePackage(auth: AuthenticatedSession, packageId: string, input: Record<string, unknown>, context: Context) {
    requireBusinessIdentity(auth);
    const source = await this.pool.query<{id: string}>(`SELECT v.id FROM rule_package_versions v
      WHERE v.package_id=$1 AND v.status='PUBLISHED' ORDER BY v.version DESC LIMIT 1`, [packageId]);
    if (!source.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Rule package not found.'});
    const definition = structuredClone(await this.accessibleRuleVersion(source.rows[0].id, auth));
    definition.key = requiredString(input.key, 'Rule package key', 128);
    return this.importRulePackage(auth, {...input, definition}, context, 'rules.package_cloned');
  }

  async createRuleVersion(auth: AuthenticatedSession, packageId: string, input: Record<string, unknown>, context: Context) {
    requireBusinessIdentity(auth);
    const validated = await this.validateDefinition(input.definition);
    const status = input.publish === true ? 'PUBLISHED' : 'DRAFT';
    return transaction(this.pool, async client => {
      const pkg = await client.query<{scope: string; committee_id: string | null}>(`SELECT scope,committee_id FROM rule_packages WHERE id=$1 FOR UPDATE`, [packageId]);
      const found = pkg.rows[0]; if (!found) throw new AppError({code: 'NOT_FOUND', message: 'Rule package not found.'});
      if (found.scope === 'BUILTIN') throw new AppError({code: 'FORBIDDEN', message: 'Built-in rule packages cannot be modified.'});
      if (found.scope === 'SYSTEM') {
        if (!auth.user.isSystemAdmin) throw new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
      } else {const row = await lockedCommittee(client, found.committee_id as string); await requireChair(client, row, auth.user.id); requireEditable(row);}
      const next = await client.query<{version: number}>('SELECT coalesce(max(version),0)+1 AS version FROM rule_package_versions WHERE package_id=$1', [packageId]);
      const id = randomUUID(); const version = Number(next.rows[0]?.version);
      await client.query(`INSERT INTO rule_package_versions
        (id,package_id,version,status,definition,schema_version,validation_result,created_by_user_id,published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4='PUBLISHED' THEN now() ELSE NULL END)`,
      [id, packageId, version, status, validated, RULE_SCHEMA_VERSION, {valid: true, issues: []}, auth.user.id]);
      if (found.committee_id) {
        const row = await lockedCommittee(client, found.committee_id);
        await appendEvent(client, row, {type: 'rule_package.version_created', resourceType: 'rule_package_version',
          resourceId: id, revision: version, audience: 'CHAIR', payload: {packageId, version, status}});
      }
      await audit(client, context, {committeeId: found.committee_id ?? undefined, actorUserId: auth.user.id,
        capabilities: found.scope === 'SYSTEM' ? ['SYSTEM_ADMIN'] : ['CHAIR'], action: 'rules.version_created',
        resourceType: 'rule_package_version', resourceId: id, after: {packageId, version, status}});
      return {id, version, status, schemaVersion: RULE_SCHEMA_VERSION, publishedAt: status === 'PUBLISHED' ? new Date().toISOString() : null};
    });
  }

  async validateRuleVersion(auth: AuthenticatedSession, versionId: string) {
    const result = validateRulePackage(await this.accessibleRuleVersion(versionId, auth));
    return {valid: result.ok, issues: result.ok ? [] : result.issues};
  }

  async simulateRuleVersion(auth: AuthenticatedSession, versionId: string, facts: unknown) {
    if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new AppError({code: 'VALIDATION_FAILED', message: 'Simulation facts are invalid.'});
    const definition = await this.accessibleRuleVersion(versionId, auth);
    try { return simulateRulePackage(definition, facts as Record<string, unknown>); }
    catch (error) { throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule simulation failed.', details: {reason: String((error as Error).message)}}); }
  }

  async activateRules(auth: AuthenticatedSession, committeeId: string, versionId: string, baseRevision: number, context: Context) {
    requireBusinessIdentity(auth);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row); revision(row, baseRevision);
      const version = await client.query<{definition: unknown; scope: string; committee_id: string | null}>(`SELECT v.definition,p.scope,p.committee_id
        FROM rule_package_versions v JOIN rule_packages p ON p.id=v.package_id
        WHERE v.id=$1 AND v.status='PUBLISHED'`, [versionId]);
      if (!version.rows[0]) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package version is not published.'});
      if (version.rows[0].scope === 'COMMITTEE' && version.rows[0].committee_id !== committeeId) {
        throw new AppError({code: 'NOT_FOUND', message: 'Rule package version not found.'});
      }
      const validated = validateRulePackage(version.rows[0].definition);
      if (!validated.ok) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule package version is invalid.', details: {issues: validated.issues}});
      const updated = await client.query<CommitteeRow>(`UPDATE committees SET active_rule_package_version_id=$2,
        revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [committeeId, versionId]);
      const changed = updated.rows[0] as CommitteeRow;
      const sequence = await appendEvent(client, changed, {type: 'rule_package.activated', resourceType: 'rule_package_version',
        resourceId: versionId, revision: changed.revision, payload: {versionId}});
      await client.query(`INSERT INTO committee_rule_bindings
        (id,committee_id,package_version_id,effective_from_event_sequence,activated_by_user_id) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), committeeId, versionId, sequence, auth.user.id]);
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'rules.package_activated', resourceType: 'rule_package_version', resourceId: versionId,
        before: {versionId: row.active_rule_package_version_id}, after: {versionId}});
      return committee(changed);
    });
  }

  async overrideRule(auth: AuthenticatedSession, committeeId: string, input: Record<string, unknown>, context: Context) {
    requireBusinessIdentity(auth);
    const scope = input.scope; if (!['ONCE', 'FUTURE'].includes(scope as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule override scope is invalid.'});
    }
    const path = requiredString(input.path, 'Rule path', 200);
    return transaction(this.pool, async client => {
      const row = await lockedCommittee(client, committeeId); await requireChair(client, row, auth.user.id); requireEditable(row);
      const active = await client.query<{definition: RulePackageDefinition}>(
        'SELECT definition FROM rule_package_versions WHERE id=$1', [row.active_rule_package_version_id]);
      if (!active.rows[0]) throw new AppError({code: 'SERVICE_NOT_READY', message: 'Active rules are unavailable.'});
      let createdVersionId: string | null = null;
      if (scope === 'FUTURE') {
        const definition = setDefinitionPath(active.rows[0].definition, path, input.value);
        definition.key = `committee:${committeeId}:rules`;
        const valid = validateRulePackage(definition);
        if (!valid.ok) throw new AppError({code: 'VALIDATION_FAILED', message: 'Rule override creates an invalid package.', details: {issues: valid.issues}});
        const packageResult = await client.query<{id: string}>(`INSERT INTO rule_packages
          (id,scope,owner_user_id,committee_id,stable_key) VALUES ($1,'COMMITTEE',$2,$3,$4)
          ON CONFLICT (scope,stable_key) DO UPDATE SET updated_at=now() RETURNING id`,
        [randomUUID(), auth.user.id, committeeId, definition.key]);
        const packageId = packageResult.rows[0]?.id as string;
        const next = await client.query<{version: number}>('SELECT coalesce(max(version),0)+1 AS version FROM rule_package_versions WHERE package_id=$1', [packageId]);
        createdVersionId = randomUUID();
        await client.query(`INSERT INTO rule_package_versions
          (id,package_id,version,status,definition,schema_version,validation_result,created_by_user_id,published_at)
          VALUES ($1,$2,$3,'PUBLISHED',$4,$5,$6,$7,now())`,
        [createdVersionId, packageId, next.rows[0]?.version, definition, RULE_SCHEMA_VERSION, {valid: true, issues: []}, auth.user.id]);
      }
      const id = randomUUID();
      await client.query(`INSERT INTO chair_rule_overrides
        (id,committee_id,actor_user_id,scope,stable_rule_id,value,operation_key,source_package_version_id,created_package_version_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, committeeId, auth.user.id, scope, path, input.value, scope === 'ONCE' ? requiredString(input.operationKey, 'Operation key', 200) : null,
        row.active_rule_package_version_id, createdVersionId]);
      await appendEvent(client, row, {type: 'rule_override.created', resourceType: 'chair_rule_override', resourceId: id,
        revision: 1, audience: 'CHAIR', payload: {scope, path, createdVersionId}});
      await audit(client, context, {committeeId, actorUserId: auth.user.id, capabilities: ['CHAIR'],
        action: 'rules.chair_override_applied', resourceType: 'chair_rule_override', resourceId: id,
        after: {scope, path, createdVersionId}});
      return {id, scope, path, createdVersionId};
    });
  }
}

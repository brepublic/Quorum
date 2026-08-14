import {randomUUID, timingSafeEqual} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {AppError} from '../../http/errors.js';
import {createOpaqueToken, hashOpaqueToken} from './tokens.js';
import type {
  AuditContext,
  AuthenticatedSession,
  IdentityStore,
  IdentityUser,
  LoginRecord,
  NewSession
} from './store.js';

interface UserRow {
  id: string;
  email: string | null;
  display_name: string;
  status: IdentityUser['status'];
  is_system_admin: boolean;
  session_version: number;
  must_change_password: boolean;
  created_at: Date;
  disabled_at: Date | null;
}

interface LoginRow extends UserRow {
  password_hash: string;
  failed_attempts: number;
  locked_until: Date | null;
}

function userFromRow(row: UserRow): IdentityUser {
  return {
    id: row.id,
    email: row.email ?? '',
    displayName: row.display_name,
    status: row.status,
    isSystemAdmin: row.is_system_admin,
    sessionVersion: row.session_version,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at.toISOString(),
    disabledAt: row.disabled_at?.toISOString() ?? null
  };
}

function secretMatches(expected: Buffer, supplied: Buffer): boolean {
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function insertSession(client: PoolClient, userId: string, sessionVersion: number, session: NewSession): Promise<void> {
  await client.query(
    `INSERT INTO sessions
      (id, user_id, token_hash, session_version, expires_at, ip_hash, user_agent_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [session.id, userId, session.tokenHash, sessionVersion, session.expiresAt, session.ipHash, session.userAgentSummary]
  );
}

async function audit(client: PoolClient, context: AuditContext, input: {
  actorUserId?: string;
  action: string;
  targetUserId?: string;
  result?: 'SUCCEEDED' | 'DENIED' | 'FAILED';
}): Promise<void> {
  await client.query(
    `INSERT INTO identity_audit_log
      (id, request_id, actor_user_id, action, target_user_id, result, source_ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), context.requestId, input.actorUserId ?? null, input.action, input.targetUserId ?? null,
      input.result ?? 'SUCCEEDED', context.sourceIpHash]
  );
}

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async bootstrapStatus(): Promise<boolean> {
    const result = await this.pool.query<{initialized: boolean}>(
      'SELECT initialized_at IS NOT NULL AS initialized FROM system_settings WHERE singleton = true'
    );
    return result.rows[0]?.initialized ?? false;
  }

  async ensureBootstrapSecret(): Promise<string | null> {
    return this.transaction(async client => {
      const result = await client.query<{initialized_at: Date | null; bootstrap_secret_hash: Buffer | null}>(
        'SELECT initialized_at, bootstrap_secret_hash FROM system_settings WHERE singleton = true FOR UPDATE'
      );
      const settings = result.rows[0];
      if (!settings) throw new Error('system_settings singleton is missing');
      if (settings.initialized_at || settings.bootstrap_secret_hash) return null;

      const secret = createOpaqueToken();
      await client.query(
        'UPDATE system_settings SET bootstrap_secret_hash = $1 WHERE singleton = true',
        [hashOpaqueToken(secret)]
      );
      return secret;
    });
  }

  async bootstrapAdmin(input: Parameters<IdentityStore['bootstrapAdmin']>[0]): Promise<IdentityUser> {
    return this.transaction(async client => {
      const result = await client.query<{initialized_at: Date | null; bootstrap_secret_hash: Buffer | null}>(
        'SELECT initialized_at, bootstrap_secret_hash FROM system_settings WHERE singleton = true FOR UPDATE'
      );
      const settings = result.rows[0];
      if (!settings) throw new Error('system_settings singleton is missing');
      if (settings.initialized_at) {
        throw new AppError({code: 'RESOURCE_CONFLICT', message: 'The instance is already initialized.'});
      }
      if (!settings.bootstrap_secret_hash || !secretMatches(settings.bootstrap_secret_hash, input.secretHash)) {
        throw new AppError({code: 'FORBIDDEN', message: 'Initialization credentials are invalid.'});
      }

      const inserted = await client.query<UserRow>(
        `INSERT INTO users (id, email, display_name, is_system_admin, must_change_password)
         VALUES ($1, $2, $3, true, false)
         RETURNING *`,
        [input.id, input.email, input.displayName]
      );
      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash, password_changed_at)
         VALUES ($1, $2, now())`,
        [input.id, input.passwordHash]
      );
      await insertSession(client, input.id, 1, input.session);
      await client.query(
        `UPDATE system_settings
         SET initialized_at = now(), bootstrap_secret_hash = NULL
         WHERE singleton = true`,
      );
      await audit(client, input.audit, {
        actorUserId: input.id,
        action: 'system.bootstrap_admin_created',
        targetUserId: input.id
      });
      return userFromRow(inserted.rows[0] as UserRow);
    });
  }

  async findLogin(email: string): Promise<LoginRecord | null> {
    const result = await this.pool.query<LoginRow>(
      `SELECT u.*, c.password_hash, c.failed_attempts, c.locked_until
       FROM users u JOIN user_credentials c ON c.user_id = u.id
       WHERE u.email = $1`,
      [email]
    );
    const row = result.rows[0];
    return row ? {...userFromRow(row), passwordHash: row.password_hash, failedAttempts: row.failed_attempts,
      lockedUntil: row.locked_until} : null;
  }

  async recordLoginFailure(userId: string, now: Date, lockAfterAttempts: number, lockMs: number,
    context: AuditContext): Promise<void> {
    await this.transaction(async client => {
      await client.query(
        `UPDATE user_credentials
         SET failed_attempts = failed_attempts + 1,
             locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3 ELSE locked_until END
         WHERE user_id = $1`,
        [userId, lockAfterAttempts, new Date(now.getTime() + lockMs)]
      );
      await audit(client, context, {action: 'identity.login_failed', targetUserId: userId, result: 'DENIED'});
    });
  }

  async completeLogin(input: Parameters<IdentityStore['completeLogin']>[0]): Promise<IdentityUser> {
    return this.transaction(async client => {
      const locked = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.user.id]);
      const row = locked.rows[0];
      if (!row || row.status !== 'ACTIVE') {
        throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Email or password is incorrect.'});
      }
      await client.query('UPDATE user_credentials SET failed_attempts = 0, locked_until = NULL WHERE user_id = $1', [row.id]);
      if (input.existingTokenHash) {
        await client.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
          [input.existingTokenHash]);
      }
      await insertSession(client, row.id, row.session_version, input.session);
      await audit(client, input.audit, {actorUserId: row.id, action: 'identity.login_succeeded', targetUserId: row.id});
      return userFromRow(row);
    });
  }

  async authenticate(tokenHash: Buffer, now: Date): Promise<AuthenticatedSession | null> {
    const result = await this.pool.query<UserRow & {session_id: string}>(
      `SELECT u.*, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
         AND s.session_version = u.session_version AND u.status = 'ACTIVE'`,
      [tokenHash, now]
    );
    const row = result.rows[0];
    if (!row) return null;
    await this.pool.query('UPDATE sessions SET last_seen_at = $2 WHERE id = $1', [row.session_id, now]);
    return {sessionId: row.session_id, user: userFromRow(row)};
  }

  async rotateSession(input: Parameters<IdentityStore['rotateSession']>[0]): Promise<IdentityUser> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.actor.user.id]);
      const row = result.rows[0];
      if (!row || row.status !== 'ACTIVE' || row.session_version !== input.actor.user.sessionVersion) {
        throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
      }
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
        [input.actor.sessionId, input.now]);
      await insertSession(client, row.id, row.session_version, input.replacementSession);
      await audit(client, input.audit, {actorUserId: row.id, action: 'identity.session_elevated', targetUserId: row.id});
      return userFromRow(row);
    });
  }

  async revokeSession(tokenHash: Buffer, now: Date, context: AuditContext): Promise<void> {
    await this.transaction(async client => {
      const result = await client.query<{user_id: string}>(
        'UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id',
        [tokenHash, now]
      );
      if (result.rows[0]) {
        await audit(client, context, {actorUserId: result.rows[0].user_id, action: 'identity.session_revoked',
          targetUserId: result.rows[0].user_id});
      }
    });
  }

  async changePassword(input: Parameters<IdentityStore['changePassword']>[0]): Promise<IdentityUser> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.actor.user.id]);
      const row = result.rows[0];
      if (!row || row.session_version !== input.actor.user.sessionVersion || row.status !== 'ACTIVE') {
        throw new AppError({code: 'AUTHENTICATION_REQUIRED', message: 'Authentication is required.'});
      }
      const nextVersion = row.session_version + 1;
      const updated = await client.query<UserRow>(
        `UPDATE users SET session_version = $2, must_change_password = false, updated_at = $3
         WHERE id = $1 RETURNING *`,
        [row.id, nextVersion, input.now]
      );
      await client.query(
        `UPDATE user_credentials SET password_hash = $2, password_changed_at = $3,
          failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
        [row.id, input.passwordHash, input.now]
      );
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [row.id, input.now]);
      await insertSession(client, row.id, nextVersion, input.replacementSession);
      await audit(client, input.audit, {actorUserId: row.id, action: 'identity.password_changed', targetUserId: row.id});
      return userFromRow(updated.rows[0] as UserRow);
    });
  }

  async listUsers(): Promise<IdentityUser[]> {
    const result = await this.pool.query<UserRow>('SELECT * FROM users ORDER BY created_at, id');
    return result.rows.map(userFromRow);
  }

  async createUser(input: Parameters<IdentityStore['createUser']>[0]): Promise<IdentityUser> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>(
        `INSERT INTO users (id, email, display_name, must_change_password)
         VALUES ($1, $2, $3, true) RETURNING *`,
        [input.id, input.email, input.displayName]
      );
      await client.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)',
        [input.id, input.passwordHash]);
      await audit(client, input.audit, {actorUserId: input.actor.user.id, action: 'admin.user_created', targetUserId: input.id});
      return userFromRow(result.rows[0] as UserRow);
    });
  }

  async resetPassword(input: Parameters<IdentityStore['resetPassword']>[0]): ReturnType<IdentityStore['resetPassword']> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.targetUserId]);
      const row = result.rows[0];
      if (!row) return null;
      if (row.status !== 'ACTIVE') return 'not_active';
      const updated = await client.query<UserRow>(
        `UPDATE users SET session_version = session_version + 1, must_change_password = true, updated_at = $2
         WHERE id = $1 RETURNING *`, [row.id, input.now]
      );
      await client.query(
        `UPDATE user_credentials SET password_hash = $2, password_changed_at = $3,
         failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
        [row.id, input.passwordHash, input.now]
      );
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [row.id, input.now]);
      await audit(client, input.audit, {actorUserId: input.actor.user.id, action: 'admin.user_password_reset', targetUserId: row.id});
      return userFromRow(updated.rows[0] as UserRow);
    });
  }

  async disableUser(input: Parameters<IdentityStore['disableUser']>[0]): ReturnType<IdentityStore['disableUser']> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.targetUserId]);
      const row = result.rows[0];
      if (!row) return 'not_found';
      if (row.is_system_admin) return 'system_admin';
      if (row.status !== 'ACTIVE') return 'not_active';
      await client.query(
        `UPDATE users SET status = 'DISABLED', disabled_at = $2, updated_at = $2,
          session_version = session_version + 1 WHERE id = $1`, [row.id, input.now]
      );
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [row.id, input.now]);
      await audit(client, input.audit, {actorUserId: input.actor.user.id, action: 'admin.user_disabled', targetUserId: row.id});
      return 'disabled';
    });
  }

  async revokeUserSessions(input: Parameters<IdentityStore['revokeUserSessions']>[0]): Promise<boolean> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>(
        `UPDATE users SET session_version = session_version + 1, updated_at = $2
         WHERE id = $1 RETURNING *`, [input.targetUserId, input.now]
      );
      const row = result.rows[0];
      if (!row) return false;
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [row.id, input.now]);
      await audit(client, input.audit, {actorUserId: input.actor.user.id, action: 'identity.session_revoked', targetUserId: row.id});
      return true;
    });
  }

  async anonymizeUser(input: Parameters<IdentityStore['anonymizeUser']>[0]): ReturnType<IdentityStore['anonymizeUser']> {
    return this.transaction(async client => {
      const replay = await client.query<{request_hash: Buffer; response_body: ReturnType<typeof userFromRow> & Record<string, unknown>}>(
        `SELECT request_hash, response_body FROM identity_idempotency_keys
         WHERE actor_user_id = $1 AND idempotency_key = $2 FOR UPDATE`,
        [input.actor.user.id, input.idempotencyKey]
      );
      if (replay.rows[0]) {
        if (!replay.rows[0].request_hash.equals(input.requestHash)) return 'idempotency_conflict';
        return replay.rows[0].response_body as unknown as Awaited<ReturnType<IdentityStore['anonymizeUser']>>;
      }

      const users = await client.query<UserRow>(
        `SELECT * FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[input.targetUserId, input.replacementUserId]]
      );
      const target = users.rows.find(row => row.id === input.targetUserId);
      const replacement = users.rows.find(row => row.id === input.replacementUserId);
      if (!target) return 'not_found';
      if (target.is_system_admin) return 'system_admin';
      if (target.status !== 'DISABLED') return 'not_disabled';
      if (!replacement || replacement.id === target.id || replacement.status !== 'ACTIVE') return 'invalid_replacement';
      if (target.email?.toLowerCase() !== input.confirmationEmail) return 'confirmation_mismatch';

      const deleting = await client.query(
        `SELECT id FROM committees WHERE owner_user_id = $1 AND status = 'DELETING' LIMIT 1 FOR UPDATE`,
        [target.id]
      );
      if (deleting.rowCount) return 'deletion_in_progress';

      await client.query('SET CONSTRAINTS committee_templates_owner_country_template_fk DEFERRED');
      const committees = await client.query<{id: string; revision: number; next_event_sequence: string}>(
        `SELECT id, revision, next_event_sequence FROM committees
         WHERE owner_user_id = $1 ORDER BY id FOR UPDATE`, [target.id]
      );
      for (const committee of committees.rows) {
        const revision = committee.revision + 1;
        await client.query(
          `UPDATE committees SET owner_user_id = $2, revision = $3,
             next_event_sequence = next_event_sequence + 1, updated_at = $4 WHERE id = $1`,
          [committee.id, replacement.id, revision, input.now]
        );
        await client.query(
          `INSERT INTO committee_events
            (committee_id, sequence, event_type, resource_type, resource_id, resource_revision, payload, audience)
           VALUES ($1, $2, 'committee.owner_transferred', 'committee', $1, $3, '{}'::jsonb, 'CHAIR')`,
          [committee.id, committee.next_event_sequence, revision]
        );
        await client.query(
          `INSERT INTO audit_log
            (id, request_id, committee_id, actor_user_id, effective_capabilities, action, resource_type,
             resource_id, result, before_summary, after_summary, source_ip_hash)
           VALUES ($1, $2, $3, $4, ARRAY['SYSTEM_ADMIN'], 'admin.committee_owner_transferred', 'committee',
             $3, 'SUCCEEDED', jsonb_build_object('ownerUserId', $5::text),
             jsonb_build_object('ownerUserId', $6::text), $7)`,
          [randomUUID(), input.audit.requestId, committee.id, input.actor.user.id, target.id, replacement.id,
            input.audit.sourceIpHash]
        );
      }

      const countryTemplates = await client.query(
        'UPDATE country_templates SET owner_user_id = $2, revision = revision + 1, updated_at = $3 WHERE owner_user_id = $1',
        [target.id, replacement.id, input.now]
      );
      const committeeTemplates = await client.query(
        'UPDATE committee_templates SET owner_user_id = $2, revision = revision + 1, updated_at = $3 WHERE owner_user_id = $1',
        [target.id, replacement.id, input.now]
      );
      const rulePackages = await client.query(
        'UPDATE rule_packages SET owner_user_id = $2, updated_at = $3 WHERE owner_user_id = $1',
        [target.id, replacement.id, input.now]
      );

      await client.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
      await client.query('DELETE FROM user_credentials WHERE user_id = $1', [target.id]);
      const updated = await client.query<UserRow>(
        `UPDATE users SET email = NULL, display_name = '匿名账号', status = 'ANONYMIZED',
           session_version = session_version + 1, must_change_password = false,
           updated_at = $2, anonymized_at = $2 WHERE id = $1 RETURNING *`,
        [target.id, input.now]
      );
      await audit(client, input.audit, {
        actorUserId: input.actor.user.id,
        action: 'admin.user_anonymized',
        targetUserId: target.id
      });
      const result = {
        user: userFromRow(updated.rows[0] as UserRow),
        replacementUserId: replacement.id,
        transferred: {
          committees: committees.rowCount ?? 0,
          countryTemplates: countryTemplates.rowCount ?? 0,
          committeeTemplates: committeeTemplates.rowCount ?? 0,
          rulePackages: rulePackages.rowCount ?? 0
        }
      };
      await client.query(
        `INSERT INTO identity_idempotency_keys
          (actor_user_id, idempotency_key, request_hash, response_body) VALUES ($1, $2, $3, $4)`,
        [input.actor.user.id, input.idempotencyKey, input.requestHash, result]
      );
      return result;
    });
  }
}

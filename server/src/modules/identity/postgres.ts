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
  email: string;
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
    email: row.email,
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

  async resetPassword(input: Parameters<IdentityStore['resetPassword']>[0]): Promise<IdentityUser | null> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.targetUserId]);
      const row = result.rows[0];
      if (!row) return null;
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

  async disableUser(input: Parameters<IdentityStore['disableUser']>[0]): Promise<'disabled' | 'not_found' | 'system_admin'> {
    return this.transaction(async client => {
      const result = await client.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [input.targetUserId]);
      const row = result.rows[0];
      if (!row) return 'not_found';
      if (row.is_system_admin) return 'system_admin';
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
}

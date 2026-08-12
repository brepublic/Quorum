// @vitest-environment node

import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runMigrations} from '../../db/migrations';
import {PostgresIdentityStore} from './postgres';
import {IdentityService} from './service';
import {hashOpaqueToken} from './tokens';

const {Client, Pool} = pg;
const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const integration = adminUrl ? describe : describe.skip;
let databaseName = '';
let databaseUrl = '';
let pool: pg.Pool | undefined;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

beforeEach(async () => {
  if (!adminUrl) return;
  databaseName = `quorum_identity_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  const client = new Client({connectionString: adminUrl});
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
  pool = new Pool({connectionString: databaseUrl});
  await runMigrations(pool, resolve('server/migrations'));
});

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  if (!adminUrl || !databaseName) return;
  const client = new Client({connectionString: adminUrl});
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
  } finally {
    await client.end();
    databaseName = '';
  }
});

function service(): IdentityService {
  return new IdentityService(new PostgresIdentityStore(pool as pg.Pool));
}

const context = {requestId: 'integration-request', sourceIp: '127.0.0.1', userAgent: 'Vitest'};

integration('PostgreSQL identity integration', () => {
  it('allows only one concurrent bootstrap and destroys the secret after success', async () => {
    const identity = service();
    const secret = await identity.ensureBootstrapSecret();
    expect(secret).toBeTruthy();

    await expect(identity.bootstrapAdmin({secret: 'wrong', email: 'wrong@example.com', displayName: 'Wrong',
      password: 'wrong-password-123'}, context)).rejects.toMatchObject({code: 'FORBIDDEN'});

    const attempts = await Promise.allSettled([
      identity.bootstrapAdmin({secret: secret as string, email: 'first@example.com', displayName: 'First',
        password: 'first-password-123'}, context),
      identity.bootstrapAdmin({secret: secret as string, email: 'second@example.com', displayName: 'Second',
        password: 'second-password-123'}, context)
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);

    const settings = await pool?.query('SELECT bootstrap_secret_hash, initialized_at FROM system_settings');
    const users = await pool?.query('SELECT is_system_admin FROM users');
    expect(settings?.rows[0].bootstrap_secret_hash).toBeNull();
    expect(settings?.rows[0].initialized_at).toBeInstanceOf(Date);
    expect(users?.rowCount).toBe(1);
    expect(users?.rows[0].is_system_admin).toBe(true);
    await expect(identity.bootstrapAdmin({secret: secret as string, email: 'third@example.com', displayName: 'Third',
      password: 'third-password-123'}, context)).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('stores Argon2id passwords and only hashes of Session tokens', async () => {
    const identity = service();
    const secret = await identity.ensureBootstrapSecret();
    const session = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com', displayName: 'Admin',
      password: 'admin-password-123'}, context);
    const credential = await pool?.query<{password_hash: string}>('SELECT password_hash FROM user_credentials');
    const storedSession = await pool?.query<{token_hash: Buffer}>('SELECT token_hash FROM sessions');

    expect(credential?.rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(credential?.rows[0]?.password_hash).not.toContain('admin-password-123');
    expect(storedSession?.rows[0]?.token_hash).toEqual(hashOpaqueToken(session.sessionToken));
    expect(storedSession?.rows[0]?.token_hash.toString('utf8')).not.toContain(session.sessionToken);
    const audit = await pool?.query<{id: string}>('SELECT id FROM identity_audit_log LIMIT 1');
    await expect((pool as pg.Pool).query('DELETE FROM identity_audit_log WHERE id = $1', [audit?.rows[0]?.id]))
      .rejects.toThrow('append-only');
  });

  it('rotates login and password Sessions and enforces the temporary-password flow', async () => {
    const identity = service();
    const secret = await identity.ensureBootstrapSecret();
    const administrator = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
      displayName: 'Admin', password: 'admin-password-123'}, context);
    const adminAuth = await identity.authenticate(administrator.sessionToken);
    const elevated = await identity.elevateSession(adminAuth, 'admin-password-123', context);
    expect(elevated.sessionToken).not.toBe(administrator.sessionToken);
    await expect(identity.authenticate(administrator.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    const elevatedAdminAuth = await identity.authenticate(elevated.sessionToken);
    const created = await identity.createUser(elevatedAdminAuth, {email: 'user@example.com', displayName: 'User'}, context);
    const firstLogin = await identity.login({email: 'user@example.com', password: created.temporaryPassword}, context);
    expect(firstLogin.user.mustChangePassword).toBe(true);
    await expect(identity.listUsers(await identity.authenticate(firstLogin.sessionToken))).rejects.toMatchObject({code: 'FORBIDDEN'});

    const changed = await identity.changePassword(await identity.authenticate(firstLogin.sessionToken), {
      currentPassword: created.temporaryPassword,
      newPassword: 'new-user-password-123'
    }, context);
    await expect(identity.authenticate(firstLogin.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    expect((await identity.authenticate(changed.sessionToken)).user.mustChangePassword).toBe(false);

    const relogin = await identity.login({email: 'user@example.com', password: 'new-user-password-123',
      existingSessionToken: changed.sessionToken}, context);
    expect(relogin.sessionToken).not.toBe(changed.sessionToken);
    await expect(identity.authenticate(changed.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
  });

  it('immediately invalidates Sessions after reset, disable, and user-level revocation', async () => {
    const identity = service();
    const secret = await identity.ensureBootstrapSecret();
    const administrator = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
      displayName: 'Admin', password: 'admin-password-123'}, context);
    const adminAuth = await identity.authenticate(administrator.sessionToken);

    const first = await identity.createUser(adminAuth, {email: 'first@example.com', displayName: 'First'}, context);
    const firstLogin = await identity.login({email: first.user.email, password: first.temporaryPassword}, context);
    const reset = await identity.resetPassword(adminAuth, first.user.id, context);
    await expect(identity.authenticate(firstLogin.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    const resetLogin = await identity.login({email: first.user.email, password: reset.temporaryPassword}, context);
    await identity.revokeUserSessions(adminAuth, first.user.id, context);
    await expect(identity.authenticate(resetLogin.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});

    const second = await identity.createUser(adminAuth, {email: 'second@example.com', displayName: 'Second'}, context);
    const secondLogin = await identity.login({email: second.user.email, password: second.temporaryPassword}, context);
    await identity.disableUser(adminAuth, second.user.id, context);
    await expect(identity.authenticate(secondLogin.sessionToken)).rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    await expect(identity.disableUser(adminAuth, adminAuth.user.id, context)).rejects.toMatchObject({code: 'RESOURCE_CONFLICT'});
  });

  it('locks an account after repeated failed logins', async () => {
    const identity = service();
    const secret = await identity.ensureBootstrapSecret();
    const administrator = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
      displayName: 'Admin', password: 'admin-password-123'}, context);
    const created = await identity.createUser(await identity.authenticate(administrator.sessionToken),
      {email: 'locked@example.com', displayName: 'Locked'}, context);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(identity.login({email: created.user.email, password: 'incorrect-password'}, context))
        .rejects.toMatchObject({code: 'AUTHENTICATION_REQUIRED'});
    }
    await expect(identity.login({email: created.user.email, password: created.temporaryPassword}, context))
      .rejects.toMatchObject({code: 'RATE_LIMITED'});
  });
});

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

  it('atomically transfers owned resources before irreversibly anonymizing a disabled account', async () => {
    const identity = service();
    const secret = await identity.ensureBootstrapSecret();
    const administrator = await identity.bootstrapAdmin({secret: secret as string, email: 'admin@example.com',
      displayName: 'Admin', password: 'admin-password-123'}, context);
    const adminAuth = await identity.authenticate(administrator.sessionToken);
    const replacement = await identity.createUser(adminAuth,
      {email: 'replacement@example.com', displayName: 'Replacement'}, context);
    const target = await identity.createUser(adminAuth, {email: 'departing@example.com', displayName: 'Departing'}, context);
    await identity.login({email: target.user.email, password: target.temporaryPassword}, context);

    const countryTemplateId = randomUUID();
    const committeeTemplateId = randomUUID();
    const packageId = randomUUID();
    const versionId = randomUUID();
    const committeeId = randomUUID();
    await pool?.query(
      `INSERT INTO country_templates (id, owner_user_id, names, default_language, country_languages)
       VALUES ($1, $2, '{"en":"Countries"}'::jsonb, 'en', ARRAY['en'])`,
      [countryTemplateId, target.user.id]
    );
    await pool?.query(
      `INSERT INTO committee_templates
        (id, owner_user_id, names, default_language, country_template_key, country_template_id)
       VALUES ($1, $2, '{"en":"Committee"}'::jsonb, 'en', $3, $4)`,
      [committeeTemplateId, target.user.id, `custom:${countryTemplateId}`, countryTemplateId]
    );
    await pool?.query(
      `INSERT INTO rule_packages (id, scope, owner_user_id, stable_key) VALUES ($1, 'SYSTEM', $2, $3)`,
      [packageId, target.user.id, `account-disposition-${packageId}`]
    );
    await pool?.query(
      `INSERT INTO rule_package_versions
        (id, package_id, version, status, definition, schema_version, created_by_user_id, published_at)
       VALUES ($1, $2, 1, 'PUBLISHED', '{}'::jsonb, 1, $3, now())`,
      [versionId, packageId, target.user.id]
    );
    await pool?.query(
      `INSERT INTO committees
        (id, owner_user_id, name, visibility, operation_mode, active_rule_package_version_id,
         source_committee_template_id, country_template_key, temporary_template)
       VALUES ($1, $2, 'Transfer committee', 'PRIVATE', 'CHAIR_OPERATED', $3, $4, $5, false)`,
      [committeeId, target.user.id, versionId, committeeTemplateId, `custom:${countryTemplateId}`]
    );
    await identity.disableUser(adminAuth, target.user.id, context);

    const result = await identity.anonymizeUser(adminAuth, target.user.id, {
      replacementUserId: replacement.user.id,
      confirmationEmail: target.user.email
    }, 'account-anonymization', context);
    expect(result.transferred).toEqual({committees: 1, countryTemplates: 1, committeeTemplates: 1, rulePackages: 1});
    expect(result.user).toMatchObject({email: '', displayName: '匿名账号', status: 'ANONYMIZED'});

    const stored = await pool?.query(
      `SELECT u.email, u.display_name, u.status, u.anonymized_at,
        EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id) AS has_credential,
        EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id) AS has_session
       FROM users u WHERE u.id = $1`, [target.user.id]
    );
    expect(stored?.rows[0]).toMatchObject({email: null, display_name: '匿名账号', status: 'ANONYMIZED',
      has_credential: false, has_session: false});
    expect(stored?.rows[0].anonymized_at).toBeInstanceOf(Date);
    const owners = await pool?.query(
      `SELECT
        (SELECT owner_user_id FROM committees WHERE id = $1) AS committee_owner,
        (SELECT owner_user_id FROM country_templates WHERE id = $2) AS country_owner,
        (SELECT owner_user_id FROM committee_templates WHERE id = $3) AS template_owner,
        (SELECT owner_user_id FROM rule_packages WHERE id = $4) AS package_owner,
        (SELECT created_by_user_id FROM rule_package_versions WHERE id = $5) AS historical_actor`,
      [committeeId, countryTemplateId, committeeTemplateId, packageId, versionId]
    );
    expect(owners?.rows[0]).toEqual({
      committee_owner: replacement.user.id,
      country_owner: replacement.user.id,
      template_owner: replacement.user.id,
      package_owner: replacement.user.id,
      historical_actor: target.user.id
    });
    const replay = await identity.anonymizeUser(adminAuth, target.user.id, {
      replacementUserId: replacement.user.id,
      confirmationEmail: target.user.email
    }, 'account-anonymization', context);
    expect(replay).toEqual(result);
    await expect(identity.anonymizeUser(adminAuth, target.user.id, {
      replacementUserId: adminAuth.user.id,
      confirmationEmail: target.user.email
    }, 'account-anonymization', context)).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
    await expect((pool as pg.Pool).query(
      "UPDATE users SET status = 'DISABLED', email = 'restored@example.com' WHERE id = $1", [target.user.id]
    )).rejects.toThrow('cannot be restored');
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

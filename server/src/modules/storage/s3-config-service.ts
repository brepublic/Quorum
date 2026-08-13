import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient, QueryResultRow} from 'pg';
import type {S3ProviderConfigSummary} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {audit, idempotentTransaction, requireBusinessIdentity, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import {StorageCredentialCipher, type S3Credentials} from './credential-crypto.js';
import {NodeS3Transport, type S3ProviderConfig, type S3Transport} from './s3-store.js';
import {validateS3Endpoint} from './s3-endpoint.js';

interface ConfigRow extends QueryResultRow {
  id: string;
  display_name: string;
  endpoint: string;
  region: string;
  bucket: string;
  key_prefix: string;
  force_path_style: boolean;
  allow_private_network: boolean;
  status: 'ACTIVE' | 'DISABLED';
  credentials_ciphertext: Buffer;
  credentials_nonce: Buffer;
  credentials_auth_tag: Buffer;
  credential_key_version: number;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export type S3TransportFactory = (config: S3ProviderConfig) => S3Transport;

function requireAdministrator(auth: AuthenticatedSession): void {
  requireBusinessIdentity(auth);
  if (!auth.user.isSystemAdmin) {
    throw new AppError({code: 'FORBIDDEN', message: 'System administrator access is required.'});
  }
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value.trim();
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'Revision is invalid.'});
  }
  return Number(value);
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError({code: 'VALIDATION_FAILED', message: `${name} is invalid.`});
  }
  return value;
}

function summary(row: ConfigRow): S3ProviderConfigSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.key_prefix,
    forcePathStyle: row.force_path_style,
    allowPrivateNetwork: row.allow_private_network,
    status: row.status,
    credentialKeyVersion: row.credential_key_version,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function configInput(body: unknown): Omit<S3ProviderConfig, 'credentials'> & {displayName: string; credentials: unknown} {
  assertExactBody(body as Record<string, unknown>, ['displayName', 'endpoint', 'region', 'bucket', 'prefix',
    'forcePathStyle', 'allowPrivateNetwork', 'credentials']);
  const value = body as Record<string, unknown>;
  if (typeof value.forcePathStyle !== 'boolean' || typeof value.allowPrivateNetwork !== 'boolean') {
    throw new AppError({code: 'VALIDATION_FAILED', message: 'S3 provider options are invalid.'});
  }
  const validated = validateS3Endpoint({endpoint: text(value.endpoint, 'Endpoint', 2048),
    region: text(value.region, 'Region', 63).toLowerCase(), bucket: text(value.bucket, 'Bucket', 63).toLowerCase(),
    prefix: value.prefix === '' ? '' : text(value.prefix, 'Prefix', 256).toLowerCase(),
    forcePathStyle: value.forcePathStyle, allowPrivateNetwork: value.allowPrivateNetwork});
  return {...validated, displayName: text(value.displayName, 'Display name', 120), credentials: value.credentials};
}

export class Stage6S3ConfigService {
  constructor(private readonly pool: Pool, private readonly cipher: StorageCredentialCipher,
    private readonly transportFactory: S3TransportFactory = config => new NodeS3Transport(config)) {}

  async list(auth: AuthenticatedSession): Promise<S3ProviderConfigSummary[]> {
    requireBusinessIdentity(auth);
    const result = await this.pool.query<ConfigRow>(`SELECT * FROM storage_provider_configs
      WHERE provider_type='S3_COMPATIBLE' AND ($1::boolean OR status='ACTIVE') ORDER BY display_name,id`,
    [auth.user.isSystemAdmin]);
    return result.rows.map(summary);
  }

  async create(auth: AuthenticatedSession, body: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<S3ProviderConfigSummary> {
    requireAdministrator(auth);
    const input = configInput(body);
    const id = randomUUID();
    const encrypted = this.cipher.encrypt(id, input.credentials);
    return idempotentTransaction({pool: this.pool, auth, route: '/api/v1/admin/storage-provider-configs/s3',
      key: idempotencyKey, request: body, status: 201, work: async client => {
        const created = await client.query<ConfigRow>(`INSERT INTO storage_provider_configs
          (id,provider_type,display_name,endpoint,region,bucket,key_prefix,force_path_style,allow_private_network,
           credentials_ciphertext,credentials_nonce,credentials_auth_tag,credential_key_version,created_by_user_id)
          VALUES ($1,'S3_COMPATIBLE',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [id, input.displayName, input.endpoint, input.region, input.bucket, input.prefix, input.forcePathStyle,
          input.allowPrivateNetwork, encrypted.ciphertext, encrypted.nonce, encrypted.authTag,
          encrypted.keyVersion, auth.user.id]);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['SYSTEM_ADMIN'],
          action: 'storage.provider_config_created', resourceType: 'storage_provider_config', resourceId: id,
          after: {...summary(created.rows[0] as ConfigRow), credentialKeyVersion: encrypted.keyVersion}});
        return summary(created.rows[0] as ConfigRow);
      }});
  }

  async update(auth: AuthenticatedSession, configId: string, body: unknown, idempotencyKey: string,
    context: Stage4Context): Promise<S3ProviderConfigSummary> {
    requireAdministrator(auth);
    assertExactBody(body as Record<string, unknown>, ['baseRevision', 'displayName', 'endpoint', 'region', 'bucket',
      'prefix', 'forcePathStyle', 'allowPrivateNetwork', 'status', 'credentials']);
    const value = body as Record<string, unknown>;
    const id = uuid(configId, 'Provider config ID');
    const baseRevision = revision(value.baseRevision);
    if (!['ACTIVE', 'DISABLED'].includes(value.status as string)) {
      throw new AppError({code: 'VALIDATION_FAILED', message: 'Provider config status is invalid.'});
    }
    const input = configInput({displayName: value.displayName, endpoint: value.endpoint, region: value.region,
      bucket: value.bucket, prefix: value.prefix, forcePathStyle: value.forcePathStyle,
      allowPrivateNetwork: value.allowPrivateNetwork,
      credentials: value.credentials ?? {accessKeyId: 'placeholder', secretAccessKey: 'placeholder'}});
    return idempotentTransaction({pool: this.pool, auth, route: `/api/v1/admin/storage-provider-configs/${id}`,
      key: idempotencyKey, request: body, status: 200, work: async client => {
        const current = await this.configForUpdate(client, id);
        if (current.revision !== baseRevision) {
          throw new AppError({code: 'REVISION_CONFLICT', message: 'This provider config changed since it was loaded.',
            details: {currentRevision: current.revision}});
        }
        const encrypted = value.credentials === undefined ? {
          ciphertext: current.credentials_ciphertext, nonce: current.credentials_nonce,
          authTag: current.credentials_auth_tag, keyVersion: current.credential_key_version
        } : this.cipher.encrypt(id, value.credentials);
        const updated = await client.query<ConfigRow>(`UPDATE storage_provider_configs SET display_name=$2,
          endpoint=$3,region=$4,bucket=$5,key_prefix=$6,force_path_style=$7,allow_private_network=$8,status=$9,
          credentials_ciphertext=$10,credentials_nonce=$11,credentials_auth_tag=$12,credential_key_version=$13,
          revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.displayName, input.endpoint, input.region, input.bucket, input.prefix, input.forcePathStyle,
          input.allowPrivateNetwork, value.status, encrypted.ciphertext, encrypted.nonce, encrypted.authTag,
          encrypted.keyVersion]);
        await audit(client, context, {actorUserId: auth.user.id, capabilities: ['SYSTEM_ADMIN'],
          action: 'storage.provider_config_updated', resourceType: 'storage_provider_config', resourceId: id,
          before: summary(current), after: summary(updated.rows[0] as ConfigRow)});
        return summary(updated.rows[0] as ConfigRow);
      }});
  }

  async verify(auth: AuthenticatedSession, configId: string, idempotencyKey: string,
    context: Stage4Context): Promise<S3ProviderConfigSummary> {
    requireAdministrator(auth);
    const id = uuid(configId, 'Provider config ID');
    const row = await this.loadRow(id, false);
    const transport = this.transportFactory(this.provider(row));
    const response = await transport.request({method: 'HEAD', key: ''});
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new AppError({code: 'SERVICE_NOT_READY', message: 'S3 provider verification failed.'});
    }
    return idempotentTransaction({pool: this.pool, auth,
      route: `/api/v1/admin/storage-provider-configs/${id}/verify`, key: idempotencyKey,
      request: {}, status: 200, work: async client => {
        await audit(client, context, {actorUserId: auth.user.id,
          capabilities: ['SYSTEM_ADMIN'], action: 'storage.provider_config_verified',
          resourceType: 'storage_provider_config', resourceId: id,
          after: {status: row.status, revision: row.revision}});
        return summary(row);
      }});
  }

  async providerForBinding(configId: string): Promise<S3ProviderConfig> {
    return this.provider(await this.loadRow(configId, true));
  }

  async providerForStoredBlob(configId: string): Promise<S3ProviderConfig> {
    return this.provider(await this.loadRow(configId, false));
  }

  private provider(row: ConfigRow): S3ProviderConfig {
    const credentials: S3Credentials = this.cipher.decrypt(row.id, {
      ciphertext: row.credentials_ciphertext, nonce: row.credentials_nonce,
      authTag: row.credentials_auth_tag, keyVersion: row.credential_key_version
    });
    const endpoint = validateS3Endpoint({endpoint: row.endpoint, region: row.region, bucket: row.bucket,
      prefix: row.key_prefix, forcePathStyle: row.force_path_style,
      allowPrivateNetwork: row.allow_private_network});
    return {...endpoint, credentials};
  }

  private async loadRow(id: string, activeOnly: boolean): Promise<ConfigRow> {
    const result = await this.pool.query<ConfigRow>(`SELECT * FROM storage_provider_configs WHERE id=$1
      AND provider_type='S3_COMPATIBLE' AND ($2::boolean=false OR status='ACTIVE')`, [id, activeOnly]);
    if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'S3 provider config not found.'});
    return result.rows[0];
  }

  private async configForUpdate(client: PoolClient, id: string): Promise<ConfigRow> {
    const result = await client.query<ConfigRow>('SELECT * FROM storage_provider_configs WHERE id=$1 FOR UPDATE', [id]);
    if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'S3 provider config not found.'});
    return result.rows[0];
  }
}

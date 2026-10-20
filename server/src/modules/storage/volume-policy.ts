import pg, {type Pool, type PoolClient} from 'pg';
import {AppError} from '../../http/errors.js';

// Held across provider I/O, not only metadata transactions. Policy changes and
// destructive maintenance take the exclusive form before acquiring row locks.
export const VOLUME_IO_LOCK = 7641903490;
export async function withVolumeLock<T>(pool: Pool, exclusive: boolean, operation: () => Promise<T>): Promise<T> {
  // A separate connection prevents lock waiters from exhausting the business
  // pool while the lock holder needs a connection to publish its result.
  const client = new pg.Client(pool.options);
  await client.connect();
  try {
    await client.query(exclusive ? 'SELECT pg_advisory_lock($1)' : 'SELECT pg_advisory_lock_shared($1)', [VOLUME_IO_LOCK]);
    return await operation();
  } finally { await client.end(); }
}
export function withVolumeIO<T>(pool: Pool, operation: () => Promise<T>): Promise<T> {
  return withVolumeLock(pool, false, operation);
}
export async function assertVolumeEnabled(client: PoolClient): Promise<void> {
  const result = await client.query('SELECT server_volume_disabled FROM system_settings WHERE singleton=true FOR SHARE');
  if (result.rows[0]?.server_volume_disabled) throw new AppError({code: 'FORBIDDEN', reason: 'SERVER_VOLUME_DISABLED',
    message: 'Server volume storage is disabled. Migrate storage before submitting files.'});
}
export async function assertBindingWritable(client: PoolClient, bindingId: string | null): Promise<void> {
  const binding = await client.query('SELECT provider_type FROM storage_bindings WHERE id=$1', [bindingId]);
  if (binding.rows[0]?.provider_type === 'SERVER_VOLUME') await assertVolumeEnabled(client);
}
export async function readVolumePolicy(client: Pool | PoolClient, committeeId?: string) {
  const result = await client.query(`SELECT server_volume_disabled,server_volume_policy_revision,
    (SELECT b.provider_type FROM committees c JOIN storage_bindings b ON b.id=c.active_storage_binding_id WHERE c.id=$1) AS provider
    FROM system_settings WHERE singleton=true`, [committeeId ?? null]);
  const row = result.rows[0];
  return {disabled: Boolean(row.server_volume_disabled), revision: Number(row.server_volume_policy_revision),
    submissionBlocked: Boolean(row.server_volume_disabled && row.provider === 'SERVER_VOLUME')};
}

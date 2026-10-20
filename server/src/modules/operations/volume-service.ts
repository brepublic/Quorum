import type {Pool} from 'pg';
import type {AuthenticatedSession} from '../identity/store.js';
import {AppError} from '../../http/errors.js';
import {audit, transaction, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import {readVolumePolicy, withVolumeLock} from '../storage/volume-policy.js';

export function requireVolumeAdmin(auth: AuthenticatedSession): void {
  if (auth.user.mustChangePassword || !auth.user.isSystemAdmin) throw new AppError({code: 'FORBIDDEN',
    reason: 'SYSTEM_ADMIN_REQUIRED', message: 'System administrator access is required.'});
}
export class ServerVolumeOperationsService {
  constructor(private readonly pool: Pool) {}
  async policy(auth: AuthenticatedSession) {
    requireVolumeAdmin(auth); const {disabled, revision} = await readVolumePolicy(this.pool);
    return {disabled, revision};
  }
  async update(auth: AuthenticatedSession, body: Record<string, unknown>, context: Stage4Context) {
    requireVolumeAdmin(auth); assertExactBody(body, ['disabled', 'revision']);
    if (typeof body.disabled !== 'boolean' || !Number.isSafeInteger(body.revision)) throw new AppError({code: 'VALIDATION_FAILED',
      reason: 'CLIENT_REQUEST_INVALID', message: 'A boolean disabled flag and revision are required.'});
    return withVolumeLock(this.pool, true, () => transaction(this.pool, async client => {
      const current = await readVolumePolicy(client);
      if (current.revision !== body.revision) throw new AppError({code: 'REVISION_CONFLICT', message: 'Storage policy changed.'});
      await client.query(`UPDATE system_settings SET server_volume_disabled=$1,
        server_volume_policy_revision=server_volume_policy_revision+1 WHERE singleton=true`, [body.disabled]);
      await audit(client, context, {actorUserId: auth.user.id, capabilities: ['SYSTEM_ADMIN'],
        action: 'storage.volume_policy_updated', resourceType: 'system_settings', before: current,
        after: {disabled: body.disabled, revision: current.revision + 1}});
      return {disabled:Boolean(body.disabled),revision:current.revision+1};
    }));
  }
}

import type {Pool} from 'pg';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {audit, requireBusinessIdentity, transaction, type Stage4Context} from '../stage4/database.js';
import {rebuildSearchIndex} from './index-service.js';
import {SEARCH_ALGORITHM_VERSION} from './terms.js';

export class SearchIndexService {
  constructor(private readonly pool: Pool) {}

  private requireAdmin(auth: AuthenticatedSession): void {
    requireBusinessIdentity(auth);
    if (!auth.user.isSystemAdmin) throw new AppError({reason: 'SYSTEM_ADMIN_REQUIRED',
      code: 'FORBIDDEN', message: 'System administrator access is required.'});
  }

  async ensureCurrent(): Promise<void> {
    const current = await this.pool.query<{algorithm_version: string | null}>(
      `SELECT g.algorithm_version FROM search_index_state s LEFT JOIN search_index_generations g
       ON g.id=s.active_generation_id WHERE s.singleton=true`);
    if (current.rows[0]?.algorithm_version !== SEARCH_ALGORITHM_VERSION) await rebuildSearchIndex(this.pool);
  }

  async status(auth: AuthenticatedSession): Promise<{version: string | null; count: number; updatedAt: string | null}> {
    this.requireAdmin(auth);
    const result = await this.pool.query<{algorithm_version: string | null; updated_at: Date | null; count: string}>(
      `SELECT g.algorithm_version,s.updated_at,
       (SELECT count(*) FROM generated_search_terms WHERE generation_id=s.active_generation_id)::text AS count
       FROM search_index_state s LEFT JOIN search_index_generations g ON g.id=s.active_generation_id
       WHERE s.singleton=true`);
    const row = result.rows[0];
    return {version: row?.algorithm_version ?? null, count: Number(row?.count ?? 0),
      updatedAt: row?.updated_at?.toISOString() ?? null};
  }

  async rebuild(auth: AuthenticatedSession, context: Stage4Context): Promise<{generation: number; count: number}> {
    this.requireAdmin(auth);
    const result = await rebuildSearchIndex(this.pool);
    await transaction(this.pool, client => audit(client, context, {actorUserId: auth.user.id,
      capabilities: ['SYSTEM_ADMIN'], action: 'search.index_rebuilt', resourceType: 'search_index',
      after: {generation: result.generation, count: result.count}}));
    return result;
  }
}

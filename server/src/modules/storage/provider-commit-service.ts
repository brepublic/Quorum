import type {Pool} from 'pg';
import type {FileEntry} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import type {Stage4Context} from '../stage4/database.js';
import type {Stage6S3CommitService} from './s3-commit-service.js';
import type {Stage6ServerVolumeService} from './server-volume-service.js';

export class Stage6ProviderCommitService {
  constructor(private readonly pool: Pool, private readonly serverVolume: Stage6ServerVolumeService,
    private readonly s3: Stage6S3CommitService) {}

  async commitUpload(auth: AuthenticatedSession, uploadId: string, body: unknown,
    idempotencyKey: string, context: Stage4Context): Promise<FileEntry> {
    const result = await this.pool.query<{provider_type: 'SERVER_VOLUME' | 'S3_COMPATIBLE'}>(`SELECT b.provider_type
      FROM file_uploads u JOIN storage_bindings b ON b.id=u.storage_binding_id WHERE u.id=$1`, [uploadId]);
    if (!result.rows[0]) throw new AppError({code: 'NOT_FOUND', message: 'Upload not found.'});
    return result.rows[0].provider_type === 'S3_COMPATIBLE'
      ? this.s3.commitUpload(auth, uploadId, body, idempotencyKey, context)
      : this.serverVolume.commitUpload(auth, uploadId, body, idempotencyKey, context);
  }
}

// @vitest-environment node

import {describe, expect, it} from 'vitest';
import {publicAgentStatus} from './status';

describe('Chair Agent public status', () => {
  it('contains only bounded counters and no identity, path, credential, or content fields', () => {
    const state = {schemaVersion: 1 as const, committeeId: 'committee-secret', deviceId: 'device-secret',
      manifestSequence: 8, files: {file: {fileEntryId: 'file', relativePath: 'private/path.txt', revision: 1,
        blobId: 'blob', sizeBytes: 3, sha256: 'a'.repeat(64), modifiedTimeMs: 1}},
      pendingUploads: {task: {taskId: 'task', requestId: 'request', manifestSequence: 8,
        change: {kind: 'DELETE' as const, fileEntryId: 'file', baseRevision: 1}, relativePath: 'private/path.txt',
        fileEntryId: 'file', fileRevision: 2, sizeBytes: 3, sha256: 'b'.repeat(64)}},
      conflicts: {conflict: {conflictId: 'conflict', relativePath: 'private/path.txt',
        change: {kind: 'DELETE' as const, fileEntryId: 'file', baseRevision: 1}}}};
    const status = publicAgentStatus(state, 7);
    expect(status).toEqual({leaseGeneration: 7, manifestSequence: 8, trackedFiles: 1,
      pendingUploads: 1, pendingConflicts: 1});
    expect(JSON.stringify(status)).not.toMatch(/secret|private|path|credential|sha256|fileEntryId/);
  });
});

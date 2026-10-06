import {describe, expect, it} from 'vitest';
import type {FileEntry, StorageAgentConflict, StorageAgentConflictServerFile} from '@quorum/contracts';
import {compareStorageConflict} from './conflict-comparison';

const serverFile: StorageAgentConflictServerFile = {id: 'file', revision: 3, status: 'PENDING_REVIEW',
  logicalName: 'Server draft.txt', publishedAt: null, mergedIntoFileEntryId: null,
  updatedAt: '2026-10-06T10:00:00Z', currentVersion: {id: 'version', sha256: 'a'.repeat(64),
    sizeBytes: 3, createdAt: '2026-10-06T10:00:00Z'}};
const loadedFile: FileEntry = {...serverFile, committeeId: 'committee', mediaType: 'text/plain',
  syncState: 'SYNCED', createdByUserId: 'owner', submittedAt: null, createdAt: '2026-10-06T10:00:00Z',
  currentVersion: {...serverFile.currentVersion!, versionNumber: 1, originalName: 'server.txt',
    mediaType: 'text/plain', blobId: 'blob'}};
const conflict: StorageAgentConflict = {id: 'conflict', committeeId: 'committee', hostId: 'host',
  fileEntryId: 'file', localBaseRevision: 2, serverRevision: 2, reasonCode: 'REVISION_CONFLICT',
  status: 'PENDING', revision: 1, serverFile, change: {kind: 'UPSERT', fileEntryId: 'file', baseRevision: 2,
    logicalName: 'Local draft.txt', originalName: 'draft.txt', mediaType: 'text/plain', sizeBytes: 5, sha256: 'b'.repeat(64)},
  resolutionAction: null, resolutionLogicalName: null, resolutionLeaseGeneration: null,
  resolutionFileRevision: null, createdAt: '2026-10-06T11:00:00Z', resolvedAt: null};

describe('Chair Agent conflict comparison', () => {
  it('identifies byte equality from the hash and size without ordering timestamps', () => {
    const comparison = compareStorageConflict({...conflict, change: {...conflict.change as Extract<typeof conflict.change,
      {kind: 'UPSERT'}>, sha256: 'a'.repeat(64), sizeBytes: 3}}, undefined, 'host');
    expect(comparison).toMatchObject({relation: 'IDENTICAL', recommended: 'KEEP_SERVER', fileRevision: 3});
  });
  it('recommends local content only when the server still has the local base revision', () => {
    expect(compareStorageConflict({...conflict, serverFile: {...serverFile, revision: 2}}, undefined, 'host'))
      .toMatchObject({relation: 'LOCAL_CHANGED', recommended: 'ACCEPT_LOCAL', fileRevision: 2});
  });
  it('preserves both versions when revisions have advanced and the content differs', () => {
    expect(compareStorageConflict(conflict, undefined, 'host')).toMatchObject({relation: 'DIVERGED',
      recommended: 'SAVE_AS_NEW', fileRevision: 3});
    expect(compareStorageConflict(conflict, undefined, 'host').summary).toBe('Both files have changed.');
  });
  it.each(['REVISION_CONFLICT', 'MANIFEST_STALE', 'NAME_CONFLICT'] as const)
    ('protects current formal files even if the original reason is %s', reasonCode => {
      const comparison = compareStorageConflict({...conflict, reasonCode,
        serverFile: {...serverFile, status: 'PUBLISHED', publishedAt: '2026-10-06T12:00:00Z'}}, undefined, 'host');
      expect(comparison.allowed).toEqual(['KEEP_SERVER', 'ACCEPT_LOCAL']);
      expect(comparison.recommended).toBe('KEEP_SERVER');
      expect(comparison.guidance).toContain('replaces the published contents');
    });
  it('uses the original merged source snapshot rather than the downloadable formal target', () => {
    const comparison = compareStorageConflict({...conflict, serverFile: {...serverFile,
      mergedIntoFileEntryId: 'formal-target'}}, {...loadedFile, id: 'formal-target', revision: 99}, 'host');
    expect(comparison).toMatchObject({relation: 'UNKNOWN', merged: true, fileRevision: 3,
      downloadFileId: 'formal-target', allowed: ['KEEP_SERVER'], recommended: 'KEEP_SERVER'});
  });
  it('keeps deleted former formal files available for save-as-new without reviving the original', () => {
    expect(compareStorageConflict({...conflict, reasonCode: 'REVIEW_REQUIRED', serverFile: {...serverFile,
      status: 'DELETED', publishedAt: '2026-10-06T12:00:00Z'}}, undefined, 'host'))
      .toMatchObject({relation: 'DELETED', allowed: ['KEEP_SERVER', 'SAVE_AS_NEW'], recommended: 'SAVE_AS_NEW',
        downloadFileId: undefined, fileRevision: 3});
  });
  it('distinguishes missing current source metadata from an old backend without snapshots', () => {
    expect(compareStorageConflict({...conflict, serverFile: null}, undefined, 'host'))
      .toMatchObject({relation: 'DELETED', fileRevision: null, downloadFileId: undefined});
    expect(compareStorageConflict({...conflict, serverFile: undefined}, undefined, 'host'))
      .toMatchObject({relation: 'UNKNOWN', allowed: ['KEEP_SERVER'], recommended: undefined});
  });
  it('does not accept content from a replaced host with an ordinary old conflict reason', () => {
    expect(compareStorageConflict(conflict, undefined, 'new-host'))
      .toMatchObject({allowed: ['KEEP_SERVER'], recommended: 'KEEP_SERVER'});
    expect(compareStorageConflict(conflict, undefined, undefined).allowed).toEqual([]);
  });
  it('does not claim equality from size alone or a lower or unknown server revision', () => {
    const sameSize = {...conflict, change: {...conflict.change as Extract<typeof conflict.change, {kind: 'UPSERT'}>, sizeBytes: 3}};
    expect(compareStorageConflict(sameSize, undefined, 'host').relation).toBe('DIVERGED');
    expect(compareStorageConflict({...conflict, serverFile: {...serverFile, revision: 1}}, undefined, 'host'))
      .toMatchObject({relation: 'UNKNOWN', recommended: undefined});
    expect(compareStorageConflict({...conflict, localBaseRevision: null}, undefined, 'host').relation).toBe('UNKNOWN');
  });
  it('does not recommend deleting a server revision that advanced after the local deletion', () => {
    expect(compareStorageConflict({...conflict, change: {kind: 'DELETE', fileEntryId: 'file', baseRevision: 2}}, undefined, 'host'))
      .toMatchObject({relation: 'LOCAL_DELETE', recommended: 'KEEP_SERVER'});
  });
  it.each([[3, 'ACCEPT_LOCAL'], [2, 'KEEP_SERVER']] as const)
    ('allows deleting an ordinary formal file while recommending from base revision %s', (baseRevision, recommended) => {
      const comparison = compareStorageConflict({...conflict, localBaseRevision: baseRevision,
        change: {kind: 'DELETE', fileEntryId: 'file', baseRevision},
        serverFile: {...serverFile, status: 'PUBLISHED', publishedAt: '2026-10-06T12:00:00Z'}}, undefined, 'host');
      expect(comparison).toMatchObject({relation: 'LOCAL_DELETE', fileRevision: 3,
        allowed: ['KEEP_SERVER', 'ACCEPT_LOCAL'], recommended, guidance: undefined});
    });
  it.each(['merged', 'review-required'] as const)
    ('keeps %s deletion restricted even if the current base revision matches', restriction => {
      const comparison = compareStorageConflict({...conflict, localBaseRevision: 3,
        reasonCode: restriction === 'review-required' ? 'REVIEW_REQUIRED' : 'REVISION_CONFLICT',
        change: {kind: 'DELETE', fileEntryId: 'file', baseRevision: 3},
        serverFile: {...serverFile, status: 'PUBLISHED', publishedAt: '2026-10-06T12:00:00Z',
          mergedIntoFileEntryId: restriction === 'merged' ? 'formal-target' : null}}, undefined, 'host');
      expect(comparison.allowed).toEqual(['KEEP_SERVER']);
      expect(comparison.allowed).not.toContain('ACCEPT_LOCAL');
    });
  it('uses current metadata for legacy lists and does not compare merged target bytes as source bytes', () => {
    expect(compareStorageConflict({...conflict, serverFile: undefined}, loadedFile, 'host').fileRevision).toBe(3);
    expect(compareStorageConflict({...conflict, serverFile: undefined}, {...loadedFile, id: 'target'}, 'host')).toMatchObject({relation: 'UNKNOWN', allowed: ['KEEP_SERVER']});
  });
});

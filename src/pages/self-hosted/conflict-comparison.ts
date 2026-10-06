import type {FileEntry, StorageAgentConflict, StorageAgentConflictResolution} from '@quorum/contracts';

type ServerFile = NonNullable<StorageAgentConflict['serverFile']>;
export type ConflictComparison = {
  serverFile: ServerFile | null | undefined;
  fileRevision: number | null;
  relation: 'IDENTICAL' | 'LOCAL_CHANGED' | 'DIVERGED' | 'UNKNOWN' | 'DELETED' | 'NEW_FILE' | 'RENAME' | 'LOCAL_DELETE';
  summary: string;
  guidance?: string;
  allowed: StorageAgentConflictResolution[];
  recommended?: StorageAgentConflictResolution;
  downloadFileId?: string;
  merged: boolean;
};

export function compareStorageConflict(conflict: StorageAgentConflict, loadedFile?: FileEntry,
  activeHostId?: string): ConflictComparison {
  const serverFile: ServerFile | null | undefined = conflict.serverFile !== undefined ? conflict.serverFile
    : loadedFile?.id === conflict.fileEntryId ? {...loadedFile, mergedIntoFileEntryId: null} : undefined;
  const merged = Boolean(serverFile?.mergedIntoFileEntryId
    || loadedFile && conflict.fileEntryId && loadedFile.id !== conflict.fileEntryId);
  const deleted = Boolean(conflict.fileEntryId && serverFile === null)
    || serverFile?.status === 'DELETED' || conflict.reasonCode === 'FILE_DELETED';
  const revoked = conflict.reasonCode === 'HOST_TRANSFERRED'
    || Boolean(activeHostId && activeHostId !== conflict.hostId);
  const reviewRequired = !deleted && (merged || conflict.reasonCode === 'REVIEW_REQUIRED'
    || conflict.change.kind !== 'DELETE' && (Boolean(serverFile?.publishedAt) || serverFile?.status === 'PUBLISHED'));
  const known = serverFile !== undefined || !conflict.fileEntryId;
  const allowed: StorageAgentConflictResolution[] = activeHostId ? ['KEEP_SERVER'] : [];
  if (activeHostId && !revoked && !reviewRequired && known) {
    if (!deleted) allowed.push('ACCEPT_LOCAL');
    if (conflict.change.kind === 'UPSERT') allowed.push('SAVE_AS_NEW');
  }
  if (activeHostId && !revoked && !deleted && !merged && known && reviewRequired
    && conflict.change.kind === 'UPSERT' && (serverFile?.publishedAt || serverFile?.status === 'PUBLISHED')) allowed.push('ACCEPT_LOCAL');
  const base = {
    serverFile, merged, allowed,
    fileRevision: serverFile === undefined ? conflict.serverRevision : serverFile?.revision ?? null,
    downloadFileId: deleted ? undefined : serverFile?.mergedIntoFileEntryId
      ?? (serverFile?.currentVersion ? serverFile.id : loadedFile?.status !== 'DELETED' ? loadedFile?.id ?? conflict.fileEntryId ?? undefined : undefined),
  };
  const decision = (relation: ConflictComparison['relation'], summary: string,
    recommended?: StorageAgentConflictResolution, guidance?: string): ConflictComparison => ({...base,
    relation, summary, guidance, recommended: recommended && allowed.includes(recommended) ? recommended : undefined});
  if (revoked) return decision('UNKNOWN', 'This change came from a replaced Chair computer.', 'KEEP_SERVER');
  if (deleted) return decision('DELETED', 'The server file has been deleted.',
    conflict.change.kind === 'UPSERT' ? 'SAVE_AS_NEW' : 'KEEP_SERVER',
    conflict.change.kind === 'UPSERT' ? 'Save a new file to retain the local content.' : undefined);
  const guidance = reviewRequired ? merged ? 'Open the published file to update it.'
    : 'Keeping the local version replaces the published contents.' : undefined;
  if (merged) return decision('UNKNOWN', 'This submission has been replaced by the published file.', 'KEEP_SERVER', guidance);
  if (!conflict.fileEntryId) return decision('NEW_FILE', 'This is an unsubmitted local file.', 'SAVE_AS_NEW');
  if (!serverFile) return decision('UNKNOWN', 'Download the server file to compare its contents.',
    reviewRequired ? 'KEEP_SERVER' : undefined, guidance);
  const localBase = conflict.localBaseRevision;
  if (conflict.change.kind === 'DELETE') return decision('LOCAL_DELETE',
    localBase === serverFile.revision ? 'The local file was deleted. The server copy has not changed.'
      : 'The local file was deleted, but the server copy has changed.',
    localBase === serverFile.revision ? 'ACCEPT_LOCAL' : 'KEEP_SERVER', guidance);
  if (conflict.change.kind === 'RENAME') return decision('RENAME',
    localBase === serverFile.revision ? 'The local file was renamed. The server copy has not changed.'
      : 'The local file was renamed and the server copy has changed.', reviewRequired ? 'KEEP_SERVER'
      : localBase === serverFile.revision ? 'ACCEPT_LOCAL' : undefined, guidance);
  const version = serverFile.currentVersion;
  if (!version) return decision('UNKNOWN', 'Download the server file to compare its contents.',
    reviewRequired ? 'KEEP_SERVER' : undefined, guidance);
  if (/^[0-9a-f]{64}$/i.test(conflict.change.sha256) && conflict.change.sha256.toLowerCase() === version.sha256.toLowerCase()
    && conflict.change.sizeBytes === version.sizeBytes) return decision('IDENTICAL', 'Both files have the same contents.', 'KEEP_SERVER', guidance);
  if (localBase === serverFile.revision) return decision('LOCAL_CHANGED',
    'Only the local file has changed.', 'ACCEPT_LOCAL', guidance);
  if (localBase !== null && serverFile.revision > localBase) return decision('DIVERGED',
    'The local and server files have different contents.',
    reviewRequired ? 'KEEP_SERVER' : 'SAVE_AS_NEW', reviewRequired ? guidance : 'Save a new file to retain both versions.');
  return decision('UNKNOWN', 'Download the server file to compare its contents.',
    reviewRequired ? 'KEEP_SERVER' : undefined, guidance);
}

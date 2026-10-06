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
  const guidance = reviewRequired ? merged ? 'This submission was merged into a formal file. Upload changes for review.'
    : 'Changes to formal files must be uploaded and reviewed on the web.' : undefined;
  if (merged) return decision('UNKNOWN', 'The original submission cannot be compared with its formal replacement.', 'KEEP_SERVER', guidance);
  if (!conflict.fileEntryId) return decision('NEW_FILE', 'This is an unsubmitted local file.', 'SAVE_AS_NEW');
  if (!serverFile) return decision('UNKNOWN', 'Current server details are unavailable. Compare the files before deciding.',
    reviewRequired ? 'KEEP_SERVER' : undefined, guidance);
  const localBase = conflict.localBaseRevision;
  if (conflict.change.kind === 'DELETE') return decision('LOCAL_DELETE',
    localBase === serverFile.revision ? 'The local file was deleted; the server still has the base revision.'
      : 'The server revision advanced; the local change deletes the file.',
    localBase === serverFile.revision ? 'ACCEPT_LOCAL' : 'KEEP_SERVER', guidance);
  if (conflict.change.kind === 'RENAME') return decision('RENAME',
    localBase === serverFile.revision ? 'The server still has the base revision; the local change renames the file.'
      : 'The server revision advanced; the local change renames the file.', reviewRequired ? 'KEEP_SERVER'
      : localBase === serverFile.revision ? 'ACCEPT_LOCAL' : undefined, guidance);
  const version = serverFile.currentVersion;
  if (!version) return decision('UNKNOWN', 'Current server details are unavailable. Compare the files before deciding.',
    reviewRequired ? 'KEEP_SERVER' : undefined, guidance);
  if (/^[0-9a-f]{64}$/i.test(conflict.change.sha256) && conflict.change.sha256.toLowerCase() === version.sha256.toLowerCase()
    && conflict.change.sizeBytes === version.sizeBytes) return decision('IDENTICAL', 'Both versions contain identical bytes.', 'KEEP_SERVER', guidance);
  if (localBase === serverFile.revision) return decision('LOCAL_CHANGED',
    'The server still has the base revision; the local content differs.', reviewRequired ? 'KEEP_SERVER' : 'ACCEPT_LOCAL', guidance);
  if (localBase !== null && serverFile.revision > localBase) return decision('DIVERGED',
    'The server revision advanced and the local content differs. Their editing order is unknown.',
    reviewRequired ? 'KEEP_SERVER' : 'SAVE_AS_NEW', reviewRequired ? guidance : 'Save a new file to retain both versions.');
  return decision('UNKNOWN', 'The version relationship is unknown. Compare the files before deciding.',
    reviewRequired ? 'KEEP_SERVER' : undefined, guidance);
}

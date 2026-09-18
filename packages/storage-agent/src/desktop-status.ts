import type {StorageAgentFileStatus, StorageAgentTask} from '@quorum/contracts';
import type {AgentDirectoryState} from './state.js';
import type {AgentActivity} from './runtime.js';

export interface DesktopFile {id: string; name: string; size: number; local: string; cache: string;
  bytes: number; total: number; progress: boolean; deleted: boolean}

export function desktopFiles(remote: StorageAgentFileStatus[], state: AgentDirectoryState,
  tasks: StorageAgentTask[], verified: Set<string>, activities: Map<string, AgentActivity>, fresh: boolean): DesktopFile[] {
  const rows = new Map<string, DesktopFile>();
  for (const file of remote) {
    const tracked = state.files[file.fileEntryId];
    const ready = Boolean(tracked && tracked.blobId === file.blobId && verified.has(file.fileEntryId));
    const deleted = file.status === 'DELETED';
    let local = deleted ? (tracked ? 'PENDING_DELETE' : 'DELETED') : ready
      ? ({DELETED: 'DELETED', UPLOAD_COMPLETE: 'READY_UNSUBMITTED', PENDING_REVIEW: 'READY_REVIEW', PUBLISHED: 'READY_PUBLISHED', REJECTED: 'READY_REJECTED'}[file.status] ?? 'UNKNOWN')
      : tracked ? 'LOCAL_CHANGED' : 'PENDING_DOWNLOAD';
    let cache = !fresh ? 'UNKNOWN' : file.cacheState === 'READY' || file.cacheState === 'REVIEW_PINNED'
      ? 'CACHE_READY' : file.cacheState === 'FETCHING' ? 'PENDING_REFILL' : file.cacheState === 'FAILED' ? 'REFILL_FAILED'
      : file.cacheState === 'MISSING' || file.cacheState === 'EVICTING'
        ? ready ? 'CACHE_MISSING_LOCAL_READY' : 'CACHE_MISSING' : 'UNKNOWN';
    if (deleted) cache = '—';
    if (!fresh && ready && !deleted) local = 'LOCAL_READY_REVIEW_UNKNOWN';
    rows.set(file.fileEntryId, {id: file.fileEntryId, name: file.logicalName, size: file.sizeBytes,
      local, cache, bytes: 0, total: 0, progress: false, deleted});
  }
  for (const pending of Object.values(state.pendingUploads)) {
    const row = rows.get(pending.fileEntryId) ?? {id: pending.fileEntryId, name: pending.relativePath,
      size: pending.sizeBytes, local: '', cache: 'UNKNOWN', bytes: 0, total: 0, progress: false, deleted: false};
    row.local = 'PENDING_UPLOAD'; rows.set(row.id, row);
  }
  for (const task of [...tasks].filter(task => !tasks.some(other => other.fileEntryId === task.fileEntryId
    && other.type === task.type && other.blobId === task.blobId && other.sequence > task.sequence))
    .sort((a, b) => a.sequence - b.sequence)) {
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') continue;
    let row = rows.get(task.fileEntryId);
    if (!row) {row = {id: task.fileEntryId, name: task.logicalName ?? task.fileEntryId,
      size: task.expectedSizeBytes ?? 0, local: 'PENDING_DOWNLOAD', cache: 'UNKNOWN', bytes: 0, total: 0, progress: false, deleted: false}; rows.set(row.id, row);}
    const file = remote.find(f => f.fileEntryId === task.fileEntryId);
    if (file?.status === 'DELETED' && task.type !== 'DELETE_FILE') continue;
    if (file?.blobId && task.blobId && file.blobId !== task.blobId && task.type !== 'UPLOAD_BLOB') continue;
    const failed = task.status === 'FAILED';
    if (task.type === 'FETCH_BLOB_TO_CACHE') {if (fresh) row.cache = failed ? 'REFILL_FAILED' : 'PENDING_REFILL';}
    else row.local = failed ? 'FAILED' : task.status === 'RETRY' ? 'RETRYING' : task.type === 'DELETE_FILE' ? 'PENDING_DELETE'
      : task.type === 'UPLOAD_BLOB' ? 'PENDING_UPLOAD' : 'PENDING_DOWNLOAD';
  }
  for (const activity of activities.values()) {
    let row = rows.get(activity.fileEntryId);
    if (!row) {row = {id: activity.fileEntryId, name: activity.name ?? activity.fileEntryId, size: activity.total,
      local: 'UNCONFIRMED', cache: 'UNKNOWN', bytes: 0, total: 0, progress: false, deleted: false}; rows.set(row.id, row);}
    if (activity.phase === 'complete') continue;
    const refill = activity.type === 'FETCH_BLOB_TO_CACHE';
    if (activity.phase === 'failed') {if (refill) row.cache = 'REFILL_FAILED'; else row.local = 'RETRYING'; continue;}
    if (refill) row.cache = activity.phase === 'verify' ? 'REFILL_VERIFYING' : 'REFILLING';
    else row.local = activity.phase === 'verify' ? 'VERIFYING' : activity.type === 'UPLOAD_BLOB' ? 'UPLOADING'
      : activity.type === 'DELETE_FILE' ? 'PENDING_DELETE' : 'DOWNLOADING';
    row.bytes = activity.bytes; row.total = activity.total; row.progress = activity.type !== 'DELETE_FILE';
  }
  for (const conflict of Object.values(state.conflicts)) {
    const id = conflict.change.fileEntryId;
    const row = id ? rows.get(id) : [...rows.values()].find(row => row.name === conflict.relativePath);
    if (row) row.local = 'CONFLICT';
    else rows.set(id ?? conflict.conflictId, {id: id ?? conflict.conflictId, name: conflict.relativePath,
      size: conflict.change.kind === 'UPSERT' ? conflict.change.sizeBytes : 0,
      local: 'CONFLICT', cache: 'UNKNOWN', bytes: 0, total: 0, progress: false, deleted: false});
  }
  return [...rows.values()].sort((a,b) => Number(a.deleted)-Number(b.deleted) || a.name.localeCompare(b.name));
}

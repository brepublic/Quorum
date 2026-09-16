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
    let local = deleted ? (tracked ? '待删除' : '已删除') : ready
      ? ({DELETED: '已删除', UPLOAD_COMPLETE: '已就绪 - 未提交审核', PENDING_REVIEW: '已就绪 - 待审核', PUBLISHED: '已就绪 - 公开可见', REJECTED: '已就绪 - 已驳回'}[file.status] ?? '状态未知')
      : tracked ? '本地变化待同步' : '待下载';
    let cache = !fresh ? '状态未知' : file.cacheState === 'READY' || file.cacheState === 'REVIEW_PINNED'
      ? '服务器缓存可用' : file.cacheState === 'FETCHING' ? '等待回传' : file.cacheState === 'FAILED' ? '回传失败'
      : file.cacheState === 'MISSING' || file.cacheState === 'EVICTING'
        ? ready ? '服务器无缓存 · 本地可用' : '服务器无缓存' : '状态未知';
    if (deleted) cache = '—';
    if (!fresh && ready && !deleted) local = '本地已保存 · 审核状态未知';
    rows.set(file.fileEntryId, {id: file.fileEntryId, name: file.logicalName, size: file.sizeBytes,
      local, cache, bytes: 0, total: 0, progress: false, deleted});
  }
  for (const pending of Object.values(state.pendingUploads)) {
    const row = rows.get(pending.fileEntryId) ?? {id: pending.fileEntryId, name: pending.relativePath,
      size: pending.sizeBytes, local: '', cache: '状态未知', bytes: 0, total: 0, progress: false, deleted: false};
    row.local = '待上传'; rows.set(row.id, row);
  }
  for (const task of [...tasks].filter(task => !tasks.some(other => other.fileEntryId === task.fileEntryId
    && other.type === task.type && other.blobId === task.blobId && other.sequence > task.sequence))
    .sort((a, b) => a.sequence - b.sequence)) {
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') continue;
    let row = rows.get(task.fileEntryId);
    if (!row) {row = {id: task.fileEntryId, name: task.logicalName ?? task.fileEntryId,
      size: task.expectedSizeBytes ?? 0, local: '待下载', cache: '状态未知', bytes: 0, total: 0, progress: false, deleted: false}; rows.set(row.id, row);}
    const file = remote.find(f => f.fileEntryId === task.fileEntryId);
    if (file?.status === 'DELETED' && task.type !== 'DELETE_FILE') continue;
    if (file?.blobId && task.blobId && file.blobId !== task.blobId && task.type !== 'UPLOAD_BLOB') continue;
    const failed = task.status === 'FAILED';
    if (task.type === 'FETCH_BLOB_TO_CACHE') {if (fresh) row.cache = failed ? '回传失败' : '等待回传';}
    else row.local = failed ? '失败' : task.status === 'RETRY' ? '等待重试' : task.type === 'DELETE_FILE' ? '待删除'
      : task.type === 'UPLOAD_BLOB' ? '待上传' : '待下载';
  }
  for (const activity of activities.values()) {
    let row = rows.get(activity.fileEntryId);
    if (!row) {row = {id: activity.fileEntryId, name: activity.name ?? activity.fileEntryId, size: activity.total,
      local: '状态待确认', cache: '状态未知', bytes: 0, total: 0, progress: false, deleted: false}; rows.set(row.id, row);}
    if (activity.phase === 'complete') continue;
    const refill = activity.type === 'FETCH_BLOB_TO_CACHE';
    if (activity.phase === 'failed') {if (refill) row.cache = '回传失败'; else row.local = '等待重试'; continue;}
    if (refill) row.cache = activity.phase === 'verify' ? '回传校验中' : '正在回传';
    else row.local = activity.phase === 'verify' ? '校验中' : activity.type === 'UPLOAD_BLOB' ? '上传中'
      : activity.type === 'DELETE_FILE' ? '待删除' : '下载中';
    row.bytes = activity.bytes; row.total = activity.total; row.progress = activity.type !== 'DELETE_FILE';
  }
  for (const conflict of Object.values(state.conflicts)) {
    const id = conflict.change.fileEntryId;
    const row = id ? rows.get(id) : [...rows.values()].find(row => row.name === conflict.relativePath);
    if (row) row.local = '存在冲突';
    else rows.set(id ?? conflict.conflictId, {id: id ?? conflict.conflictId, name: conflict.relativePath,
      size: conflict.change.kind === 'UPSERT' ? conflict.change.sizeBytes : 0,
      local: '存在冲突', cache: '状态未知', bytes: 0, total: 0, progress: false, deleted: false});
  }
  return [...rows.values()].sort((a,b) => Number(a.deleted)-Number(b.deleted) || a.name.localeCompare(b.name));
}

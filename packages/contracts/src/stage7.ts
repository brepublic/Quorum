export const STORAGE_HOST_STATUSES = ['ACTIVE', 'DEGRADED', 'REVOKED'] as const;
export type StorageHostStatus = typeof STORAGE_HOST_STATUSES[number];

export const STORAGE_PAIRING_PURPOSES = ['INITIAL', 'TRANSFER'] as const;
export type StoragePairingPurpose = typeof STORAGE_PAIRING_PURPOSES[number];

export interface StorageHost {
  id: string;
  committeeId: string;
  deviceId: string;
  deviceLabel: string;
  leaseGeneration: number;
  status: StorageHostStatus;
  revision: number;
  lastSeenAt: string | null;
  pairedAt: string;
  revokedAt: string | null;
}

export interface StoragePairingCode {
  code: string;
  purpose: StoragePairingPurpose;
  expiresAt: string;
}

export interface StorageAgentPairingResult {
  credential: string;
  host: StorageHost;
}

export interface StorageAgentIdentity {
  hostId: string;
  committeeId: string;
  deviceId: string;
  leaseGeneration: number;
}

export const STORAGE_AGENT_TASK_TYPES = ['STORE_BLOB', 'UPLOAD_BLOB', 'DELETE_FILE'] as const;
export type StorageAgentTaskType = typeof STORAGE_AGENT_TASK_TYPES[number];

export const STORAGE_AGENT_TASK_STATUSES = [
  'PENDING', 'IN_PROGRESS', 'RETRY', 'COMPLETED', 'FAILED', 'CANCELLED'
] as const;
export type StorageAgentTaskStatus = typeof STORAGE_AGENT_TASK_STATUSES[number];

export interface StorageAgentTask {
  id: string;
  committeeId: string;
  sequence: number;
  type: StorageAgentTaskType;
  fileEntryId: string;
  fileRevision: number;
  blobId: string | null;
  expectedSizeBytes: number | null;
  expectedSha256: string | null;
  contentState: 'NONE' | 'RECEIVING' | 'STAGED';
  receivedSizeBytes: number | null;
  actualSha256: string | null;
  leaseGeneration: number;
  status: StorageAgentTaskStatus;
  revision: number;
  attempts: number;
  claimToken: string | null;
  failureCode: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageAgentTaskPage {
  tasks: StorageAgentTask[];
  nextSequence: number;
  hasMore: boolean;
}

export type StorageManifestEvent = {
  sequence: number;
  kind: 'UPSERT';
  fileEntryId: string;
  fileRevision: number;
  versionId: string;
  blobId: string;
  logicalName: string;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
} | {
  sequence: number;
  kind: 'DELETE';
  fileEntryId: string;
  fileRevision: number;
  deletedAt: string;
  createdAt: string;
};

export interface StorageManifestPage {
  events: StorageManifestEvent[];
  nextSequence: number;
  hasMore: boolean;
}

export type StorageAgentLocalChange = {
  kind: 'UPSERT';
  fileEntryId?: string;
  baseRevision?: number;
  logicalName: string;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
} | {
  kind: 'RENAME';
  fileEntryId: string;
  baseRevision: number;
  logicalName: string;
} | {
  kind: 'DELETE';
  fileEntryId: string;
  baseRevision: number;
};

export type StorageAgentLocalChangeResult = {
  status: 'PENDING_CONTENT';
  changeRequestId: string;
  task: StorageAgentTask;
} | {
  status: 'COMPLETED';
  changeRequestId: string;
  fileEntryId: string;
  fileRevision: number;
} | {
  status: 'CONFLICT';
  changeRequestId: string;
  conflictId: string;
  reasonCode: 'MANIFEST_STALE' | 'FILE_DELETED' | 'REVISION_CONFLICT' | 'NAME_CONFLICT' | 'HOST_TRANSFERRED';
};

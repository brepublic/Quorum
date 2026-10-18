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
  agentProtocolVersion: number | null;
  capabilities: import('./storage-cache.js').StorageAgentCapability[];
}

export interface StoragePairingCode {
  code: string;
  purpose: StoragePairingPurpose;
  expiresAt: string;
}

export interface StoragePairingSetup extends StoragePairingCode {
  configuration: import('./agent-pairing.js').AgentPairingConfig;
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

export const STORAGE_AGENT_TASK_TYPES = [
  'STORE_BLOB', 'HOST_COMMIT_BLOB', 'UPLOAD_BLOB', 'DELETE_FILE', 'FETCH_BLOB_TO_CACHE',
  'MIGRATE_BLOB', 'VERIFY_MIGRATION_BLOB', 'DELETE_MIGRATION_BLOB'
] as const;
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
  logicalName: string | null;
  contentState: 'NONE' | 'RECEIVING' | 'STAGED';
  receivedSizeBytes: number | null;
  actualSha256: string | null;
  leaseGeneration: number;
  status: StorageAgentTaskStatus;
  revision: number;
  attempts: number;
  claimToken: string | null;
  failureCode: string | null;
  resolutionConflictId: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  localBlobId?: string | null;
}

export const STORAGE_AGENT_CONFLICT_REASONS = [
  'MANIFEST_STALE', 'FILE_DELETED', 'REVISION_CONFLICT', 'NAME_CONFLICT', 'HOST_TRANSFERRED', 'REVIEW_REQUIRED'
] as const;
export type StorageAgentConflictReason = typeof STORAGE_AGENT_CONFLICT_REASONS[number];
export const STORAGE_AGENT_CONFLICT_RESOLUTIONS = ['KEEP_SERVER', 'ACCEPT_LOCAL', 'SAVE_AS_NEW'] as const;
export type StorageAgentConflictResolution = typeof STORAGE_AGENT_CONFLICT_RESOLUTIONS[number];

export interface StorageAgentConflictServerFile {
  id: string;
  revision: number;
  status: import('./stage6.js').FileEntryStatus;
  logicalName: string;
  mergedIntoFileEntryId: string | null;
  publishedAt: string | null;
  updatedAt: string;
  currentVersion: {id: string; sha256: string; sizeBytes: number; createdAt: string} | null;
}

export interface StorageAgentConflict {
  // Present on the authorized browser list; original detection revisions remain unchanged.
  serverFile?: StorageAgentConflictServerFile | null;
  id: string;
  committeeId: string;
  hostId: string;
  fileEntryId: string | null;
  serverRevision: number | null;
  localBaseRevision: number | null;
  reasonCode: StorageAgentConflictReason;
  status: 'PENDING' | 'RESOLVED';
  revision: number;
  change: StorageAgentLocalChange;
  resolutionAction: StorageAgentConflictResolution | null;
  resolutionLogicalName: string | null;
  resolutionLeaseGeneration: number | null;
  resolutionFileRevision: number | null;
  createdAt: string;
  resolvedAt: string | null;
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
  reasonCode: StorageAgentConflictReason;
};

/** Read-only desktop view, scoped to the authenticated current storage host. */
export interface StorageAgentFileStatus {
  fileEntryId: string;
  logicalName: string;
  fileRevision: number;
  blobId: string | null;
  sizeBytes: number;
  status: 'UPLOAD_COMPLETE' | 'PENDING_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'DELETED';
  cacheState: import('./storage-cache.js').StorageCacheState | null;
  updatedAt: string;
}
export interface StorageAgentFileStatusPage {
  migration?: import('./stage6.js').StorageMigration | null;
  committee?: {name: string; status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETING';
    storageProvider: 'SERVER_VOLUME' | 'S3_COMPATIBLE' | 'CHAIR_AGENT' | null};
  files: StorageAgentFileStatus[];
  nextId: string | null;
  observedAt: string;
}

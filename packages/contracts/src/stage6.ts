export const STORAGE_PROVIDER_TYPES = ['SERVER_VOLUME', 'CHAIR_AGENT', 'S3_COMPATIBLE'] as const;
export type StorageProviderType = typeof STORAGE_PROVIDER_TYPES[number];

export const STORAGE_BINDING_STATUSES = ['PENDING', 'ACTIVE', 'MIGRATING', 'FAILED', 'RETIRED'] as const;
export type StorageBindingStatus = typeof STORAGE_BINDING_STATUSES[number];

export const FILE_ENTRY_STATUSES = ['UPLOAD_COMPLETE', 'PENDING_REVIEW', 'PUBLISHED', 'DELETED'] as const;
export type FileEntryStatus = typeof FILE_ENTRY_STATUSES[number];

export const FILE_BLOB_DURABILITY_STATES = ['COMMITTED', 'DELETE_PENDING', 'DELETED', 'FAILED'] as const;
export type FileBlobDurabilityState = typeof FILE_BLOB_DURABILITY_STATES[number];

export const FILE_UPLOAD_STATUSES = ['CREATED', 'RECEIVING', 'STAGED', 'COMMITTED', 'CANCELLED', 'FAILED'] as const;
export type FileUploadStatus = typeof FILE_UPLOAD_STATUSES[number];

export interface StorageBinding {
  id: string;
  committeeId: string;
  providerType: StorageProviderType;
  providerConfigId: string | null;
  storageHostId: string | null;
  status: StorageBindingStatus;
  revision: number;
  createdAt: string;
}

export interface S3ProviderConfigSummary {
  id: string;
  displayName: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  allowPrivateNetwork: boolean;
  status: 'ACTIVE' | 'DISABLED';
  credentialKeyVersion: number;
  verifiedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileVersion {
  id: string;
  versionNumber: number;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  blobId: string;
  createdAt: string;
}

export interface FileEntry {
  id: string;
  committeeId: string;
  logicalName: string;
  mediaType: string;
  status: FileEntryStatus;
  syncState: 'PENDING_HOST_COMMIT' | 'SYNCED' | 'OUT_OF_SYNC';
  createdByUserId: string;
  currentVersion: FileVersion;
  revision: number;
  submittedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileBlobDeleteJob {
  id: string;
  fileEntryId: string;
  blobId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'RETRY' | 'COMPLETED';
  attempts: number;
  nextAttemptAt: string;
  failureCode: string | null;
}

export type StorageMigrationStatus = 'COPYING' | 'READY_TO_CONFIRM' | 'FAILED' | 'COMPLETED' | 'CANCELLED';

export interface StorageMigration {
  id: string;
  committeeId: string;
  sourceBindingId: string;
  targetBindingId: string;
  status: StorageMigrationStatus;
  manifestRevision: number;
  revision: number;
  totalItems: number;
  completedItems: number;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageMigrationItem {
  id: string;
  migrationId: string;
  contentBlobId: string;
  targetBlobId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'RETRY' | 'COMPLETED' | 'CANCELLED';
  attempts: number;
  failureCode: string | null;
}

export interface FileTombstone {
  id: string;
  fileEntryId: string;
  committeeId: string;
  lastContentRevision: number;
  deletedAt: string;
}

export interface FileUpload {
  id: string;
  committeeId: string;
  storageBindingId: string;
  logicalName: string;
  originalName: string;
  mediaType: string;
  expectedSizeBytes: number;
  receivedSizeBytes: number;
  expectedSha256: string;
  actualSha256: string | null;
  status: FileUploadStatus;
  revision: number;
  expiresAt: string;
  failureCode: string | null;
  committedFileEntryId: string | null;
  agentCommitState: 'PENDING_HOST_COMMIT' | 'HOST_COMMITTED' | 'CONFLICT' | null;
  agentTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingHostCommit {
  kind: 'PENDING_HOST_COMMIT';
  upload: FileUpload;
  taskId: string;
  leaseGeneration: number;
}

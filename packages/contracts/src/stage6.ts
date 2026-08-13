export const STORAGE_PROVIDER_TYPES = ['SERVER_VOLUME', 'S3_COMPATIBLE'] as const;
export type StorageProviderType = typeof STORAGE_PROVIDER_TYPES[number];

export const STORAGE_BINDING_STATUSES = ['PENDING', 'ACTIVE', 'MIGRATING', 'FAILED', 'RETIRED'] as const;
export type StorageBindingStatus = typeof STORAGE_BINDING_STATUSES[number];

export const FILE_ENTRY_STATUSES = ['UPLOAD_COMPLETE', 'PENDING_REVIEW', 'PUBLISHED', 'DELETED'] as const;
export type FileEntryStatus = typeof FILE_ENTRY_STATUSES[number];

export const FILE_BLOB_DURABILITY_STATES = ['COMMITTED', 'DELETE_PENDING', 'DELETED', 'FAILED'] as const;
export type FileBlobDurabilityState = typeof FILE_BLOB_DURABILITY_STATES[number];

export interface StorageBinding {
  id: string;
  committeeId: string;
  providerType: StorageProviderType;
  providerConfigId: string | null;
  status: StorageBindingStatus;
  revision: number;
  createdAt: string;
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
  currentVersion: FileVersion;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileTombstone {
  id: string;
  fileEntryId: string;
  committeeId: string;
  lastContentRevision: number;
  deletedAt: string;
}

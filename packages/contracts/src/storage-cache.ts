export const STORAGE_CACHE_STATES = [
  'REVIEW_PINNED', 'READY', 'MISSING', 'FETCHING', 'EVICTING', 'FAILED'
] as const;
export type StorageCacheState = typeof STORAGE_CACHE_STATES[number];

export const STORAGE_AGENT_CAPABILITIES = ['SSE_WAKE', 'CACHE_REFILL'] as const;
export type StorageAgentCapability = typeof STORAGE_AGENT_CAPABILITIES[number];

export interface StorageCacheConfig {
  publishedCacheMaxBytes: number;
  pendingReviewMaxBytes: number;
  pendingReviewCommitteeMaxBytes: number;
  storageMinFreeBytes: number;
  storageMinFreePercent: number;
  revision: number;
}

export interface StorageCacheHardLimits extends Omit<StorageCacheConfig, 'revision'> {}

export interface EffectiveStorageCacheConfig extends StorageCacheConfig {
  hardLimits: StorageCacheHardLimits;
}

export const DOWNLOAD_PREPARATION_CODES = [
  'DOWNLOAD_PREPARING', 'STORAGE_AGENT_OFFLINE', 'STORAGE_AGENT_UPGRADE_REQUIRED',
  'STORAGE_AGENT_SOURCE_MISSING', 'STORAGE_CACHE_CAPACITY_UNAVAILABLE'
] as const;
export type DownloadPreparationCode = typeof DOWNLOAD_PREPARATION_CODES[number];

export interface DownloadReadiness {
  status: 'READY' | 'PREPARING' | 'UNAVAILABLE';
  code?: DownloadPreparationCode;
  retryAfterSeconds?: number;
}

export interface StorageCacheFileSummary {
  id: string;
  committeeId: string;
  committeeName: string;
  fileEntryId: string;
  fileName: string;
  sizeBytes: number;
  state: StorageCacheState;
  cachedAt: string | null;
  lastAccessedAt: string | null;
}

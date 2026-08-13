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

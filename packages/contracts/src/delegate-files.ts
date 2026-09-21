import type {FlagSnapshot, LocalizedNames} from './stage4.js';

export const DELEGATE_FILE_TYPES = ['WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT'] as const;
export type DelegateFileType = typeof DELEGATE_FILE_TYPES[number];

export interface DelegateFileShare {
  id: string;
  committeeId: string;
  url: string;
  status: 'ACTIVE' | 'ENDED';
  revision: number;
  createdAt: string;
  endedAt: string | null;
}

export interface DelegatePublishedFile {
  submissionSource: 'DELEGATE_PORTAL' | 'CHAIR' | 'ACCOUNT' | 'LEGACY';
  id: string;
  logicalName: string;
  submitterDisplayName: string | null;
  fileType: DelegateFileType | null;
  submittedAt: string | null;
  publishedAt: string;
  revision: number;
}

export interface DelegateReviewFile extends DelegatePublishedFile {
  status: 'UPLOAD_COMPLETE' | 'PENDING_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'DELETED';
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  deleted?: boolean;
  suggestedNames?: Record<DelegateFileType, {sessionOrdinal: number; ordinal: number}>;
  submissionSource: 'DELEGATE_PORTAL' | 'CHAIR' | 'ACCOUNT' | 'LEGACY';
  originalName: string;
  sizeBytes: number;
}

export interface DelegatePortalBootstrap {
  committeeLanguage: import('./localization.js').ContentLanguage;
  committeeId: string;
  committeeName: string;
  shareId: string;
  claimedSeat: {id: string; displayName: string; flag?: FlagSnapshot} | null;
  eligibleSeats: Array<{id: string; displayName: string; flag: FlagSnapshot}>;
  mayUpload: boolean;
  storageAvailable: boolean;
  eventSequence: number;
  files: DelegatePublishedFile[];
  maxUploadSizeBytes: number;
  submissions?: DelegateReviewFile[];
  pendingUploads?: Array<{id: string; logicalName: string; status: 'SAVING' | 'FAILED'}>;
  allowedExtensions?: Record<DelegateFileType, string[]>;
}

export interface DelegatePortalClaimResult extends DelegatePortalBootstrap {
  sessionToken: string;
  csrfToken: string;
}

export interface DelegateFileAvailableEvent {
  id: number;
  fileId: string;
  submitterDisplayName: string;
  logicalName: string;
  publishedAt: string;
  kind?: 'available' | 'rejected';
  rejectionReason?: string | null;
}

export interface FileRejectionType {
  id: string;
  label: LocalizedNames;
  message: LocalizedNames;
  custom: boolean;
}
export interface DelegateFileSettings {
  rejectionTypes: FileRejectionType[];
  allowedExtensions: Record<DelegateFileType, string[]>;
  revision: number;
}
export interface DefaultFileRejectionSettings {
  rejectionTypes: FileRejectionType[];
  revision: number;
}

export function isAllowedDelegateFile(name: string, extensions: readonly string[]): boolean {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return Boolean(match && extensions.includes(match[1]!.toLowerCase()));
}

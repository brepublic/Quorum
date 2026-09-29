import type {FlagSnapshot, LocalizedNames} from './stage4.js';

export const DELEGATE_FILE_TYPES = ['WORKING_PAPER', 'DIRECTIVE_DRAFT', 'RESOLUTION_DRAFT', 'NEWS', 'CRISIS_NOTICE', 'INSTANT_MESSAGE'] as const;
export type StandardDelegateFileType = typeof DELEGATE_FILE_TYPES[number];
export type DelegateFileType = StandardDelegateFileType | `CUSTOM:${string}`;
export type DelegateFileExtensionType = StandardDelegateFileType | 'OTHER';
export const customDelegateFileType = (name: string): DelegateFileType => `CUSTOM:${name}`;
export const isCustomDelegateFileType = (type: DelegateFileType): type is `CUSTOM:${string}` => type.startsWith('CUSTOM:');

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
  publishedFileId?: string;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  deleted?: boolean;
  suggestedNames?: Record<string, {sessionOrdinal: number; ordinal: number}>;
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
  eligibleSeats: Array<{id: string; displayName: string; flag: FlagSnapshot; searchTerms?: string[]}>;
  mayUpload: boolean;
  storageAvailable: boolean;
  eventSequence: number;
  files: DelegatePublishedFile[];
  maxUploadSizeBytes: number;
  submissions?: DelegateReviewFile[];
  pendingUploads?: Array<{id: string; logicalName: string; status: 'SAVING' | 'FAILED'}>;
  allowedExtensions?: Record<DelegateFileExtensionType, string[]>;
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
  publishedFileId?: string;
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
  allowedExtensions: Record<DelegateFileExtensionType, string[]>;
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

export interface FileApprovalPreview {
  logicalName: string;
  confirmationToken: string | null;
  target: {id: string; revision: number; logicalName: string} | null;
}

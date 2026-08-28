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
  id: string;
  logicalName: string;
  submitterDisplayName: string | null;
  fileType: DelegateFileType | null;
  submittedAt: string | null;
  publishedAt: string;
  revision: number;
}

export interface DelegateReviewFile extends DelegatePublishedFile {
  status: 'UPLOAD_COMPLETE' | 'PENDING_REVIEW' | 'PUBLISHED';
  submissionSource: 'DELEGATE_PORTAL' | 'CHAIR' | 'ACCOUNT' | 'LEGACY';
  originalName: string;
  sizeBytes: number;
}

export interface DelegatePortalBootstrap {
  committeeId: string;
  committeeName: string;
  shareId: string;
  claimedSeat: {id: string; displayName: string} | null;
  eligibleSeats: Array<{id: string; displayName: string}>;
  mayUpload: boolean;
  chairHostHealthy: boolean;
  eventSequence: number;
  files: DelegatePublishedFile[];
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
}

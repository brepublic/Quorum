export type CommitteeDeletionStatus = 'PENDING' | 'IN_PROGRESS' | 'RETRY' | 'COMPLETED';

export interface RequestCommitteeDeletion {
  baseRevision: number;
  confirmationName: string;
}

export interface CommitteeDeletionJob {
  id: string;
  committeeId: string;
  status: CommitteeDeletionStatus;
  requestedAt: string;
  completedAt: string | null;
  failureCode: string | null;
}

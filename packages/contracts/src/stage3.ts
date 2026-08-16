export type CommitteeVisibility = 'PUBLIC' | 'PRIVATE';
export type CommitteeOperationMode = 'DELEGATE_OPERATED' | 'CHAIR_OPERATED';
export type CommitteeStatus = 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'DELETING';
export type RulePackageScope = 'BUILTIN' | 'SYSTEM' | 'COMMITTEE';
export type RuleVersionStatus = 'DRAFT' | 'PUBLISHED';

export interface CreateCommitteeRequest {
  name: string;
  visibility: CommitteeVisibility;
  operationMode?: CommitteeOperationMode;
  activeRulePackageVersionId?: string;
}
export interface CommitteeRevisionRequest {baseRevision: number}
export interface UpdateCommitteeRequest extends CommitteeRevisionRequest {
  patch: Partial<Pick<CommitteeSummary, 'name' | 'chairLabel' | 'topic' | 'conference' | 'visibility'>>;
}
export interface SetChairRequest extends CommitteeRevisionRequest {email: string}
export interface SetOperationModeRequest extends CommitteeRevisionRequest {operationMode: CommitteeOperationMode}
export interface CommitteeMotionSettings {
  delegateMotionProposalsEnabled: boolean;
  delegateMotionVotingEnabled: boolean;
}
export interface SetCommitteeMotionSettingsRequest extends CommitteeRevisionRequest {
  settings: CommitteeMotionSettings;
}
export interface SetCommitteeStatusRequest extends CommitteeRevisionRequest {status: 'ACTIVE' | 'PAUSED'}
export interface CreateSeatRequest {
  stableKey: string; displayName: string; rank?: string; canVote?: boolean; hasVeto?: boolean; sortOrder?: number;
}
export type SeatAssignmentRequest = {seatId: string; email: string} | {action: 'END'; assignmentId: string};
export interface CreateSeatInvitationRequest {seatId: string; maxUses: number; expiresAt: string}
export interface RedeemSeatInvitationRequest {code: string}
export interface ImportRulePackageRequest {
  scope: Exclude<RulePackageScope, 'BUILTIN'>;
  committeeId?: string;
  definition: Record<string, unknown>;
}
export interface CreateRuleVersionRequest {definition: Record<string, unknown>; publish: boolean}
export interface ActivateRulesRequest extends CommitteeRevisionRequest {rulePackageVersionId: string}
export type ChairRuleOverrideRequest =
  | {scope: 'ONCE'; path: string; value: unknown; operationKey: string}
  | {scope: 'FUTURE'; path: string; value: unknown};

export interface CommitteeSummary {
  id: string;
  ownerUserId?: string;
  name: string;
  chairLabel: string;
  topic: string;
  conference: string;
  visibility: CommitteeVisibility;
  operationMode: CommitteeOperationMode;
  status: CommitteeStatus;
  activeRulePackageVersionId: string;
  revision: number;
}

export interface CommitteeSeat {
  id: string;
  stableKey: string;
  displayName: string;
  rank: string | null;
  canVote: boolean;
  hasVeto: boolean;
  sortOrder: number;
  active: boolean;
  revision: number;
}

export interface CommitteeSnapshot {
  schemaVersion: 1;
  committee: CommitteeSummary;
  seats: CommitteeSeat[];
  viewer: {audience: 'PUBLIC' | 'MEMBER' | 'CHAIR' | 'OWNER'; seatId: string | null};
  memberships?: Array<{userEmail: string | null; status: string}>;
  chairs?: Array<{userEmail: string}>;
  assignments?: Array<{id: string; seatId: string; userEmail: string | null; status: string}>;
  sync: {committeeEventSequence: number};
}

export interface RulePackageVersionSummary {
  id: string;
  version: number;
  status: RuleVersionStatus;
  schemaVersion: number;
  definition?: Record<string, unknown>;
  publishedAt: string | null;
}

export interface RulePackageSummary {
  id: string;
  scope: RulePackageScope;
  key: string;
  committeeId: string | null;
  versions: RulePackageVersionSummary[];
}

export interface RuleValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface RuleValidationResult {valid: boolean; issues: RuleValidationIssue[]}
export interface RuleSimulationResult {
  values: Record<string, unknown>;
  plannedEffects: Array<Record<string, unknown>>;
  steps: number;
}

export interface FrozenRuleEvaluation {
  schemaVersion: 1;
  packageVersionId: string;
  definition: Record<string, unknown>;
  facts: Record<string, unknown>;
  resolvedValues: Record<string, unknown>;
  frozenAt: string;
}

export function freezeRuleEvaluation(input: Omit<FrozenRuleEvaluation, 'schemaVersion'>): FrozenRuleEvaluation {
  return structuredClone({schemaVersion: 1 as const, ...input});
}

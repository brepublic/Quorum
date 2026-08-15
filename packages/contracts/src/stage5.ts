import type {CommitteeEventName, EventAudience} from './registry.js';
import type {FrozenRuleEvaluation} from './stage3.js';

export type RealtimeSyncState = 'LIVE' | 'DEGRADED' | 'OFFLINE_READONLY' | 'RESYNCING';

export interface CommitteeEventEnvelope {
  id: number;
  type: CommitteeEventName | string;
  committeeId: string;
  resourceType: string | null;
  resourceId: string | null;
  resourceRevision: number | null;
  audience: EventAudience;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const COMMITTEE_EVENT_SCHEMA_VERSION = 1 as const;

export type TimerOwnerType = 'COMMITTEE' | 'SPEAKER_LIST' | 'CAUCUS' | 'SPEECH';

export interface AuthoritativeTimer {
  id: string;
  committeeId: string;
  ownerType: TimerOwnerType;
  ownerId: string;
  running: boolean;
  startedAt: string | null;
  remainingAtStartMs: number;
  remainingMs: number;
  revision: number;
  expiredAt: string | null;
  serverTime: string;
}

export type SpeakerListKind = 'GENERAL' | 'MODERATED_CAUCUS';
export type SpeakerListStatus = 'OPEN' | 'CLOSED';
export type SpeakerQueueStatus = 'QUEUED' | 'CURRENT' | 'COMPLETED' | 'SKIPPED';
export type SpeakerStance = 'FOR' | 'NEUTRAL' | 'AGAINST';

export interface SpeakerQueueEntry {
  id: string;
  seatId: string;
  seatDisplayName: string;
  position: number;
  status: SpeakerQueueStatus;
  stance: SpeakerStance;
  speechDurationMs: number;
  createdAt: string;
}

export interface SpeakerList {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  kind: SpeakerListKind;
  status: SpeakerListStatus;
  name: string;
  topic: string;
  defaultSpeechMs: number;
  delegatesCanQueue: boolean;
  rulePackageVersionId: string;
  currentEntryId: string | null;
  speechTimerId: string;
  totalTimerId: string | null;
  linkedResolutionId: string | null;
  revision: number;
  queue: SpeakerQueueEntry[];
  createdAt: string;
  closedAt: string | null;
  speeches?: SpeechRecord[];
}

export type SpeechKind = 'ORIGINAL' | 'INHERITED';
export type SpeechStatus = 'READY' | 'RUNNING' | 'PAUSED' | 'COMPLETED';
export type YieldType = 'CHAIR' | 'SEAT' | 'QUESTIONS' | 'COMMENTS';
export type SpeechYieldDecisionStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface SpeechActionRecord {
  id: string;
  action: 'STARTED' | 'PAUSED' | 'RESUMED' | 'COMPLETED' | 'YIELDED' | 'YIELD_OFFERED'
    | 'YIELD_ACCEPTED' | 'YIELD_REJECTED' | 'QUESTION_RECORDED' | 'COMMENT_RECORDED';
  remainingMs: number;
  targetType: YieldType | null;
  targetSeatId: string | null;
  createdAt: string;
}

export interface SpeechContribution {
  id: string;
  type: 'QUESTION' | 'COMMENT';
  seatId: string;
  seatDisplayName: string;
  content: string;
  createdAt: string;
}

export interface SpeechRecord {
  id: string;
  speakerListId: string;
  queueEntryId: string;
  seatId: string;
  seatDisplayName: string;
  kind: SpeechKind;
  status: SpeechStatus;
  inheritedFromSpeechId: string | null;
  inheritedTimeMs: number | null;
  canYield: boolean;
  yieldType: YieldType | null;
  yieldTargetSeatId: string | null;
  yieldDecisionStatus: SpeechYieldDecisionStatus | null;
  interactionTargetSeatId: string | null;
  revision: number;
  startedAt: string | null;
  endedAt: string | null;
  actions: SpeechActionRecord[];
  contributions: SpeechContribution[];
}

export type MotionStatus = 'PENDING' | 'SECONDED' | 'VOTING' | 'PASSED' | 'FAILED' | 'WITHDRAWN' | 'SUPERSEDED';
export type BallotChoice = 'FOR' | 'AGAINST' | 'ABSTAIN';

export interface MotionSecond {
  id: string;
  seatId: string;
  seatDisplayName: string;
  createdAt: string;
}

export interface MotionDirectVote {
  id: string;
  seatId: string;
  seatDisplayName: string;
  choice: BallotChoice;
  revision: number;
  castAt: string;
}

export interface MotionDirectVoteState {
  includeNonVotingSeats: boolean;
  startedAt: string | null;
  settingsRevision: number;
  eligibility: Array<{seatId: string; seatDisplayName: string}>;
  choices: BallotChoice[];
  threshold: number;
  automaticResult: 'PASSED' | 'FAILED' | null;
  votes: MotionDirectVote[];
}

export interface ProceedingMotion {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  motionTypeId: string;
  proposedBySeatId: string;
  proposedBySeatDisplayName: string;
  parameters: Record<string, unknown>;
  status: MotionStatus;
  rulePackageVersionId: string;
  ruleEvaluation: FrozenRuleEvaluation;
  requiredSecondCount: number;
  seconds: MotionSecond[];
  directVote: MotionDirectVoteState;
  revision: number;
  createdAt: string;
  decidedAt: string | null;
  destinationPath: string | null;
}

export type BallotStatus = 'OPEN' | 'CLOSED' | 'PUBLISHED';

export interface BallotEligibilitySeat {
  seatId: string;
  seatDisplayName: string;
  mustVote: boolean;
  hasVeto: boolean;
}

export interface BallotVote {
  id: string;
  seatId: string;
  seatDisplayName: string;
  choice: BallotChoice;
  revision: number;
  castAt: string;
}

export interface FormalBallot {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  subjectType: 'MOTION' | 'RESOLUTION' | 'AMENDMENT';
  subjectId: string;
  status: BallotStatus;
  procedural: boolean;
  choices: BallotChoice[];
  rulePackageVersionId: string;
  ruleEvaluation: FrozenRuleEvaluation;
  eligibility: BallotEligibilitySeat[];
  threshold: {kind: 'SIMPLE_MAJORITY' | 'TWO_THIRDS'; value: number};
  votes: BallotVote[];
  result: {outcome: 'PASSED' | 'FAILED' | 'VETOED'; forCount: number; againstCount: number; abstainCount: number} | null;
  revision: number;
  openedAt: string;
  closedAt: string | null;
  publishedAt: string | null;
}

export type StrawpollVotingMode = 'ANONYMOUS' | 'SEAT_AUTHENTICATED';

export interface StrawpollOptionResult {
  id: string;
  label: string;
  sortOrder: number;
  voteCount: number;
}

export interface StrawpollSeatVote {
  id: string;
  seatId: string;
  optionIds: string[];
  revision: number;
  castAt: string;
}

export interface Strawpoll {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  question: string;
  votingMode: StrawpollVotingMode;
  multipleChoice: boolean;
  status: 'OPEN' | 'CLOSED';
  stage: 'PREPARING' | 'VOTING' | 'RESULTS';
  medium: 'LINK' | 'MANUAL';
  optionsArePublic: boolean;
  seriesId: string;
  roundNumber: number;
  supersededById: string | null;
  options: StrawpollOptionResult[];
  seatVotes: StrawpollSeatVote[];
  revision: number;
  createdAt: string;
  closedAt: string | null;
}

export interface CreatedStrawpoll extends Strawpoll {
  anonymousAccessToken?: string;
}

export type ProceedingDocumentKind = 'RESOLUTION' | 'AMENDMENT';
export type ProceedingDocumentStatus = 'DRAFT' | 'PUBLISHED' | 'POSTPONED' | 'VOTING'
  | 'PASSED' | 'FAILED' | 'INCORPORATED' | 'REJECTED';

export interface ProceedingDocumentVersion {
  id: string;
  versionNumber: number;
  content: string;
  contentFile: {
    id: string;
    logicalName: string;
    originalName: string;
    mediaType: string;
    status: 'UPLOAD_COMPLETE' | 'PENDING_REVIEW' | 'PUBLISHED';
  } | null;
  createdAt: string;
}

export interface DocumentDiscussionEntry {
  id: string;
  seatId: string;
  seatDisplayName: string;
  content: string;
  ruleStableId: string;
  createdAt: string;
}

export type ResolutionDirectVoteMajority = 'SIMPLE_MAJORITY' | 'TWO_THIRDS' | 'TWO_THIRDS_NON_ABSTAINING';

export interface ResolutionDirectVoteState {
  majority: ResolutionDirectVoteMajority;
  startedAt: string | null;
  settingsRevision: number;
  eligibility: Array<{seatId: string; seatDisplayName: string; mustVote: boolean; hasVeto: boolean}>;
  threshold: number;
  automaticResult: 'PASSED' | 'FAILED' | 'VETOED' | null;
  votes: BallotVote[];
}

export interface DocumentResultDecision {
  id: string;
  previousStatus: ProceedingDocumentStatus;
  newStatus: ProceedingDocumentStatus;
  reason: string | null;
  correctsDecisionId: string | null;
  createdAt: string;
}

export interface ProceedingDocument {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  kind: ProceedingDocumentKind;
  resolutionId: string | null;
  title: string;
  status: ProceedingDocumentStatus;
  rulePackageVersionId: string;
  currentVersion: ProceedingDocumentVersion;
  votingVersionId: string | null;
  public: boolean;
  proposerSeatId: string | null;
  seconderSeatId: string | null;
  delegatesCanAmend: boolean;
  directVote: ResolutionDirectVoteState | null;
  resultDecisions: DocumentResultDecision[];
  revision: number;
  discussion: DocumentDiscussionEntry[];
  createdAt: string;
  updatedAt: string;
}

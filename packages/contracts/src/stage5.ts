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

export interface SpeakerQueueEntry {
  id: string;
  seatId: string;
  seatDisplayName: string;
  position: number;
  status: SpeakerQueueStatus;
  createdAt: string;
}

export interface SpeakerList {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  kind: SpeakerListKind;
  status: SpeakerListStatus;
  topic: string;
  defaultSpeechMs: number;
  rulePackageVersionId: string;
  currentEntryId: string | null;
  speechTimerId: string;
  totalTimerId: string | null;
  revision: number;
  queue: SpeakerQueueEntry[];
  createdAt: string;
  closedAt: string | null;
  speeches?: SpeechRecord[];
}

export type SpeechKind = 'ORIGINAL' | 'INHERITED';
export type SpeechStatus = 'READY' | 'RUNNING' | 'PAUSED' | 'COMPLETED';
export type YieldType = 'CHAIR' | 'SEAT' | 'QUESTIONS' | 'COMMENTS';

export interface SpeechActionRecord {
  id: string;
  action: 'STARTED' | 'PAUSED' | 'RESUMED' | 'COMPLETED' | 'YIELDED' | 'QUESTION_RECORDED' | 'COMMENT_RECORDED';
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
  revision: number;
  startedAt: string | null;
  endedAt: string | null;
  actions: SpeechActionRecord[];
  contributions: SpeechContribution[];
}

export type MotionStatus = 'PENDING' | 'SECONDED' | 'VOTING' | 'PASSED' | 'FAILED' | 'WITHDRAWN' | 'SUPERSEDED';

export interface MotionSecond {
  id: string;
  seatId: string;
  seatDisplayName: string;
  createdAt: string;
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
  revision: number;
  createdAt: string;
  decidedAt: string | null;
}

export type BallotStatus = 'OPEN' | 'CLOSED' | 'PUBLISHED';
export type BallotChoice = 'FOR' | 'AGAINST' | 'ABSTAIN';

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

export interface Strawpoll {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  question: string;
  votingMode: StrawpollVotingMode;
  multipleChoice: boolean;
  status: 'OPEN' | 'CLOSED';
  options: StrawpollOptionResult[];
  revision: number;
  createdAt: string;
  closedAt: string | null;
}

export interface CreatedStrawpoll extends Strawpoll {
  anonymousAccessToken?: string;
}

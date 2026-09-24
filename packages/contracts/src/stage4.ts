import type {
  CreateCommitteeRequest,
  CommitteeOperationMode,
  CommitteeSeat,
  CommitteeSummary,
  CommitteeVisibility
} from './stage3.js';

export type LocalizedNames = Record<string, string>;
export type SeatRank = 'STANDARD' | 'NGO' | 'OBSERVER';
export type FlagSnapshot =
  | {type: 'STANDARD'; value: string}
  | {type: 'EMOJI'; value: string}
  | {type: 'IMAGE'; value: string};

export interface CountryTemplateCountry {
  id: string;
  stableKey: string;
  names: LocalizedNames;
  defaultLanguage: string;
  continent: string | null;
  sortOrder: number;
  flag: FlagSnapshot;
  revision: number;
  /** Read-only, generated search labels; never part of committee content history. */
  searchTerms?: string[];
  /** Account-maintained labels, returned only in the country template manager. */
  searchCodes?: string[];
}

export interface CountryTemplate {
  id: string;
  key: string;
  builtin: boolean;
  names: LocalizedNames;
  defaultLanguage: string;
  countryLanguages: string[];
  countries: CountryTemplateCountry[];
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CommitteeTemplateMember {
  id: string;
  stableKey: string;
  names: LocalizedNames;
  defaultLanguage: string;
  rank: SeatRank;
  canVote: boolean;
  hasVeto: boolean;
  mustVote: boolean;
  sortOrder: number;
  flag: FlagSnapshot;
  revision: number;
}

export interface CommitteeTemplate {
  id: string;
  key: string;
  builtin: boolean;
  names: LocalizedNames;
  defaultLanguage: string;
  countryTemplateKey: string;
  members: CommitteeTemplateMember[];
  revision: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CountryTemplateInput {
  names: LocalizedNames;
  defaultLanguage: string;
  countryLanguages: string[];
  countries: Array<{
    stableKey: string;
    names: LocalizedNames;
    defaultLanguage: string;
    continent?: string | null;
    sortOrder: number;
    flag: FlagSnapshot;
    searchCodes?: string[];
  }>;
}

export interface CommitteeTemplateInput {
  names: LocalizedNames;
  defaultLanguage: string;
  countryTemplateKey: string;
  members: Array<{
    stableKey: string;
    names: LocalizedNames;
    defaultLanguage: string;
    rank: SeatRank;
    canVote: boolean;
    hasVeto: boolean;
    mustVote: boolean;
    sortOrder: number;
    flag: FlagSnapshot;
  }>;
}

export interface UpdateCountryTemplateRequest {
  baseRevision: number;
  template: CountryTemplateInput;
}

export interface UpdateCommitteeTemplateRequest {
  baseRevision: number;
  template: CommitteeTemplateInput;
}

export interface CloneAccountTemplateRequest {
  names?: LocalizedNames;
  defaultLanguage?: string;
}

export interface CreateCommitteeFromTemplateRequest extends CreateCommitteeRequest {
  topic?: string;
  conference?: string;
}

export interface Stage4CommitteeSeat extends CommitteeSeat {
  rank: SeatRank;
  mustVote: boolean;
  flag: FlagSnapshot;
}

export interface UpdateSeatRequest {
  baseRevision: number;
  patch: Partial<Pick<Stage4CommitteeSeat,
    'rank' | 'canVote' | 'hasVeto' | 'mustVote' | 'sortOrder' | 'active'>>;
}

export interface CommitteeNote {
  id: string;
  title: string;
  content: string;
  sortOrder: number;
  revision: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CommitteeTextPost {
  id: string;
  title: string;
  content: string;
  sortOrder: number;
  revision: number;
  authorSeatId: string | null;
  authorDisplayName: string;
  actorUserId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CreateTextResourceRequest {
  title?: string;
  content: string;
  sortOrder?: number;
  onBehalfOfSeatId?: string;
}

export interface UpdateTextResourceRequest {
  baseRevision: number;
  patch: {title?: string; content?: string; sortOrder?: number};
}

export type MeetingSessionStatus = 'PENDING' | 'OPEN' | 'CLOSED';
export interface MeetingSession {
  ordinal: number;
  id: string;
  committeeId: string;
  name: string;
  phaseId: string;
  activeRulePackageVersionId: string;
  status: MeetingSessionStatus;
  revision: number;
  createdAt: string;
  closedAt: string | null;
}

export interface StartMeetingSessionRequest {
  phaseId?: string;
  missingGeneralListAction?: 'CREATE_REPLACEMENT';
}
export interface CloseMeetingSessionRequest {baseRevision: number}

export type RollCallStatus = 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';
export interface RollCallEntry {
  id: string;
  seatId: string;
  seatDisplayName: string;
  response: string;
  actorUserId: string;
  onBehalfOfSeatId: string;
  rulePackageVersionId: string;
  recordedAt: string;
  revision: number;
}

export interface RollCall {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  status: RollCallStatus;
  currentSeatId: string | null;
  rulePackageVersionId: string;
  allowedResponses: string[];
  seats: Pick<Stage4CommitteeSeat, 'id' | 'displayName' | 'canVote' | 'flag'>[];
  entries: RollCallEntry[];
  revision: number;
  startedAt: string;
  completedAt: string | null;
}

export interface StartRollCallRequest {meetingSessionId: string}
export interface RecordRollCallResponseRequest {
  baseRevision: number;
  seatId: string;
  response: string;
}
export interface UndoRollCallRequest {baseRevision: number}
export interface ResetRollCallRequest {baseRevision: number}

export type AttendanceEventType = 'PRESENT' | 'TEMPORARILY_LEFT' | 'RETURNED' | 'ABSENT';
export interface AttendanceEvent {
  id: string;
  committeeId: string;
  meetingSessionId: string;
  seatId: string;
  seatDisplayName: string;
  type: AttendanceEventType;
  actorUserId: string;
  onBehalfOfSeatId: string;
  sourceRollCallEntryId: string | null;
  sourcePointId: string | null;
  createdAt: string;
}

export interface AttendanceState {
  seatId: string;
  state: 'PRESENT' | 'TEMPORARILY_LEFT' | 'ABSENT';
  lastEventId: string;
  updatedAt: string;
}

export interface CreateAttendanceEventRequest {
  meetingSessionId: string;
  seatId: string;
  type: AttendanceEventType;
}

export type PointStatus = 'PENDING' | 'UPHELD' | 'OVERRULED' | 'ANSWERED' | 'RESOLVED' | 'REJECTED' | 'WITHDRAWN';
export interface CommitteePoint {
  typeNames: LocalizedNames;
  id: string;
  committeeId: string;
  meetingSessionId: string;
  pointTypeId: string;
  content: string;
  raisedBySeatId: string;
  raisedBySeatDisplayName: string;
  actorUserId: string;
  onBehalfOfSeatId: string;
  interruptRequested: boolean;
  status: PointStatus;
  chairResponse: string;
  resolvedByUserId: string | null;
  rulePackageVersionId: string;
  revision: number;
  createdAt: string;
  resolvedAt: string | null;
}

export type PublicCommitteePoint = Pick<CommitteePoint,
  'id' | 'committeeId' | 'meetingSessionId' | 'pointTypeId' | 'typeNames' | 'raisedBySeatId' | 'raisedBySeatDisplayName' |
  'interruptRequested' | 'status' | 'rulePackageVersionId' | 'revision' | 'createdAt' | 'resolvedAt'>;

export interface CreatePointRequest {
  meetingSessionId: string;
  pointTypeId: string;
  content: string;
  onBehalfOfSeatId?: string;
}

export interface ResolvePointRequest {
  baseRevision: number;
  status: Exclude<PointStatus, 'PENDING' | 'WITHDRAWN'>;
  chairResponse?: string;
  attendanceChange?: {type: AttendanceEventType};
}

export interface CommitteeRuleReadModel {
  versionId: string;
  activePhaseId: string | null;
  phases: Array<{id: string; names?: LocalizedNames}>;
  attendanceResponses: string[];
  pointTypes: Array<{id: string; names?: LocalizedNames; searchTerms?: string[]; interruptRequested: boolean}>;
  motionTypes: Array<{id: string; names?: LocalizedNames; searchTerms?: string[]; procedural: boolean; requiredSecondCount: number}>;
  speakerLists: Array<{id: string; defaultDurationSeconds?: number; defaultTotalDurationSeconds?: number;
    defaultSpeakerDurationSeconds?: number; allowDelegateRequests?: boolean; yieldTypes?: string[]}>;
  ballots: {delegateMayChangeVote: boolean; chairMayCorrectVote: boolean; anonymousStrawpoll: boolean;
    mustCollectAllVotesWhenVetoSeatEligible: boolean};
  documents: {amendmentsPublicByDefault: boolean};
}

export interface CommitteeWorkspaceSnapshot {
  /** The committee fixed country directory is exposed only to Chairs and Owners for seat creation. */
  countryTemplate?: CountryTemplate;
  schemaVersion: 3;
  committee: Omit<CommitteeSummary, 'ownerUserId'> & {ownerUserId?: string};
  seats: Stage4CommitteeSeat[];
  viewer: {audience: 'PUBLIC' | 'MEMBER' | 'CHAIR' | 'OWNER'; seatId: string | null};
  memberships?: Array<{userEmail: string | null; status: string}>;
  chairs?: Array<{userEmail: string}>;
  assignments?: Array<{id: string; seatId: string; userEmail: string | null; status: string}>;
  meetingSession?: MeetingSession;
  /** Set by adjournment; cleared when a new session starts. Does not restrict proceedings. */
  meetingEndedAt?: string | null;
  meetingSessions?: MeetingSession[];
  nextMeetingSessionOrdinal?: number;
  rollCall?: RollCall;
  attendance: AttendanceState[];
  /** Per-session attendance; closed sessions retain their final state. */
  attendanceBySession?: Record<string, AttendanceState[]>;
  points: Array<CommitteePoint | PublicCommitteePoint>;
  notes: CommitteeNote[];
  textPosts: CommitteeTextPost[];
  sync: {committeeEventSequence: number};
  activeRules: CommitteeRuleReadModel;
  motionSettings: import('./stage3.js').CommitteeMotionSettings;
  layoutSettings: {moveQueueUp: boolean; timersInSeparateColumns: boolean};
  timers?: import('./stage5.js').AuthoritativeTimer[];
  speakerLists?: import('./stage5.js').SpeakerList[];
  motions?: import('./stage5.js').ProceedingMotion[];
  ballots?: import('./stage5.js').FormalBallot[];
  strawpolls?: import('./stage5.js').Strawpoll[];
  documents?: import('./stage5.js').ProceedingDocument[];
}

export function localizedDisplayName(
  names: LocalizedNames,
  defaultLanguage: string,
  language: string
): string {
  return names[language]?.trim()
    || names[defaultLanguage]?.trim()
    || Object.values(names).find(value => value.trim())?.trim()
    || '';
}

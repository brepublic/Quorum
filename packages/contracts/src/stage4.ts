import type {
  CommitteeOperationMode,
  CommitteeSeat,
  CommitteeSummary,
  CommitteeVisibility
} from './stage3.js';

export type LocalizedNames = Record<string, string>;
export type SeatRank = 'STANDARD' | 'VETO' | 'NGO' | 'OBSERVER';
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
  names: LocalizedNames;
  defaultLanguage: string;
  countryTemplateKey: string;
  members: CommitteeTemplateMember[];
  revision: number;
  createdAt: string;
  updatedAt: string;
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

export interface CreateCommitteeFromTemplateRequest {
  name: string;
  visibility: CommitteeVisibility;
  operationMode?: CommitteeOperationMode;
  activeRulePackageVersionId?: string;
  committeeTemplateId?: string;
  countryTemplateKey?: string;
}

export interface Stage4CommitteeSeat extends CommitteeSeat {
  rank: SeatRank;
  mustVote: boolean;
  flag: FlagSnapshot;
}

export interface UpdateSeatRequest {
  baseRevision: number;
  patch: Partial<Pick<Stage4CommitteeSeat,
    'displayName' | 'rank' | 'canVote' | 'hasVeto' | 'mustVote' | 'sortOrder' | 'flag' | 'active'>>;
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

export type MeetingSessionStatus = 'OPEN' | 'CLOSED';
export interface MeetingSession {
  id: string;
  committeeId: string;
  phaseId: string;
  activeRulePackageVersionId: string;
  status: MeetingSessionStatus;
  revision: number;
  createdAt: string;
  closedAt: string | null;
}

export interface StartMeetingSessionRequest {phaseId?: string}
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

export type PointStatus = 'PENDING' | 'UPHELD' | 'OVERRULED' | 'ANSWERED' | 'RESOLVED' | 'REJECTED';
export interface CommitteePoint {
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
  'id' | 'committeeId' | 'meetingSessionId' | 'pointTypeId' | 'raisedBySeatId' | 'raisedBySeatDisplayName' |
  'interruptRequested' | 'status' | 'rulePackageVersionId' | 'revision' | 'createdAt' | 'resolvedAt'>;

export interface CreatePointRequest {
  meetingSessionId: string;
  pointTypeId: string;
  content: string;
  onBehalfOfSeatId?: string;
}

export interface ResolvePointRequest {
  baseRevision: number;
  status: Exclude<PointStatus, 'PENDING'>;
  chairResponse?: string;
  attendanceChange?: {type: AttendanceEventType};
}

export interface CommitteeWorkspaceSnapshot {
  schemaVersion: 2;
  committee: Omit<CommitteeSummary, 'ownerUserId'> & {ownerUserId?: string};
  seats: Stage4CommitteeSeat[];
  viewer: {audience: 'PUBLIC' | 'MEMBER' | 'CHAIR' | 'OWNER'; seatId: string | null};
  memberships?: Array<{userId: string; status: string}>;
  chairs?: Array<{userId: string}>;
  assignments?: Array<{id: string; seatId: string; userId: string; status: string}>;
  meetingSession?: MeetingSession;
  rollCall?: RollCall;
  attendance: AttendanceState[];
  points: Array<CommitteePoint | PublicCommitteePoint>;
  notes: CommitteeNote[];
  textPosts: CommitteeTextPost[];
  sync: {committeeEventSequence: number};
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

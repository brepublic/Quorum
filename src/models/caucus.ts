import firebase from 'firebase/compat/app';

import {makeDropdownOption, shortMeetId} from '../utils';
import {CommitteeID} from "./committee";
import {DEFAULT_TIMER, TimerData, Unit} from "./time";
import {DEFAULT_SPEAKER_TIME_SECONDS, DEFAULT_CAUCUS_TIME_SECONDS} from "./constants";
import {MemberID} from "../modules/member";

export function recoverUnit(caucus?: CaucusData): Unit {
  return caucus ? caucus.speakerUnit : Unit.Seconds;
}

export function recoverDuration(caucus?: CaucusData): number | undefined {
  return caucus?.speakerDuration;
}

export function hasTimeForAnotherSpeaker(
  caucusTimer: TimerData,
  speakerDurationSeconds: number
): boolean {
  return caucusTimer.remaining >= speakerDurationSeconds;
}

export type CaucusID = string;

export const GENERAL_SPEAKERS_LIST_ID: CaucusID = 'gsl';

export function isGeneralSpeakersList(caucusID: CaucusID): boolean {
  return caucusID === GENERAL_SPEAKERS_LIST_ID;
}

export function shouldAutoCloseCaucus(
  caucusID: CaucusID,
  caucusTimer: TimerData,
  speakerDurationSeconds: number
): boolean {
  return !isGeneralSpeakersList(caucusID)
    && !hasTimeForAnotherSpeaker(caucusTimer, speakerDurationSeconds);
}

export function shouldPauseCaucusTimerAfterSpeakerEnds(
  caucusID: CaucusID,
  speakerTimer: TimerData,
  caucusTimer: TimerData
): boolean {
  return !isGeneralSpeakersList(caucusID)
    && speakerTimer.remaining === 0
    && !!caucusTimer.ticking;
}

export function canAdvanceSpeaker(caucusID: CaucusID, speakerTimer: TimerData): boolean {
  return !isGeneralSpeakersList(caucusID) || !speakerTimer.ticking;
}

export function canOfferSpeakerYield(
  caucusID: CaucusID,
  speaker: SpeakerEvent | undefined,
  speakerTimer: TimerData
): boolean {
  const hasStarted = !!speaker?.started || speakerTimer.elapsed > 0 || !!speakerTimer.ticking;
  return isGeneralSpeakersList(caucusID)
    && !!speaker
    && hasStarted
    && !speakerTimer.ticking
    && speakerTimer.remaining > 1
    && !speaker.isYieldedTime;
}

export enum CaucusStatus {
  Open = 'Open',
  Closed = 'Closed'
}

export interface CaucusData {
  name: string;
  topic: string;
  status: CaucusStatus;
  speakerTimer: TimerData;
  speakerDuration: number;
  speakerUnit: Unit;
  caucusTimer: TimerData;
  queueIsPublic: boolean;
  speaking?: SpeakerEvent;
  queue?: Record<string, SpeakerEvent>;
  history?: Record<string, SpeakerEvent>;
  logs?: Record<string, CaucusLogEntry>;
}

export const CAUCUS_STATUS_OPTIONS = [
  CaucusStatus.Open,
  CaucusStatus.Closed
].map(makeDropdownOption);

export enum Stance {
  For = 'For',
  Neutral = 'Neutral',
  Against = 'Against'
}

export enum SpeechKind {
  Speech = 'Speech',
  Answer = 'Answer',
  Comment = 'Comment'
}

export enum YieldType {
  Chair = 'Chair',
  Delegate = 'Delegate',
  Question = 'Question',
  Comment = 'Comment'
}

export interface SpeakerEvent {
  who: string;
  memberID?: MemberID;
  stance: Stance;
  duration: number;
  started?: boolean;
  isYieldedTime?: boolean;
  speechKind?: SpeechKind;
}

export interface CaucusLogEntry {
  message: string;
  createdAt: number | object;
}

export function formatCaucusLogTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

export function speakerStartLog(speaker: SpeakerEvent, name: string): string {
  switch (speaker.speechKind) {
    case SpeechKind.Answer:
      return `${name} 代表开始回答。`;
    case SpeechKind.Comment:
      return `${name} 代表开始评论。`;
    default:
      return `${name} 代表开始发言。`;
  }
}

export function speakerCompletionLog(
  speaker: SpeakerEvent,
  name: string,
  remaining: number
): string {
  if (speaker.speechKind === SpeechKind.Answer) {
    return `${name} 代表回答完毕。让渡时间结束。`;
  }
  if (speaker.speechKind === SpeechKind.Comment) {
    return `${name} 代表评论完毕。让渡时间结束。`;
  }
  if (speaker.isYieldedTime) {
    return `${name} 代表发言完毕。让渡时间结束。`;
  }
  return `${name} 代表发言完毕。剩余时间为${formatCaucusLogTime(remaining)}。`;
}

export const DEFAULT_CAUCUS: CaucusData = {
  name: 'untitled caucus',
  topic: '',
  status: CaucusStatus.Open,
  speakerTimer: {...DEFAULT_TIMER, remaining: DEFAULT_SPEAKER_TIME_SECONDS},
  speakerDuration: DEFAULT_SPEAKER_TIME_SECONDS,
  speakerUnit: Unit.Seconds,
  caucusTimer: {...DEFAULT_TIMER, remaining: DEFAULT_CAUCUS_TIME_SECONDS},
  queueIsPublic: false,
  queue: {} as Record<string, SpeakerEvent>,
  history: {} as Record<string, SpeakerEvent>,
};
export const putCaucus =
  (committeeID: CommitteeID, caucusData: CaucusData): firebase.database.Reference => {
  const ref = firebase.database()
    .ref('committees')
    .child(committeeID)
    .child('caucuses')
    .child(shortMeetId());

  ref.set(caucusData);

  return ref;
};

export const putSpeaking =
  (committeeID: CommitteeID, caucusID: CaucusID, speaker: SpeakerEvent): Promise<any> => {

  console.debug(speaker);

  return firebase.database()
    .ref('committees')
    .child(committeeID)
    .child('caucuses')
    .child(caucusID)
    .child('speaking')
    .set(speaker);
}

// tslint:disable-next-line
export const closeCaucus = 
  (committeeID: CommitteeID, caucusID: CaucusID): Promise<any> => {
  return firebase.database()
    .ref('committees')
    .child(committeeID)
    .child('caucuses')
    .child(caucusID)
    .child('status')
    .set(CaucusStatus.Closed);
};

export interface Lifecycle {
  history: firebase.database.Reference;
  speakingData?: SpeakerEvent;
  speaking: firebase.database.Reference;
  timerData: TimerData;
  timer: firebase.database.Reference;
  yielding: boolean;
  queueHeadData?: SpeakerEvent;
  queueHead?: firebase.database.Reference;
  timerResetSeconds: number;
}

export const runLifecycle = (lifecycle: Lifecycle) => {
  const { history, speakingData, speaking, timerData, timer, 
    timerResetSeconds, yielding, queueHeadData, queueHead } = lifecycle;

  let additionalYieldTime = 0;

  // Move the person currently speaking into history...
  if (speakingData) {
    history.push().set({ ...speakingData, duration: timerData.elapsed });
    speaking.set(null);

    if (yielding) {
      additionalYieldTime = timerData.remaining;
    }

    timer.update({
      elapsed: 0,
      remaining: timerResetSeconds,
      ticking: false // and stop it
    });
  } // do nothing if no-one is currently speaking

  if (queueHead && queueHeadData) {
    speaking.set({
      ...queueHeadData,
      duration: queueHeadData.duration + additionalYieldTime
    });

    timer.update({
      elapsed: 0,
      remaining: queueHeadData.duration + additionalYieldTime, // load the appropriate time 
      ticking: false // and stop it
    });

    queueHead.set(null);
  }
};

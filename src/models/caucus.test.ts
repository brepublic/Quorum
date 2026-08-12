import {describe, expect, it} from 'vitest';
import {
  canAdvanceSpeaker,
  canOfferSpeakerYield,
  GENERAL_SPEAKERS_LIST_ID,
  formatCaucusLogTime,
  hasTimeForAnotherSpeaker,
  isGeneralSpeakersList,
  speakerCompletionLog,
  speakerStartLog,
  SpeechKind,
  shouldAutoCloseCaucus,
  shouldPauseCaucusTimerAfterSpeakerEnds,
  SpeakerEvent,
  Stance
} from './caucus';
import {TimerData} from './time';

const timerWith = (remaining: number): TimerData => ({
  elapsed: 0,
  remaining,
  ticking: false
});

describe('moderated caucus timing', () => {
  it('allows a final speaker when exactly one complete speaking slot remains', () => {
    expect(hasTimeForAnotherSpeaker(timerWith(60), 60)).toBe(true);
  });

  it('ends the caucus when less than one complete speaking slot remains', () => {
    expect(hasTimeForAnotherSpeaker(timerWith(59), 60)).toBe(false);
    expect(hasTimeForAnotherSpeaker(timerWith(0), 60)).toBe(false);
  });
});

describe('general speakers list identity', () => {
  it('distinguishes the persistent speakers list from moderated caucuses', () => {
    expect(isGeneralSpeakersList(GENERAL_SPEAKERS_LIST_ID)).toBe(true);
    expect(isGeneralSpeakersList('moderated-caucus')).toBe(false);
  });

  it('never auto-closes when a speaker or legacy caucus timer reaches zero', () => {
    expect(shouldAutoCloseCaucus(GENERAL_SPEAKERS_LIST_ID, timerWith(0), 60)).toBe(false);
    expect(shouldPauseCaucusTimerAfterSpeakerEnds(
      GENERAL_SPEAKERS_LIST_ID,
      timerWith(0),
      {...timerWith(600), ticking: 123}
    )).toBe(false);
  });

  it('keeps automatic completion for moderated caucuses', () => {
    expect(shouldAutoCloseCaucus('moderated-caucus', timerWith(59), 60)).toBe(true);
    expect(shouldAutoCloseCaucus('moderated-caucus', timerWith(60), 60)).toBe(false);
  });
});

const speaker = (overrides: Partial<SpeakerEvent> = {}): SpeakerEvent => ({
  who: 'China',
  memberID: 'china',
  stance: Stance.Neutral,
  duration: 120,
  ...overrides
});

describe('general speakers list activity logs', () => {
  it('formats remaining time and ordinary speech messages', () => {
    expect(formatCaucusLogTime(58)).toBe('0:58');
    expect(formatCaucusLogTime(125)).toBe('2:05');
    expect(speakerStartLog(speaker(), '中国')).toBe('中国 代表开始发言。');
    expect(speakerCompletionLog(speaker(), '中国', 58))
      .toBe('中国 代表发言完毕。剩余时间为0:58。');
  });

  it('marks answers, comments and inherited speeches as non-repeatable yield time', () => {
    expect(speakerStartLog(speaker({speechKind: SpeechKind.Answer, isYieldedTime: true}), '日本'))
      .toBe('日本 代表开始回答。');
    expect(speakerCompletionLog(speaker({speechKind: SpeechKind.Answer, isYieldedTime: true}), '日本', 27))
      .toBe('日本 代表回答完毕。让渡时间结束。');
    expect(speakerCompletionLog(speaker({speechKind: SpeechKind.Comment, isYieldedTime: true}), '韩国', 10))
      .toBe('韩国 代表评论完毕。让渡时间结束。');
    expect(speakerCompletionLog(speaker({isYieldedTime: true}), '美国', 10))
      .toBe('美国 代表发言完毕。让渡时间结束。');
  });
});

describe('general speakers list controls', () => {
  it('requires the timer to be paused before advancing', () => {
    expect(canAdvanceSpeaker(GENERAL_SPEAKERS_LIST_ID, {...timerWith(30), ticking: 123})).toBe(false);
    expect(canAdvanceSpeaker(GENERAL_SPEAKERS_LIST_ID, timerWith(30))).toBe(true);
    expect(canAdvanceSpeaker('moderated-caucus', {...timerWith(30), ticking: 123})).toBe(true);
  });

  it('offers a yield only for paused original time with more than one second left', () => {
    const original = speaker({started: true});
    expect(canOfferSpeakerYield(GENERAL_SPEAKERS_LIST_ID, original, timerWith(2))).toBe(true);
    expect(canOfferSpeakerYield(GENERAL_SPEAKERS_LIST_ID, original, timerWith(1))).toBe(false);
    expect(canOfferSpeakerYield(
      GENERAL_SPEAKERS_LIST_ID,
      {...original, isYieldedTime: true},
      timerWith(30)
    )).toBe(false);
    expect(canOfferSpeakerYield(
      GENERAL_SPEAKERS_LIST_ID,
      original,
      {...timerWith(30), ticking: 123}
    )).toBe(false);
  });
});

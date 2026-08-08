import {describe, expect, it} from 'vitest';
import {GENERAL_SPEAKERS_LIST_ID, hasTimeForAnotherSpeaker, isGeneralSpeakersList} from './caucus';
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
});

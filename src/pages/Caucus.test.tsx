import React, {act} from 'react';
import {createRoot, Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {NextSpeaking} from './Caucus';
import {CaucusData, CaucusStatus, GENERAL_SPEAKERS_LIST_ID, Stance} from '../models/caucus';
import {Unit} from '../models/time';
import {setLanguage} from '../i18n';

vi.mock('react-firebase-hooks/auth', () => ({
  useAuthState: () => [{uid: 'chair'}]
}));

vi.mock('firebase/compat/app', () => ({
  default: {
    auth: () => ({})
  }
}));

const firebaseRef = (): any => {
  const ref: any = {
    child: vi.fn(() => ref),
    set: vi.fn(),
    update: vi.fn(),
    push: vi.fn(() => ref)
  };
  ref.parent = ref;
  return ref;
};

const caucus = (): CaucusData => ({
  name: "General Speakers' List",
  topic: '',
  status: CaucusStatus.Open,
  speakerTimer: {elapsed: 30, remaining: 90, ticking: 123},
  speakerDuration: 120,
  speakerUnit: Unit.Seconds,
  caucusTimer: {elapsed: 0, remaining: 600, ticking: false},
  queueIsPublic: false,
  speaking: {
    who: 'China',
    memberID: 'china',
    stance: Stance.Neutral,
    duration: 120,
    started: true
  },
  queue: {
    usa: {
      who: 'United States',
      memberID: 'usa',
      stance: Stance.Neutral,
      duration: 120
    }
  }
});

describe('general speakers list controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    setLanguage('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderControls = (ticking: boolean | number) => {
    const data = caucus();
    const speakerTimer = {...data.speakerTimer, ticking};
    act(() => root.render(
      <NextSpeaking
        caucus={data}
        members={{
          china: {name: 'China', present: true} as any,
          usa: {name: 'United States', present: true} as any
        }}
        speakerTimer={speakerTimer}
        fref={firebaseRef()}
        autoNextSpeaker={false}
        caucusID={GENERAL_SPEAKERS_LIST_ID}
        onNextSpeaker={vi.fn()}
        toggleTimers={vi.fn()}
        yieldDecisionActive={false}
      />
    ));
  };

  it('disables Next while running and enables it only after Pause', () => {
    renderControls(123);
    const runningButtons = [...container.querySelectorAll('button')];
    expect(runningButtons.find(button => button.textContent?.includes('Pause'))).toBeTruthy();
    expect(runningButtons.find(button => button.textContent?.includes('Next'))?.disabled).toBe(true);
    expect(container.textContent).not.toContain('Yield');

    renderControls(false);
    const pausedButtons = [...container.querySelectorAll('button')];
    expect(pausedButtons.find(button => button.textContent?.includes('Continue'))).toBeTruthy();
    expect(pausedButtons.find(button => button.textContent?.includes('Next'))?.disabled).toBe(false);
  });
});

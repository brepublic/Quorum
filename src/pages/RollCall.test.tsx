import * as React from 'react';
import firebase from 'firebase/compat/app';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {RouteComponentProps} from 'react-router';
import {DEFAULT_COMMITTEE} from '../models/committee';
import {Rank} from '../modules/member';
import {URLParameters} from '../types';
import RollCall, {nextUncalledMemberID, ROLL_CALL_PAGE_SIZE} from './RollCall';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const routeProps = {
  history: {push: vi.fn()},
  location: {pathname: '/committees/example/roll-call'},
  match: {params: {committeeID: 'example'}}
} as unknown as RouteComponentProps<URLParameters>;

class FakeReference {
  constructor(
    private readonly writes: Map<string, boolean | string | null>,
    private readonly path = ''
  ) {}

  child(segment: string) {
    return new FakeReference(this.writes, [this.path, segment].filter(Boolean).join('/'));
  }

  set(value: boolean | string | null) {
    this.writes.set(this.path, value);
    return Promise.resolve();
  }

  update(updates: Record<string, boolean | string | null>) {
    Object.entries(updates).forEach(([path, value]) => {
      this.writes.set([this.path, path].filter(Boolean).join('/'), value);
    });
    return Promise.resolve();
  }
}

describe('RollCall', () => {
  it('finds the next uncalled member after the current member and wraps around', () => {
    const memberIDs = ['a', 'b', 'c', 'd'];

    expect(nextUncalledMemberID(memberIDs, ['a', 'b'], 'b')).toBe('c');
    expect(nextUncalledMemberID(memberIDs, ['a', 'c', 'd'], 'd')).toBe('b');
    expect(nextUncalledMemberID(memberIDs, memberIDs, 'd')).toBeUndefined();
    expect(ROLL_CALL_PAGE_SIZE).toBe(18);
  });

  it('renders every initial member as uncalled and highlights the first alphabetically', () => {
    const committee = {
      ...DEFAULT_COMMITTEE,
      members: {
        zambia: {name: 'Zambia', present: false, rank: Rank.Standard, voting: false},
        china: {name: 'China', present: true, rank: Rank.Veto, voting: false},
        bolivia: {name: 'Bolivia', present: false, rank: Rank.Observer, voting: false}
      }
    };
    const markup = renderToStaticMarkup(
      <RollCall
        {...routeProps}
        committee={committee}
        fref={{} as firebase.database.Reference}
      />
    );
    const container = document.createElement('div');
    container.innerHTML = markup;
    const members = [...container.querySelectorAll('.roll-call-member')];

    expect(members).toHaveLength(3);
    expect(members.every(member => member.classList.contains('status-uncalled'))).toBe(true);
    expect(container.querySelector('.roll-call-member.is-current')?.textContent).toContain('Bolivia');
    expect(container.querySelector('.roll-call-current')?.textContent).toContain('Bolivia');
  });

  it('records attendance, advances automatically, toggles a selected member and undoes', async () => {
    const committee = {
      ...DEFAULT_COMMITTEE,
      members: {
        zambia: {name: 'Zambia', present: false, rank: Rank.Standard, voting: false},
        china: {name: 'China', present: false, rank: Rank.Veto, voting: false},
        bolivia: {name: 'Bolivia', present: false, rank: Rank.Observer, voting: false}
      }
    };
    const writes = new Map<string, boolean | string | null>();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <RollCall
          {...routeProps}
          committee={committee}
          fref={new FakeReference(writes) as unknown as firebase.database.Reference}
        />
      );
    });

    await act(async () => {
      (container.querySelector('.roll-call-actions .positive') as HTMLButtonElement).click();
    });
    expect(writes.get('members/bolivia/present')).toBe(true);
    expect(writes.get('rollCall/called/bolivia')).toBe(true);
    expect(writes.get('rollCall/currentMemberID')).toBe('china');
    expect(container.querySelector('.roll-call-member.status-present')?.textContent).toContain('Bolivia');
    expect(container.querySelector('.roll-call-member.is-current')?.textContent).toContain('China');

    const zambia = [...container.querySelectorAll('.roll-call-member')]
      .find(member => member.textContent?.includes('Zambia')) as HTMLButtonElement;
    await act(async () => zambia.click());
    expect(zambia.classList.contains('status-present')).toBe(true);
    await act(async () => zambia.click());
    expect(zambia.classList.contains('status-absent')).toBe(true);

    await act(async () => {
      (container.querySelector('.roll-call-actions .undo') as HTMLButtonElement).click();
    });
    expect(zambia.classList.contains('status-present')).toBe(true);
    expect(writes.get('members/zambia/present')).toBe(true);

    await act(async () => root.unmount());
    container.remove();
  });

  it('restores persisted called and current-member state on re-entry', () => {
    const committee = {
      ...DEFAULT_COMMITTEE,
      members: {
        bolivia: {name: 'Bolivia', present: true, rank: Rank.Standard, voting: false},
        china: {name: 'China', present: false, rank: Rank.Veto, voting: false}
      },
      rollCall: {
        called: {bolivia: true as const},
        currentMemberID: 'china'
      }
    };
    const markup = renderToStaticMarkup(
      <RollCall
        {...routeProps}
        committee={committee}
        fref={{} as firebase.database.Reference}
      />
    );
    const container = document.createElement('div');
    container.innerHTML = markup;

    expect(container.querySelector('.roll-call-member.status-present')?.textContent).toContain('Bolivia');
    expect(container.querySelector('.roll-call-member.is-current')?.textContent).toContain('China');
  });
});

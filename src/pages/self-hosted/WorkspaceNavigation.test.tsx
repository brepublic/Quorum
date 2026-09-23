import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import type {SelfHostedUser} from '../../services/self-hosted-identity';
import {setLanguage} from '../../i18n';
import {AccountMenu, CommitteeNavigation} from './WorkspaceNavigation';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const user: SelfHostedUser = {id: 'user', email: 'user@example.com', displayName: 'User', status: 'ACTIVE',
  isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null};

const snapshot = {committee: {id: 'committee', name: 'Security Council'}, activeRules: {}, speakerLists: [
  {id: 'gsl', kind: 'GENERAL', name: '主发言名单', topic: '', status: 'OPEN'},
  {id: 'mod', kind: 'MODERATED_CAUCUS', topic: 'Climate security', status: 'OPEN'}
], documents: [{id: 'resolution', kind: 'RESOLUTION', title: 'A/RES/1'}],
strawpolls: [{id: 'poll', question: 'Suspend the meeting?'}]} as unknown as CommitteeWorkspaceSnapshot;

const completedRollCall = {
  ...snapshot,
  meetingSession: {id: "meeting", name: "第1会期", status: "OPEN"},
  rollCall: {id: "roll-call", meetingSessionId: "meeting", status: "COMPLETED"},
  seats: [
    {id: "one", canVote: true}, {id: "two", canVote: true}, {id: "three", canVote: true}, {id: "four", canVote: true},
    {id: "five", canVote: true}, {id: "six", canVote: true}, {id: "seven", canVote: true}
  ],
  attendance: [
    {seatId: "one", state: "PRESENT"}, {seatId: "two", state: "PRESENT"}, {seatId: "three", state: "PRESENT"},
    {seatId: "four", state: "PRESENT"}, {seatId: "five", state: "PRESENT"}, {seatId: "six", state: "PRESENT"},
    {seatId: "seven", state: "PRESENT"}
  ]
} as unknown as CommitteeWorkspaceSnapshot;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove(); root = undefined; container = undefined; setLanguage('en');
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function render(node: React.ReactNode, path = '/') {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root?.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  return container;
}

describe('self-hosted workspace navigation', () => {
  it('folds only as much as needed, restores items, and preserves the workspace', () => {
    let available = 1800;
    let resize = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} disconnect() {}
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const width = this.classList.contains('committee-navigation-measurement') ? available
        : this.classList.contains('committee-navigation-more') ? 50
        : this.classList.contains('realtime-status-label') ? 30
        : this.classList.contains('right') ? 200 : 100;
      return {width, height: 48, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 48, toJSON: () => ({})};
    });
    const page = render(<CommitteeNavigation snapshot={snapshot} user={user} logout={() => undefined}>
      <input defaultValue="unsaved draft" />
    </CommitteeNavigation>, '/committees/committee/strawpolls/poll');
    const nav = page.querySelector('.committee-navigation-desktop')!;
    const draft = page.querySelector('input')!;
    const assertLevel = (width: number, level: number) => {
      available = width;
      act(() => resize());
      expect(nav.getAttribute('data-collapse-level')).toBe(String(level));
      expect(page.querySelector('input')).toBe(draft);
      expect(draft.value).toBe('unsaved draft');
    };
    for (const [width, level] of [[1800, 0], [1680, 1], [1600, 2], [1500, 3], [1400, 4], [1300, 5], [1200, 6]]) {
      assertLevel(width, level);
      expect(Boolean(nav.querySelector('.realtime-status-label'))).toBe(level === 0);
      for (const [path, minimum] of [['/settings', 2], ['/help', 2], ['/stats', 3], ['/posts', 4], ['/notes', 5], ['/strawpolls', 6]] as const) {
        expect(Boolean(nav.querySelector(`.committee-primary-navigation > [data-navigation-key="${path}"]`))).toBe(level < minimum);
      }
    }
    expect(nav.querySelector('.committee-navigation-more.active')).not.toBeNull();
    const more = nav.querySelector<HTMLElement>('.committee-navigation-more')!;
    act(() => more.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
    expect(more.classList.contains('visible')).toBe(true);
    act(() => more.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
    expect(more.classList.contains('visible')).toBe(false);
    act(() => more.click());
    const poll = more.querySelector<HTMLElement>('.committee-overflow-poll')!;
    act(() => poll.click());
    expect(poll.querySelector('.visible.menu a[href="/committees/committee/strawpolls/new"]')).not.toBeNull();
    expect(poll.querySelector('a.active')?.getAttribute('href')).toBe('/committees/committee/strawpolls/poll');
    act(() => poll.querySelector<HTMLElement>('a.active')?.click());
    expect(more.classList.contains('visible')).toBe(false);
    assertLevel(1000, 7);
    expect(nav.getAttribute('data-navigation-mode')).toBe('sidebar');
    for (const [width, level] of [[1200, 6], [1300, 5], [1400, 4], [1500, 3], [1600, 2], [1680, 1], [1800, 0]]) assertLevel(width, level);
    expect(page.querySelector('.committee-navigation-measurement')?.hasAttribute('inert')).toBe(true);
    expect(nav.querySelector('a[href="/committees/committee/setup"]')?.textContent).toBe('Seats');
    act(() => setLanguage('zh-CN'));
    expect(nav.querySelector('a[href="/committees/committee/setup"]')?.textContent).toBe('席位');
  });

  it('uses route links and highlights a dynamic committee resource', () => {
    const page = render(<CommitteeNavigation snapshot={snapshot} user={user} logout={() => undefined} />,
      '/committees/committee/caucuses/mod');
    const links = Array.from(page.querySelectorAll('a')).map(link => link.getAttribute('href'));
    expect(links).toContain('/committees/committee/setup');
    expect(links).toContain('/committees/committee/info');
    expect(links).toContain('/committees/committee/roll-call');
    expect(links).toContain('/committees/committee/caucuses/gsl');
    expect(links).toContain('/committees/committee/caucuses/mod');
    expect(page.querySelector('a[href="/committees/committee/caucuses/gsl"]')?.textContent).toBe("General Speaker's List");
    act(() => setLanguage('zh-CN'));
    expect(page.querySelector('a[href="/committees/committee/caucuses/gsl"]')?.textContent).toBe("主发言名单");
    const active = page.querySelector('a.active');
    expect(active?.getAttribute('href')).toBe('/committees/committee/caucuses/mod');
  });

  it('opens caucus creation without navigating to the legacy new route', () => {
    const onCreateCaucus = vi.fn();
    const page = render(<CommitteeNavigation snapshot={snapshot} user={user} logout={() => undefined}
      onCreateCaucus={onCreateCaucus} />, '/committees/committee/caucuses/gsl');
    const item = [...page.querySelectorAll<HTMLElement>('.committee-primary-navigation .dropdown .item')]
      .find(candidate => candidate.textContent?.includes('New caucus'));
    expect(item?.getAttribute('href')).toBeNull();
    act(() => item?.click());
    expect(onCreateCaucus).toHaveBeenCalledOnce();
  });

  it('keeps templates and system settings in the account menu', () => {
    const admin = {...user, isSystemAdmin: true};
    const page = render(<CommitteeNavigation snapshot={snapshot} user={admin} logout={() => undefined} />,
      '/committees/committee');
    expect(page.querySelector('.committee-primary-navigation > a[href="/templates"]')).toBeNull();
    expect(page.querySelector('.committee-primary-navigation > a[href="/operations"]')).toBeNull();
    expect(page.querySelector('.account-menu a[href="/templates"]')).not.toBeNull();
    expect(page.querySelector('.account-menu a[href="/system-settings"]')).not.toBeNull();
    expect(page.querySelector('.account-menu a[href="/operations"]')).toBeNull();
    expect(page.querySelector('.account-menu a[href="/storage"]')).toBeNull();
  });

  it("shows roll-call attendance thresholds immediately left of the realtime status", () => {
    const page = render(<CommitteeNavigation snapshot={completedRollCall} user={user} logout={() => undefined} />,
      "/committees/committee/motions");
    const summary = page.querySelector(".attendance-threshold-summary");
    const realtime = page.querySelector(".realtime-status");
    expect(summary?.textContent).toBe("7/5/4");
    expect(summary?.getAttribute("title")).toBe("Attendance / two-thirds majority / simple majority");
    expect(summary?.nextElementSibling).toBe(realtime);
  });

  it("excludes deactivated seats from attendance while counting only voting seats for thresholds", () => {
    const current = {...completedRollCall,
      seats: [{id: "one", canVote: false}, {id: "two", canVote: true}, {id: "three", canVote: true},
        {id: "four", canVote: true}, {id: "five", canVote: true}]};
    const page = render(<CommitteeNavigation snapshot={current as unknown as CommitteeWorkspaceSnapshot}
      user={user} logout={() => undefined} />, "/committees/committee/roll-call");
    expect(page.querySelector(".attendance-threshold-summary")?.textContent).toBe("5/3/3");
  });

  it("shows zero majority thresholds when no present seat can vote", () => {
    const current = {...completedRollCall, seats: [{id: "one", canVote: false}]};
    const page = render(<CommitteeNavigation snapshot={current as unknown as CommitteeWorkspaceSnapshot}
      user={user} logout={() => undefined} />, "/committees/committee/roll-call");
    expect(page.querySelector(".attendance-threshold-summary")?.textContent).toBe("1/0/0");
  });

  it("hides attendance thresholds until the current session has a completed roll call", () => {
    const page = render(<CommitteeNavigation snapshot={{...completedRollCall, rollCall: {...completedRollCall.rollCall!, status: "IN_PROGRESS"}}}
      user={user} logout={() => undefined} />, "/committees/committee/motions");
    expect(page.querySelector(".attendance-threshold-summary")).toBeNull();
  });

  it("does not grant system administration entries to a regular account", () => {
    const page = render(<AccountMenu user={user} logout={vi.fn()} />);
    expect(page.querySelector('a[href="/admin"]')).toBeNull();
    expect(page.querySelector('a[href="/system-settings"]')).toBeNull();
    expect(page.querySelector('a[href="/storage"]')).toBeNull();
    expect(page.querySelector('a[href="/operations"]')).toBeNull();
  });

  it('uses the legacy uncover sidebar around the workspace and closes it from the pusher', () => {
    const page = render(<CommitteeNavigation snapshot={snapshot} user={user} logout={() => undefined}>
      <main data-testid="workspace">Workspace</main>
    </CommitteeNavigation>);
    const pushable = page.querySelector('.committee-navigation-pushable');
    const sidebar = pushable?.querySelector('.committee-mobile-sidebar');
    const pusher = pushable?.querySelector('.pusher');
    const toggle = pushable?.querySelector<HTMLElement>('[aria-label="Open committee navigation"]');
    expect(sidebar?.getAttribute('class')).toContain('uncover');
    expect(pusher?.querySelector('[data-testid="workspace"]')?.textContent).toBe('Workspace');

    act(() => toggle?.click());
    expect(sidebar?.getAttribute('class')).toContain('visible');
    expect(pusher?.getAttribute('class')).toContain('dimmed');

    act(() => (pusher as HTMLElement | null)?.click());
    expect(sidebar?.getAttribute('class')).not.toContain('visible');
    expect(pusher?.getAttribute('class')).not.toContain('dimmed');
  });
});

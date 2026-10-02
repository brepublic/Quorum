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
    {id: "one", canVote: true, canProceduralVote: true}, {id: "two", canVote: true, canProceduralVote: true}, {id: "three", canVote: true, canProceduralVote: true}, {id: "four", canVote: true, canProceduralVote: true},
    {id: "five", canVote: true, canProceduralVote: true}, {id: "six", canVote: true, canProceduralVote: true}, {id: "seven", canVote: true, canProceduralVote: true}
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
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function render(node: React.ReactNode, path = '/') {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root?.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  return container;
}

describe('self-hosted workspace navigation', () => {
  it('keeps an open crisis dropdown synchronized for multiple cycles while viewing another page', async () => {
    vi.useFakeTimers();
    const current = {...snapshot, crises: [
      {id: 'pending', committeeId: 'committee', sessionOrdinal: 1, ordinal: 1, endedAt: null,
        timer: {remainingMs: 60_000, running: false}, updates: [{status: 'PENDING'}]},
      {id: 'ended', committeeId: 'committee', sessionOrdinal: 1, ordinal: 2, endedAt: '2026-09-30T00:00:00Z',
        timer: {remainingMs: 0, running: false}, updates: [{status: 'ENDED'}]},
      {id: 'draft', committeeId: 'committee', sessionOrdinal: 1, ordinal: 3, endedAt: null,
        timer: {remainingMs: 0, running: false}, updates: [{status: 'UNPUBLISHED'}]}
    ]} as unknown as CommitteeWorkspaceSnapshot;
    const page = render(<CommitteeNavigation snapshot={current} user={user} logout={() => undefined} />,
      '/committees/committee/unmod');
    const dropdown = page.querySelector<HTMLElement>('.committee-navigation-desktop [data-navigation-key="/crises"]')!;
    act(() => dropdown.click());
    for (let cycle = 0; cycle < 6; cycle++) {
      expect(dropdown.getAttribute('aria-expanded')).toBe('true');
      expect([...page.querySelectorAll('[data-crisis-reminder]')].map(menu => menu.getAttribute('data-crisis-reminder')))
        .toEqual(Array(3).fill(cycle % 2 === 0 ? 'red' : 'black'));
      expect(dropdown.querySelector('a[href$="/pending"]')?.classList.contains('crisis-awaiting')).toBe(true);
      expect(dropdown.querySelector('a[href$="/ended"]')?.classList.contains('crisis-awaiting')).toBe(false);
      expect(dropdown.querySelector('a[href$="/draft"]')?.classList.contains('crisis-awaiting')).toBe(false);
      await act(async () => {await vi.advanceTimersByTimeAsync(1_000);});
    }
    act(() => dropdown.click());
    await act(async () => {await vi.advanceTimersByTimeAsync(1_000);});
    act(() => dropdown.click());
    expect(dropdown.getAttribute('aria-expanded')).toBe('true');
    expect(dropdown.closest('[data-crisis-reminder]')?.getAttribute('data-crisis-reminder')).toBe('black');
  });

  it('folds only as much as needed, restores items, and preserves the workspace', () => {
    let available = 2000;
    let resize = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} disconnect() {}
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function(this: Element) {
      const width = this.classList.contains('committee-navigation-measurement') ? available
        : this.classList.contains('committee-navigation-more') ? 64
        : this.classList.contains('committee-navigation-more-files') ? 14
        : this.getAttribute('data-navigation-key') === '/posts' ? 114
        : this.classList.contains('account-menu') ? this.classList.contains('account-menu-compact') ? 40 : 120
        : this.classList.contains('navigation-caucus-label') ? 80
        : this.classList.contains('navigation-caucus-short-measurement') ? 20
        : this.classList.contains('realtime-status-label') ? 30
        : this.classList.contains('right') ? 200 : 100;
      return {width, height: 48, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 48, toJSON: () => ({})};
    });
    const page = render(<CommitteeNavigation snapshot={{...snapshot, crises: [{id: 'pending', committeeId: 'committee',
      sessionOrdinal: 1, ordinal: 1, endedAt: null, timer: {remainingMs: 0, running: false}, updates: [{status: 'PENDING'}]}]
    } as unknown as CommitteeWorkspaceSnapshot} user={user} logout={() => undefined} hasPendingFileReview>
      <input defaultValue="unsaved draft" />
    </CommitteeNavigation>, '/committees/committee/strawpolls/poll');
    const nav = page.querySelector('.committee-navigation-desktop')!;
    const draft = page.querySelector('input')!;
    const assertLevel = (width: number, level: number) => {
      available = width + 14;
      act(() => resize());
      expect(nav.getAttribute('data-collapse-level')).toBe(String(level));
      expect(nav.querySelector('.committee-primary-navigation')?.classList.contains('fluid')).toBe(level === 0);
      expect(page.querySelector('input')).toBe(draft);
      expect(draft.value).toBe('unsaved draft');
    };
    for (const [width, level] of [[2100, 0], [1980, 1], [1900, 2], [1780, 3], [1700, 4], [1600, 5], [1500, 6], [1400, 7], [1300, 8], [1200, 9], [1100, 10], [1000, 11], [900, 12], [800, 13]]) {
      assertLevel(width, level);
      expect(Boolean(nav.querySelector('.realtime-status-label'))).toBe(level < 3);
      expect(nav.querySelector('.account-menu')?.classList.contains('account-menu-compact')).toBe(level >= 1);
      expect(nav.querySelector('.account-menu-name')?.textContent ?? null).toBe(level >= 1 ? null : user.displayName);
      expect(nav.querySelector('.account-menu > .text')).toBeNull();
      expect(nav.querySelector('[data-navigation-key="/unmod"] .navigation-caucus-label')?.textContent)
        .toBe(level >= 2 ? 'Unmod' : 'Unmoderated Caucus');
      if (level < 13) expect(nav.querySelector('[data-navigation-key="/caucuses"] .navigation-caucus-label')?.textContent)
        .toBe(level >= 2 ? 'Caucus' : 'Moderated Caucuses');
      expect(nav.querySelector('a[href="/committees/committee/posts"] .file-review-dot')?.getAttribute('aria-label')).toBe('Pending review');
      expect(Boolean(nav.querySelector('.committee-navigation-more > .committee-navigation-more-files .file-review-dot'))).toBe(level >= 6);
      expect(Boolean(nav.querySelector('.committee-navigation-more > .crisis-time-dot'))).toBe(level >= 12);
      expect(nav.querySelector('.account-menu')?.getAttribute('title')).toBe(user.displayName);
      expect(nav.querySelector('[data-navigation-key="/unmod"]')?.getAttribute('aria-label')).toBe('Unmoderated Caucus');
      for (const [path, minimum] of [['/settings', 4], ['/help', 4], ['/stats', 5], ['/posts', 6], ['/notes', 7], ['/strawpolls', 8], ['/votes', 9], ['/resolutions', 10], ['/directives', 11], ['/crises', 12], ['/caucuses', 13]] as const) {
        expect(Boolean(nav.querySelector(`.committee-primary-navigation > [data-navigation-key="${path}"]`))).toBe(level < minimum);
      }
    }
    expect(nav.querySelector('.committee-navigation-more.active')).not.toBeNull();
    const more = nav.querySelector<HTMLElement>('.committee-navigation-more')!;
    expect(more.querySelector(':scope > .icon')?.nextElementSibling?.classList.contains('committee-navigation-more-files')).toBe(true);
    act(() => more.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
    expect(more.classList.contains('visible')).toBe(true);
    act(() => more.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
    expect(more.classList.contains('visible')).toBe(false);
    act(() => more.click());
    expect(more.querySelector('.visible.menu a[href="/committees/committee/posts"] .file-review-dot')).not.toBeNull();
    const poll = more.querySelector<HTMLElement>('[data-navigation-key="/strawpolls"]')!;
    act(() => poll.click());
    expect(poll.querySelector('.visible.menu a[href="/committees/committee/strawpolls/new"]')).not.toBeNull();
    expect(poll.querySelector('a.active')?.getAttribute('href')).toBe('/committees/committee/strawpolls/poll');
    act(() => poll.querySelector<HTMLElement>('a.active')?.click());
    expect(more.classList.contains('visible')).toBe(false);
    assertLevel(600, 14);
    expect(nav.getAttribute('data-navigation-mode')).toBe('sidebar');
    expect(page.querySelector('.committee-mobile-sidebar a[href="/committees/committee/posts"] .file-review-dot')).not.toBeNull();
    for (const [width, level] of [[800, 13], [900, 12], [1000, 11], [1100, 10], [1200, 9], [1300, 8], [1400, 7], [1500, 6], [1600, 5], [1700, 4], [1780, 3], [1900, 2], [1980, 1], [2100, 0]]) assertLevel(width, level);
    expect(page.querySelector('.committee-navigation-measurement')?.hasAttribute('inert')).toBe(true);
    expect(nav.querySelector('a[href="/committees/committee/setup"]')?.textContent).toBe('Seats');
    assertLevel(1900, 2);
    act(() => setLanguage('zh-CN'));
    expect(nav.querySelector('[data-navigation-key="/unmod"] .navigation-caucus-label')?.textContent).toBe('自由磋商');
    expect(nav.querySelector('[data-navigation-key="/caucuses"] .navigation-caucus-label')?.textContent).toBe('有主持核心磋商');
    expect(nav.querySelector('a[href="/committees/committee/setup"]')?.textContent).toBe('席位');
    expect(nav.querySelector('a[href="/committees/committee/posts"] .file-review-dot')?.getAttribute('aria-label')).toBe('待审核');
    act(() => root?.render(<MemoryRouter initialEntries={['/committees/committee']}>
      <CommitteeNavigation snapshot={snapshot} user={user} logout={() => undefined} />
    </MemoryRouter>));
    expect(page.querySelector('.file-review-dot')).toBeNull();
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
      .find(candidate => candidate.textContent?.includes('New Moderated Caucus'));
    expect(item?.getAttribute('href')).toBeNull();
    act(() => item?.click());
    expect(onCreateCaucus).toHaveBeenCalledOnce();
  });

  it('removes the username node in compact mode while retaining the icon and account actions', () => {
    const logout = vi.fn();
    const page = render(<AccountMenu user={user} logout={logout} compact />);
    const account = page.querySelector<HTMLElement>('.account-menu')!;
    expect(account.querySelector('.account-menu-name')).toBeNull();
    expect([...account.children].some(child => child.classList.contains('text'))).toBe(false);
    expect(account.textContent).not.toContain(user.displayName);
    expect([...account.children].some(child => child.matches('.user.circle.icon'))).toBe(true);
    expect(account.getAttribute('aria-label')).toBe('Account menu');
    expect(account.getAttribute('title')).toBe(user.displayName);
    act(() => account.click());
    expect(account.getAttribute('aria-expanded')).toBe('true');
    const exit = [...account.querySelectorAll<HTMLElement>('.menu > .item')].find(item => item.textContent === 'Logout');
    act(() => exit?.click());
    expect(logout).toHaveBeenCalledOnce();
    act(() => root?.render(<MemoryRouter><AccountMenu user={user} logout={logout} /></MemoryRouter>));
    expect(page.querySelector('.account-menu-name')?.textContent).toBe(user.displayName);
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
    expect(summary?.getAttribute("title")).toBe("Attendance / procedural Two-Thirds Majority / procedural Simple Majority");
    expect(summary?.nextElementSibling).toBe(realtime);
  });

  it("excludes deactivated seats from attendance while counting procedural seats for thresholds", () => {
    const current = {...completedRollCall,
      seats: [{id: "one", canVote: false, canProceduralVote: true}, {id: "two", canVote: true, canProceduralVote: true}, {id: "three", canVote: true, canProceduralVote: true},
        {id: "four", canVote: true, canProceduralVote: true}, {id: "five", canVote: true, canProceduralVote: true}]};
    const page = render(<CommitteeNavigation snapshot={current as unknown as CommitteeWorkspaceSnapshot}
      user={user} logout={() => undefined} />, "/committees/committee/roll-call");
    expect(page.querySelector(".attendance-threshold-summary")?.textContent).toBe("5/4/3");
  });

  it("counts procedural-only attendees and ignores file-only seats", () => {
    const current = {...completedRollCall, seats: [{id: "one", canVote: false, canProceduralVote: true}, {id: "two", canVote: false, canProceduralVote: false}]};
    const page = render(<CommitteeNavigation snapshot={current as unknown as CommitteeWorkspaceSnapshot}
      user={user} logout={() => undefined} />, "/committees/committee/roll-call");
    expect(page.querySelector(".attendance-threshold-summary")?.textContent).toBe("1/1/1");
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

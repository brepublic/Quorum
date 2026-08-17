import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import type {SelfHostedUser} from '../../services/self-hosted-identity';
import {AccountMenu, CommitteeNavigation} from './WorkspaceNavigation';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const user: SelfHostedUser = {id: 'user', email: 'user@example.com', displayName: 'User', status: 'ACTIVE',
  isSystemAdmin: false, sessionVersion: 1, mustChangePassword: false, createdAt: '2026-08-13T00:00:00.000Z', disabledAt: null};

const snapshot = {committee: {id: 'committee', name: 'Security Council'}, activeRules: {}, speakerLists: [
  {id: 'gsl', kind: 'GENERAL', topic: '', status: 'OPEN'},
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
  container?.remove(); root = undefined; container = undefined;
});

function render(node: React.ReactNode, path = '/') {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root?.render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>));
  return container;
}

describe('self-hosted workspace navigation', () => {
  it('uses route links and highlights a dynamic committee resource', () => {
    const page = render(<CommitteeNavigation snapshot={snapshot} user={user} logout={() => undefined} />,
      '/committees/committee/caucuses/mod');
    const links = Array.from(page.querySelectorAll('a')).map(link => link.getAttribute('href'));
    expect(links).toContain('/committees/committee/setup');
    expect(links).toContain('/committees/committee/info');
    expect(links).toContain('/committees/committee/roll-call');
    expect(links).toContain('/committees/committee/caucuses/gsl');
    expect(links).toContain('/committees/committee/caucuses/mod');
    expect(page.querySelector('a[href="/committees/committee/caucuses/gsl"]')?.textContent).toBe("General Speakers' List");
    const active = page.querySelector('a.active');
    expect(active?.getAttribute('href')).toBe('/committees/committee/caucuses/mod');
  });

  it('keeps templates and operations in the account menu', () => {
    const admin = {...user, isSystemAdmin: true};
    const page = render(<CommitteeNavigation snapshot={snapshot} user={admin} logout={() => undefined} />,
      '/committees/committee');
    expect(page.querySelector('.committee-primary-navigation > a[href="/templates"]')).toBeNull();
    expect(page.querySelector('.committee-primary-navigation > a[href="/operations"]')).toBeNull();
    expect(page.querySelector('.account-menu a[href="/templates"]')).not.toBeNull();
    expect(page.querySelector('.account-menu a[href="/operations"]')).not.toBeNull();
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

  it("hides attendance thresholds until the current session has a completed roll call", () => {
    const page = render(<CommitteeNavigation snapshot={{...completedRollCall, rollCall: {...completedRollCall.rollCall!, status: "IN_PROGRESS"}}}
      user={user} logout={() => undefined} />, "/committees/committee/motions");
    expect(page.querySelector(".attendance-threshold-summary")).toBeNull();
  });

  it("does not grant system administration entries to a regular account", () => {
    const page = render(<AccountMenu user={user} logout={vi.fn()} />);
    expect(page.querySelector('a[href="/admin"]')).toBeNull();
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

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
    expect(links).toContain('/committees/committee/roll-call');
    expect(links).toContain('/committees/committee/caucuses/mod');
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

  it('does not grant system administration entries to a regular account', () => {
    const page = render(<AccountMenu user={user} logout={vi.fn()} />);
    expect(page.querySelector('a[href="/admin"]')).toBeNull();
    expect(page.querySelector('a[href="/storage"]')).toBeNull();
    expect(page.querySelector('a[href="/operations"]')).toBeNull();
  });
});

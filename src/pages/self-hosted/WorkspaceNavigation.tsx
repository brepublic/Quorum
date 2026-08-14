import * as React from 'react';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {Dropdown, Icon, Menu, Sidebar} from 'semantic-ui-react';
import {Link, useLocation} from 'react-router-dom';
import {LanguageSwitcher, t} from '../../i18n';
import type {SelfHostedUser} from '../../services/self-hosted-identity';

export type RealtimeStatus = 'CONNECTING' | 'LIVE' | 'RESYNCING' | 'OFFLINE_READONLY' | 'DEGRADED';

const realtimeLabels: Record<RealtimeStatus, string> = {
  CONNECTING: 'Connecting', LIVE: 'Live', RESYNCING: 'Resyncing', OFFLINE_READONLY: 'Offline read-only', DEGRADED: 'Connection interrupted'
};

export function RealtimeStatusItem({status}: {status: RealtimeStatus}) {
  const icon = status === 'LIVE' ? 'check circle' : status === 'RESYNCING' || status === 'CONNECTING'
    ? 'sync alternate' : status === 'OFFLINE_READONLY' ? 'eye' : 'warning sign';
  return <Menu.Item className={`realtime-status realtime-status-${status.toLowerCase()}`} aria-live="polite">
    <Icon name={icon} aria-hidden="true" />{t(realtimeLabels[status])}
  </Menu.Item>;
}

export function AccountMenu({user, logout}: {user: SelfHostedUser; logout(): void}) {
  const openThemes = () => {
    const launcher = document.querySelector<HTMLButtonElement>('#quorum-theme-portal [aria-label="Appearance themes"], #quorum-theme-portal [aria-label="外观主题"]');
    launcher?.click();
  };
  return <Dropdown item className="account-menu" icon="user circle" text={user.displayName} aria-label={t('Account menu')}>
    <Dropdown.Menu>
      <Dropdown.Item as={Link} to="/committees" icon="users" text={t('My committees')} />
      <Dropdown.Item as={Link} to="/templates" icon="copy outline" text={t('Committee templates')} />
      <Dropdown.Item as={Link} to="/countries" icon="flag outline" text={t('Country templates')} />
      {user.isSystemAdmin && <Dropdown.Divider />}
      {user.isSystemAdmin && <Dropdown.Item as={Link} to="/admin" icon="user secret" text={t('Account administration')} />}
      {user.isSystemAdmin && <Dropdown.Item as={Link} to="/storage" icon="database" text={t('Storage configuration')} />}
      {user.isSystemAdmin && <Dropdown.Item as={Link} to="/operations" icon="heartbeat" text={t('Operations status')} />}
      <Dropdown.Divider />
      <Dropdown.Item className="account-language"><LanguageSwitcher /></Dropdown.Item>
      <Dropdown.Item icon="paint brush" text={t('Appearance themes')} onClick={openThemes} />
      <Dropdown.Divider />
      <Dropdown.Item icon="sign-out" text={t('Logout')} onClick={logout} />
    </Dropdown.Menu>
  </Dropdown>;
}

function routeActive(pathname: string, destination: string, prefix = false) {
  return prefix ? pathname === destination || pathname.startsWith(`${destination}/`) : pathname === destination;
}

function PrimaryItems({snapshot, onNavigate}: {snapshot: CommitteeWorkspaceSnapshot; onNavigate?(): void}) {
  const location = useLocation();
  const base = `/committees/${snapshot.committee.id}`;
  const item = (path: string, label: string) => <Menu.Item key={path} as={Link} to={`${base}${path}`}
    active={routeActive(location.pathname, `${base}${path}`)} onClick={onNavigate}>{t(label)}</Menu.Item>;
  const dynamic = (kind: 'caucuses' | 'resolutions' | 'strawpolls', label: string, createLabel: string,
    resources: Array<{id: string; label: string}>) => {
    const destination = `${base}/${kind}`;
    return <Dropdown key={kind} item text={t(label)}
      className={routeActive(location.pathname, destination, true) ? 'active' : undefined}>
      <Dropdown.Menu>
        <Dropdown.Item as={Link} to={`${destination}/new`} icon="add" text={t(createLabel)} onClick={onNavigate} />
        {resources.map(resource => <Dropdown.Item key={resource.id} as={Link} to={`${destination}/${resource.id}`}
          active={location.pathname === `${destination}/${resource.id}` || location.pathname.startsWith(`${destination}/${resource.id}/`)}
          text={resource.label} onClick={onNavigate} />)}
      </Dropdown.Menu>
    </Dropdown>;
  };
  const speakerLists = (snapshot.speakerLists ?? []).map(list => ({id: list.id,
    label: list.topic || (list.kind === 'GENERAL' ? t('General speakers list') : t('Moderated caucus'))}));
  const resolutions = (snapshot.documents ?? []).filter(document => document.kind === 'RESOLUTION')
    .map(document => ({id: document.id, label: document.title}));
  const strawpolls = (snapshot.strawpolls ?? []).map(poll => ({id: poll.id, label: poll.question}));

  return <>
    <Menu.Item header as={Link} to={base} active={location.pathname === base} onClick={onNavigate}>{snapshot.committee.name}</Menu.Item>
    {item('/setup', 'Venue setup')}
    {item('/roll-call', 'Roll call')}
    {item('/motions', 'Motions')}
    {item('/unmod', 'Unmoderated caucus')}
    {dynamic('caucuses', 'Speaker lists / moderated caucuses', 'Create speaker list', speakerLists)}
    {dynamic('resolutions', 'Draft resolutions', 'Create draft resolution', resolutions)}
    {dynamic('strawpolls', 'Strawpolls', 'Create strawpoll', strawpolls)}
    {item('/points', 'Points')}
    {item('/notes', 'Notes')}
    {item('/posts', 'Files')}
    {item('/stats', 'Statistics')}
    {item('/settings', 'Settings')}
    {item('/help', 'Help')}
  </>;
}

export function CommitteeNavigation({snapshot, user, logout, realtimeStatus = 'CONNECTING'}: {
  snapshot: CommitteeWorkspaceSnapshot; user?: SelfHostedUser; logout(): void; realtimeStatus?: RealtimeStatus;
}) {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  return <nav aria-label={t('Committee navigation')}>
    <Menu className="committee-primary-navigation committee-navigation-desktop" size="small" fluid>
      <PrimaryItems snapshot={snapshot} />
      <Menu.Menu position="right"><RealtimeStatusItem status={realtimeStatus} />
        {user && <AccountMenu user={user} logout={logout} />}</Menu.Menu>
    </Menu>
    <Menu className="committee-navigation-mobile" size="large">
      <Menu.Item aria-label={t('Open committee navigation')} onClick={() => setSidebarOpen(true)}><Icon name="sidebar" /></Menu.Item>
      <Menu.Item header as={Link} to={`/committees/${snapshot.committee.id}`}>{snapshot.committee.name}</Menu.Item>
      <Menu.Menu position="right">{user && <AccountMenu user={user} logout={logout} />}</Menu.Menu>
    </Menu>
    <Sidebar className="committee-mobile-sidebar" as={Menu} animation="overlay" vertical visible={sidebarOpen}
      onHide={() => setSidebarOpen(false)}>
      <Menu.Item onClick={() => setSidebarOpen(false)}><Icon name="close" />{t('Close navigation')}</Menu.Item>
      <RealtimeStatusItem status={realtimeStatus} />
      <PrimaryItems snapshot={snapshot} onNavigate={() => setSidebarOpen(false)} />
    </Sidebar>
  </nav>;
}

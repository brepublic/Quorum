import * as React from 'react';
import {useThemeFeature} from '../../theme/ThemeProvider';
import {formatCommitteeContent, type CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {Dropdown, Icon, Menu, Sidebar} from 'semantic-ui-react';
import {Link, useLocation} from 'react-router-dom';
import {LanguageSwitcher, t, useLanguage} from '../../i18n';
import type {SelfHostedUser} from '../../services/self-hosted-identity';

export type RealtimeStatus = 'CONNECTING' | 'LIVE' | 'RESYNCING' | 'OFFLINE_READONLY' | 'DEGRADED';

const realtimeLabels: Record<RealtimeStatus, string> = {
  CONNECTING: 'Connecting', LIVE: 'Live', RESYNCING: 'Resyncing', OFFLINE_READONLY: 'Offline read-only', DEGRADED: 'Connection interrupted'
};

export function RealtimeStatusItem({status, compact = false}: {status: RealtimeStatus; compact?: boolean}) {
  const icon = status === 'LIVE' ? 'check circle' : status === 'RESYNCING' || status === 'CONNECTING'
    ? 'sync alternate' : status === 'OFFLINE_READONLY' ? 'eye' : 'warning sign';
  return <Menu.Item className={`realtime-status realtime-status-${status.toLowerCase()}`} aria-live="polite"
    title={t(realtimeLabels[status])} aria-label={t(realtimeLabels[status])}>
    <Icon name={icon} aria-hidden="true" />{!compact && <span className="realtime-status-label">{t(realtimeLabels[status])}</span>}
  </Menu.Item>;
}

function AttendanceThresholdItem({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  const rollCall = snapshot.rollCall;
  const validForCurrentSession = snapshot.meetingSession !== undefined
    && rollCall?.meetingSessionId === snapshot.meetingSession.id
    && rollCall.status === "COMPLETED";
  if (!validForCurrentSession) return null;

  const presentSeatIds = new Set(snapshot.attendance.filter(item => item.state === "PRESENT").map(item => item.seatId));
  const presentSeats = snapshot.seats.filter(seat => seat.canProceduralVote && presentSeatIds.has(seat.id));
  const presentDelegates = presentSeats.length;
  const twoThirdsMajority = Math.ceil(presentDelegates * 2 / 3);
  const simpleMajority = presentDelegates > 0 ? Math.floor(presentDelegates / 2) + 1 : 0;
  const description = t("Attendance / procedural two-thirds majority / procedural simple majority");

  return <Menu.Item className="attendance-threshold-summary" title={description} aria-label={description}>
    {[presentDelegates, twoThirdsMajority, simpleMajority].join("/")}
  </Menu.Item>;
}

export function AccountMenu({user, logout}: {user: SelfHostedUser; logout(): void}) {
  const {enabled: themesEnabled} = useThemeFeature();
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
      {user.isSystemAdmin && <Dropdown.Item as={Link} to="/system-settings" icon="settings" text={t('System settings')} />}
      <Dropdown.Divider />
      <Dropdown.Item className="account-language"><LanguageSwitcher /></Dropdown.Item>
      {themesEnabled && <Dropdown.Item icon="paint brush" text={t('Appearance themes')} onClick={openThemes} />}
      <Dropdown.Divider />
      <Dropdown.Item icon="sign-out" text={t('Logout')} onClick={logout} />
    </Dropdown.Menu>
  </Dropdown>;
}

function routeActive(pathname: string, destination: string, prefix = false) {
  return prefix ? pathname === destination || pathname.startsWith(`${destination}/`) : pathname === destination;
}

function PrimaryItems({snapshot, onNavigate, onCreateCaucus, level = 0, hasPendingFileReview = false}: {
  snapshot: CommitteeWorkspaceSnapshot; onNavigate?(): void; onCreateCaucus?(): void; level?: number; hasPendingFileReview?: boolean;
}) {
  useLanguage();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [pollOpen, setPollOpen] = React.useState<string | null>(null);
  const [pollDirection, setPollDirection] = React.useState<'left' | 'right'>('left');
  const moreRef = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    if (!pollOpen) return;
    const trigger = moreRef.current?.querySelector<HTMLElement>(`[data-navigation-key="/${pollOpen}"]`);
    const menu = trigger?.querySelector<HTMLElement>(':scope > .menu');
    if (!trigger || !menu) return;
    const position = () => {
      const bounds = trigger.getBoundingClientRect();
      const width = menu.getBoundingClientRect().width;
      setPollDirection(document.documentElement.clientWidth - bounds.right >= width ? 'right' : 'left');
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [pollOpen]);
  React.useEffect(() => { setMoreOpen(false); setPollOpen(null); }, [level, location.pathname]);
  const navigate = () => { setMoreOpen(false); setPollOpen(null); onNavigate?.(); };
  const handleOverflowKey = (event: React.KeyboardEvent<HTMLSpanElement>) => {
    const target = event.target as HTMLElement;
    const trigger = target.closest<HTMLElement>('.dropdown');
    if (!trigger) return;
    const nested = trigger.classList.contains('committee-overflow-poll');
    const nestedKey = trigger.getAttribute('data-navigation-key')?.slice(1) ?? '';
    const setOpen = (value: boolean | ((open: boolean) => boolean)) => {
      if (nested) setPollOpen(current => (typeof value === 'function' ? value(current === nestedKey) : value) ? nestedKey : null);
      else setMoreOpen(value);
    };
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      setOpen(false);
      if (!nested) setPollOpen(null);
      trigger.focus();
    } else if ((event.key === 'Enter' || event.key === ' ') && target === trigger) {
      event.preventDefault(); event.stopPropagation();
      setOpen(open => !open);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      setOpen(true);
      const backwards = event.key === 'ArrowUp';
      requestAnimationFrame(() => {
        const items = [...trigger.querySelectorAll<HTMLElement>(':scope > .menu > .item')];
        const current = items.indexOf(target);
        const next = current < 0 ? (backwards ? items.length - 1 : 0)
          : (current + (backwards ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      });
    } else if (event.key === 'Enter' && target.closest('a')) {
      // Keep the link's native activation; the selection dropdown otherwise consumes Enter.
      event.stopPropagation();
    }
  };
  const base = `/committees/${snapshot.committee.id}`;
  const fileReviewDot = hasPendingFileReview && <span className="file-review-dot" aria-label={t('Pending review')} />;
  const item = (path: string, label: string) => <Menu.Item key={path} data-navigation-key={path} as={Link} to={`${base}${path}`}
    active={routeActive(location.pathname, `${base}${path}`, true)} onClick={onNavigate}>{t(label)}{path === '/posts' && fileReviewDot}</Menu.Item>;
  const dynamic = (kind: 'caucuses' | 'crises' | 'resolutions' | 'directives' | 'votes' | 'strawpolls', label: string, createLabel: string,
    resources: Array<{id: string; label: string; awaiting?: boolean; dot?: string}>, activeOverride?: boolean, nested = false) => {
    const destination = `${base}/${kind}`;
    const isActive = activeOverride !== undefined ? activeOverride : routeActive(location.pathname, destination, true);
    return <Dropdown key={kind} item trigger={<span className="text">{t(label)}{kind==='crises' && crisisDot && <span className={`crisis-time-dot ${crisisDot}`} aria-label={t(crisisDot==='red' ? 'Crisis time expired' : 'Crisis time below five minutes')} />}</span>} data-navigation-key={`/${kind}`}
      className={[isActive ? 'active' : '', nested ? 'committee-overflow-poll' : '',kind==='crises' && crises.some(group=>group.awaiting) ? 'crisis-awaiting' : ''].join(' ')}
      {...(nested ? {direction: pollDirection, open: pollOpen === kind, closeOnBlur: false, openOnFocus: false, onOpen: () => setPollOpen(kind),
        onClose: () => setPollOpen(null), icon: pollDirection === 'left' ? 'angle left' : 'angle right'} : {})}>
      <Dropdown.Menu>
        {kind === 'caucuses' && onCreateCaucus
          ? <Dropdown.Item icon="add" text={t(createLabel)} onClick={() => {navigate(); onCreateCaucus();}} />
          : <Dropdown.Item as={Link} to={`${destination}/new`} icon="add" text={t(createLabel)} onClick={navigate} />}
        {resources.map(resource => <Dropdown.Item key={resource.id} as={Link} to={`${destination}/${resource.id}`}
          active={location.pathname === `${destination}/${resource.id}` || location.pathname.startsWith(`${destination}/${resource.id}/`)}
          className={resource.awaiting ? 'crisis-awaiting' : undefined}
          text={<>{kind==='crises' ? <span className="crisis-entry-label">{resource.label}</span> : resource.label}{resource.dot && <span className={`crisis-time-dot ${resource.dot}`} aria-label={t(resource.dot==='red' ? 'Crisis time expired' : 'Crisis time below five minutes')} />}</>} onClick={navigate} />)}
      </Dropdown.Menu>
    </Dropdown>;
  };
  const generalSpeakerList = (snapshot.speakerLists ?? []).find(list => list.kind === 'GENERAL');
  const [elapsed,setElapsed] = React.useState(0);
  React.useEffect(()=> {
    const started=performance.now(); setElapsed(0);
    const timer=window.setInterval(()=>setElapsed(performance.now()-started),250);
    return ()=>window.clearInterval(timer);
  },[snapshot.crises]);
  const crises=(snapshot.crises ?? []).filter(group=>group.committeeId===snapshot.committee.id)
    .sort((a,b)=>b.sessionOrdinal-a.sessionOrdinal || b.ordinal-a.ordinal).map(group=> {
      const awaiting=!group.endedAt && group.updates.some(update=>update.status==='PENDING');
      const remaining=Math.max(0,group.timer.remainingMs-(group.timer.running ? elapsed : 0));
      return {id:group.id,label:`${t('Crisis')} ${group.sessionOrdinal}.${group.ordinal}`,awaiting,
        dot: awaiting ? remaining<=0 ? 'red' : remaining<300000 ? 'orange' : undefined : undefined};
    });
  const crisisDot=crises.some(group=>group.dot==='red') ? 'red' : crises.some(group=>group.dot==='orange') ? 'orange' : undefined;
  const gslPath = generalSpeakerList ? `${base}/caucuses/${generalSpeakerList.id}` : undefined;
  const gslPathActive = gslPath !== undefined && routeActive(location.pathname, gslPath, true);
  const caucuses = (snapshot.speakerLists ?? []).filter(list => list.kind === 'MODERATED_CAUCUS').map(list => ({id: list.id,
    label: list.name}));
  const resolutions = (snapshot.documents ?? []).filter(document => document.kind === 'RESOLUTION' && document.draftType !== 'DIRECTIVE')
    .map(document => ({id: document.id, label: document.title}));
  const directives = (snapshot.documents ?? []).filter(document => document.kind === 'RESOLUTION' && document.draftType === 'DIRECTIVE')
    .map(document => ({id: document.id, label: document.title}));
  const votes = (snapshot.documents ?? []).filter(document => document.directVote?.startedAt
    || (snapshot.ballots ?? []).some(ballot => ballot.subjectId === document.id))
    .map(document => ({id: document.id, label: t('Vote - {name}', {name: document.title})}));
  const strawpolls = (snapshot.strawpolls ?? []).filter(poll => !poll.supersededById)
    .map(poll => ({id: poll.id, label: formatCommitteeContent({kind: 'STRAWPOLL', ordinal: poll.ordinal, question: poll.question}, snapshot.committee.committeeLanguage)}));

  return <>
    <Menu.Item header title={snapshot.committee.name} as={Link} to={base + '/info'} active={location.pathname === base + '/info'} onClick={onNavigate}>{snapshot.committee.name}</Menu.Item>
    {item('/setup', 'Seats')}
    {item('/roll-call', 'Roll Call')}
    {item('/motions', 'Motions')}
    {item('/points', 'Points')}
    {generalSpeakerList && <Menu.Item key="general-speakers-list" as={Link}
      to={`${base}/caucuses/${generalSpeakerList.id}`}
      active={routeActive(location.pathname, `${base}/caucuses/${generalSpeakerList.id}`)} onClick={onNavigate}>
      {t("General Speaker's List")}</Menu.Item>}
    {item('/unmod', 'Unmoderated Caucus')}
    {level < 11 && dynamic('caucuses', 'Moderated Caucuses', 'New Moderated Caucus', caucuses, gslPathActive ? false : undefined)}
    {level < 10 && dynamic('crises', 'Crisis', 'New crisis', crises)}
    {level < 9 && dynamic('directives', 'Directives', 'New Draft Directive', directives)}
    {level < 8 && dynamic('resolutions', 'Resolutions', 'New Draft Resolution', resolutions)}
    {level < 7 && dynamic('votes', 'Voting', 'New Vote', votes)}
    {level < 6 && dynamic('strawpolls', 'Strawpolls', 'New Strawpoll', strawpolls)}
    {level < 5 && item('/notes', 'Notes')}
    {level < 4 && item('/posts', 'Files')}
    {level < 3 && item('/stats', 'Statistics')}
    {level < 2 && item('/settings', 'Settings')}
    {level < 2 && item('/help', 'Help')}
    {level >= 2 && <span ref={moreRef} className="committee-navigation-more-wrapper" onKeyDownCapture={handleOverflowKey}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {setMoreOpen(false); setPollOpen(null);}
      }}>
      <Dropdown item closeOnBlur={false} openOnFocus={false} icon={null} aria-label={t('More options')} title={t('More options')}
        className={[
          'committee-navigation-more',
          [['/settings', 2], ['/help', 2], ['/stats', 3], ['/posts', 4], ['/notes', 5], ['/strawpolls', 6], ['/votes', 7], ['/resolutions', 8], ['/directives', 9], ['/crises', 10], ['/caucuses', 11]]
            .some(([path, minimum]) => level >= Number(minimum) && routeActive(location.pathname, `${base}${path}`, true)) ? 'active' : ''
        ].join(' ')} open={moreOpen} onOpen={() => setMoreOpen(true)}
        trigger={<><Icon name="ellipsis horizontal" />{level >= 4 && hasPendingFileReview && <span className="committee-navigation-more-files">{fileReviewDot}</span>}
          {level>=10 && crisisDot && <span className={`crisis-time-dot ${crisisDot}`} aria-label={t(crisisDot==='red' ? 'Crisis time expired' : 'Crisis time below five minutes')} />}</>}
        onClose={() => {setMoreOpen(false); setPollOpen(null);}}>
        <Dropdown.Menu>
          {level >= 11 && dynamic('caucuses', 'Moderated Caucuses', 'New Moderated Caucus', caucuses, gslPathActive ? false : undefined, true)}
          {level >= 10 && dynamic('crises', 'Crisis', 'New crisis', crises, undefined, true)}
          {level >= 9 && dynamic('directives', 'Directives', 'New Draft Directive', directives, undefined, true)}
          {level >= 8 && dynamic('resolutions', 'Resolutions', 'New Draft Resolution', resolutions, undefined, true)}
          {level >= 7 && dynamic('votes', 'Voting', 'New Vote', votes, undefined, true)}
          {level >= 6 && dynamic('strawpolls', 'Strawpolls', 'New Strawpoll', strawpolls, undefined, true)}
          {level >= 5 && <Dropdown.Item as={Link} to={`${base}/notes`} active={routeActive(location.pathname, `${base}/notes`, true)} text={t('Notes')} onClick={navigate} />}
          {level >= 4 && <Dropdown.Item as={Link} to={`${base}/posts`} active={routeActive(location.pathname, `${base}/posts`, true)} text={<>{t('Files')}{fileReviewDot}</>} onClick={navigate} />}
          {level >= 3 && <Dropdown.Item as={Link} to={`${base}/stats`} active={routeActive(location.pathname, `${base}/stats`, true)} text={t('Statistics')} onClick={navigate} />}
          <Dropdown.Item as={Link} to={`${base}/settings`} active={routeActive(location.pathname, `${base}/settings`, true)} text={t('Settings')} onClick={navigate} />
          <Dropdown.Item as={Link} to={`${base}/help`} active={routeActive(location.pathname, `${base}/help`, true)} text={t('Help')} onClick={navigate} />
        </Dropdown.Menu>
      </Dropdown>
    </span>}
  </>;
}

export function CommitteeNavigation({snapshot, user, logout, realtimeStatus = 'CONNECTING', onCreateCaucus, hasPendingFileReview = false, children}: {
  snapshot: CommitteeWorkspaceSnapshot; user?: SelfHostedUser; logout(): void; realtimeStatus?: RealtimeStatus;
  onCreateCaucus?(): void; hasPendingFileReview?: boolean; children?: React.ReactNode;
}) {
  const language = useLanguage();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [level, setLevel] = React.useState(0);
  const [crisisReminderRed, setCrisisReminderRed] = React.useState(true);
  const hasPendingCrisis = (snapshot.crises ?? []).some(group => group.committeeId === snapshot.committee.id
    && !group.endedAt && group.updates.some(update => update.status === 'PENDING'));
  React.useEffect(() => {
    setCrisisReminderRed(true);
    if (!hasPendingCrisis) return;
    const timer = window.setInterval(() => setCrisisReminderRed(red => !red), 1_000);
    return () => window.clearInterval(timer);
  }, [hasPendingCrisis]);
  const crisisReminder = crisisReminderRed ? 'red' : 'black';
  const measurementRef = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    const container = measurementRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const menu = container.querySelector<HTMLElement>('.committee-primary-navigation')!;
    const measure = () => {
      const available = container.getBoundingClientRect().width;
      if (!available) return;
      const width = (selector: string) => menu.querySelector(selector)?.getBoundingClientRect().width ?? 0;
      // Measure the full, inert menu even while its visible counterpart is folded.
      // A small restoration margin prevents fractional-width oscillation.
      const full = [...menu.children].reduce((sum, child) => sum + child.getBoundingClientRect().width, 2);
      const more = width('.committee-navigation-more');
      const moreFiles = width('.committee-navigation-more-files');
      const required = [full - more];
      required.push(required[0] - width('.realtime-status-label'));
      required.push(required[1] - width('[data-navigation-key="/settings"]') - width('[data-navigation-key="/help"]') + more - moreFiles);
      for (const path of ['/stats', '/posts', '/notes', '/strawpolls', '/votes', '/resolutions', '/directives', '/crises', '/caucuses']) {
        required.push(required[required.length - 1] - width(`[data-navigation-key="${path}"]`) + (path === '/posts' ? moreFiles : 0));
      }
      setLevel(previous => {
        const next = required.findIndex((needed, index) => needed + (index < previous ? 4 : 0) <= available);
        return next < 0 ? 12 : next;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(menu);
    for (const element of [...menu.children, ...menu.querySelectorAll('.realtime-status-label')]) observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [snapshot, user, realtimeStatus, language, hasPendingFileReview]);
  React.useEffect(() => { setSidebarOpen(false); }, [level]);
  const mode = level === 12 ? 'sidebar' : 'desktop';
  return <>
    <nav data-navigation-mode={mode} data-collapse-level={level} className="committee-navigation-desktop" aria-label={t('Committee navigation')}>
      <Menu className="committee-primary-navigation" size="large" fluid data-crisis-reminder={crisisReminder}>
        <PrimaryItems snapshot={snapshot} onCreateCaucus={onCreateCaucus} level={level} hasPendingFileReview={hasPendingFileReview} />
        <Menu.Menu position="right"><AttendanceThresholdItem snapshot={snapshot} /><RealtimeStatusItem status={realtimeStatus} compact={level >= 1} />
          {user && <AccountMenu user={user} logout={logout} />}</Menu.Menu>
      </Menu>
    </nav>
    <div className="committee-navigation-measurement" aria-hidden="true" ref={element => {
      measurementRef.current = element;
      element?.setAttribute('inert', '');
    }}>
      <Menu className="committee-primary-navigation" size="large" data-crisis-reminder={crisisReminder}>
        <PrimaryItems snapshot={snapshot} hasPendingFileReview={hasPendingFileReview} />
        <Menu.Item className="committee-navigation-more"><Icon name="ellipsis horizontal" />
          {hasPendingFileReview && <span className="committee-navigation-more-files"><span className="file-review-dot" /></span>}</Menu.Item>
        <Menu.Menu position="right"><AttendanceThresholdItem snapshot={snapshot} /><RealtimeStatusItem status={realtimeStatus} />
          {user && <AccountMenu user={user} logout={logout} />}</Menu.Menu>
      </Menu>
    </div>
    <Sidebar.Pushable className="committee-navigation-pushable" data-navigation-mode={mode}>
      <Sidebar className="committee-mobile-sidebar" as={Menu} animation="uncover" vertical visible={sidebarOpen}
        data-crisis-reminder={crisisReminder}
        onHide={() => setSidebarOpen(false)}>
        <AttendanceThresholdItem snapshot={snapshot} /><RealtimeStatusItem status={realtimeStatus} />
        <PrimaryItems snapshot={snapshot} onNavigate={() => setSidebarOpen(false)} onCreateCaucus={onCreateCaucus} hasPendingFileReview={hasPendingFileReview} />
      </Sidebar>
      <Sidebar.Pusher dimmed={sidebarOpen} onClick={() => sidebarOpen && setSidebarOpen(false)}>
        <nav aria-label={t('Committee navigation')}>
          <Menu className="committee-navigation-mobile" size="large">
            <Menu.Item as="button" type="button" aria-expanded={sidebarOpen} aria-label={t('Open committee navigation')} onClick={() => setSidebarOpen(open => !open)}>
              <Icon name="sidebar" />
            </Menu.Item>
            <Menu.Item header as={Link} to={'/committees/' + snapshot.committee.id + '/info'}>{snapshot.committee.name}</Menu.Item>
            <Menu.Menu position="right">{user && <AccountMenu user={user} logout={logout} />}</Menu.Menu>
          </Menu>
        </nav>
        {children}
      </Sidebar.Pusher>
    </Sidebar.Pushable>
  </>;
}

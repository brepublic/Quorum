import * as React from 'react';
import type {
  CommitteeNote,
  CommitteePoint,
  AttendanceEventType,
  PointStatus,
  CommitteeTemplate,
  CommitteeTextPost,
  CommitteeWorkspaceSnapshot,
  CountryTemplate,
  Stage4CommitteeSeat
} from '@quorum/contracts';
import {Link, Redirect, Route, Switch, useHistory, useLocation, useParams} from 'react-router-dom';
import {Button, Card, Checkbox, Confirm, Container, Form, Grid, Header, Icon, Label, List, Menu, Message, Pagination, Popup, Segment, Table} from 'semantic-ui-react';
import Loading from '../components/Loading';
import {LanguageMenuItem, t} from '../i18n';
import {selfHostedApi, type SelfHostedApi} from '../services/self-hosted-api';
import type {SelfHostedUser} from '../services/self-hosted-identity';
import ProceedingsPanel from './self-hosted/ProceedingsPanel';
import FilesPanel from './self-hosted/FilesPanel';
import StorageAdminPanel from './self-hosted/StorageAdminPanel';
import OperationsPanel from './self-hosted/OperationsPanel';
import {AccountMenu, CommitteeNavigation} from './self-hosted/WorkspaceNavigation';
import {CommitteeWorkspaceProvider, useCommitteeWorkspace} from './self-hosted/CommitteeWorkspaceContext';
import {
  CommitteeTemplateManager,
  CountryTemplateManager,
  localizedDisplayName,
  TemplatePreview
} from './self-hosted/TemplateManagers';

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function Flag({seat}: {seat: Pick<Stage4CommitteeSeat, 'flag' | 'displayName'>}) {
  if (seat.flag.type === 'IMAGE') return <span className="country-flag-display" aria-hidden="true">
    <img className="country-flag-display-image" src={seat.flag.value} alt="" />
  </span>;
  if (seat.flag.type === 'STANDARD') return <span className={`country-flag-display fi fi-${seat.flag.value}`} aria-hidden="true" />;
  return <span className="country-flag-display country-flag-display-emoji" aria-hidden="true">{seat.flag.value}</span>;
}

function AppMenu({user, logout}: {user: SelfHostedUser; logout(): void}) {
  return <Menu>
    <Menu.Item header as={Link} to="/committees">Quorum</Menu.Item>
    <Menu.Menu position="right"><AccountMenu user={user} logout={logout} /></Menu.Menu>
  </Menu>;
}

function CommitteeList({api, user, logout}: {api: SelfHostedApi; user: SelfHostedUser; logout(): void}) {
  const history = useHistory(); const [committees, setCommittees] = React.useState<Awaited<ReturnType<SelfHostedApi['listCommittees']>>>([]);
  const [countryTemplates, setCountryTemplates] = React.useState<CountryTemplate[]>([]);
  const [committeeTemplates, setCommitteeTemplates] = React.useState<CommitteeTemplate[]>([]);
  const [name, setName] = React.useState(''); const [topic, setTopic] = React.useState(''); const [conference, setConference] = React.useState('');
  const [visibility, setVisibility] = React.useState<'PUBLIC' | 'PRIVATE'>('PRIVATE');
  const [templateId, setTemplateId] = React.useState(''); const [countryKey, setCountryKey] = React.useState('builtin:default');
  const [error, setError] = React.useState<string>(); const [working, setWorking] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const refresh = React.useCallback(async () => {
    try {
      const [nextCommittees, nextCountries, nextTemplates] = await Promise.all([
        api.listCommittees(), api.listCountryTemplates(), api.listCommitteeTemplates()
      ]);
      setCommittees(nextCommittees); setCountryTemplates(nextCountries); setCommitteeTemplates(nextTemplates);
    } catch (caught) { setError(errorText(caught)); } finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => void refresh(), [refresh]);
  const create = async () => {
    setWorking(true); setError(undefined);
    try {
      const committee = await api.createCommittee({name: name.trim(), topic: topic.trim(), conference: conference.trim(), visibility,
        ...(templateId ? {committeeTemplateId: templateId} : {countryTemplateKey: countryKey})});
      history.push(`/committees/${committee.id}`);
    } catch (caught) { setError(errorText(caught)); } finally { setWorking(false); }
  };
  const committeeList = loading ? <Loading /> : committees.length === 0
    ? <Message content={t('No committees created')} />
    : <Card.Group itemsPerRow={1}>{committees.map(committee => <Card fluid key={committee.id} as={Link}
      to={`/committees/${committee.id}`}>
      <Card.Content><Card.Header>{committee.name}</Card.Header><Card.Meta>{t(committee.status)}</Card.Meta></Card.Content>
    </Card>)}</Card.Group>;
  return <Container text className="committee-create-page">
    <Header as="h1" textAlign="center">Quorum</Header>{error && <Message error content={error} />}
    <Grid columns="equal" stackable>
      <Grid.Column><Segment>
        <Header as="h3">{user.displayName}</Header>
        <Header as="h4" dividing>{t('My committees')}</Header>
        {committeeList}
        <Button basic negative fluid icon="sign-out" content={t('Logout')} onClick={logout} />
      </Segment></Grid.Column>
      <Grid.Column><Segment><Form onSubmit={create} loading={working}>
      <Form.Group unstackable className="template-picker-row">
        <Form.Dropdown className="template-picker-field" label={t('Template')} search clearable fluid selection
          placeholder={t('Template to skip manual member creation (optional)')} value={templateId}
          options={committeeTemplates.map(item => ({key: item.id, value: item.id,
            text: localizedDisplayName(item.names, item.defaultLanguage), description: item.builtin ? t('Built-in') : t('My template')}))}
          onChange={(_, data) => {const nextId = String(data.value ?? ''); const selected = committeeTemplates.find(item => item.id === nextId);
            setTemplateId(nextId); if (selected) {setCountryKey(selected.countryTemplateKey); setName(localizedDisplayName(selected.names, selected.defaultLanguage));}}} />
        <Popup basic pinned hoverable position="bottom left" trigger={<Form.Button type="button" icon="question circle outline" />}>
          <Popup.Content><TemplatePreview template={committeeTemplates.find(item => item.id === templateId)} /></Popup.Content>
        </Popup>
      </Form.Group>
      <Form.Select className="template-picker-field" label={t('Country template')} required disabled={!!templateId} value={countryKey}
        options={countryTemplates.map(item => ({key: item.key, value: item.key, text: localizedDisplayName(item.names, item.defaultLanguage),
          description: item.builtin ? t('Built-in') : t('My template')}))}
        onChange={(_, data) => setCountryKey(String(data.value))} />
      <Form.Input label={t('Name')} required fluid value={name} placeholder={t('Committee name')}
        onChange={event => setName(event.currentTarget.value)} />
      <Form.Input label={t('Topic')} fluid value={topic} placeholder={t('Committee topic')}
        onChange={event => setTopic(event.currentTarget.value)} />
      <Form.Input label={t('Conference')} fluid value={conference} placeholder={t('Conference name')}
        onChange={event => setConference(event.currentTarget.value)} />
      <Form.Select label={t('Visibility')} value={visibility} options={[
        {key: 'private', value: 'PRIVATE', text: t('Private')}, {key: 'public', value: 'PUBLIC', text: t('Public')}
      ]} onChange={(_, data) => setVisibility(data.value as 'PUBLIC' | 'PRIVATE')} />
      <Button primary fluid disabled={!name.trim() || (!templateId && !countryKey)}>{t('Create committee')}<Icon name="arrow right" /></Button>
    </Form></Segment></Grid.Column>
    </Grid>
  </Container>;
}

export function SelfHostedPublicCommittees({api = selfHostedApi}: {api?: SelfHostedApi}) {
  const [committees, setCommittees] = React.useState<Awaited<ReturnType<SelfHostedApi['listCommittees']>>>([]);
  const [error, setError] = React.useState<string>(); const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    void api.listCommittees().then(items => { if (active) setCommittees(items); })
      .catch(caught => { if (active) setError(errorText(caught)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);
  return <>
    <Menu><Menu.Item header>Quorum</Menu.Item><Menu.Menu position="right">
      <LanguageMenuItem /><Menu.Item as={Link} to="/login">{t('Login')}</Menu.Item>
    </Menu.Menu></Menu>
    <Container style={{padding: '1em'}}>
      <Header as="h1">{t('Public committees')}</Header>
      {error && <Message error content={error} />}
      {loading ? <Loading /> : !error && committees.length === 0 ? <Message content={t('No public committees')} /> : <Card.Group>
        {committees.map(committee => <Card key={committee.id} as={Link} to={`/committees/${committee.id}`}>
          <Card.Content><Card.Header>{committee.name}</Card.Header><Card.Meta>{t(committee.status)}</Card.Meta></Card.Content>
        </Card>)}
      </Card.Group>}
    </Container>
  </>;
}

function TextResources({kind, snapshot, run, api}: {kind: 'notes' | 'posts'; snapshot: CommitteeWorkspaceSnapshot;
  run(operation: () => Promise<unknown>): Promise<void>; api: SelfHostedApi}) {
  const [title, setTitle] = React.useState(''); const [content, setContent] = React.useState('');
  const [editingId, setEditingId] = React.useState<string>(); const [editTitle, setEditTitle] = React.useState('');
  const [editContent, setEditContent] = React.useState(''); const [pending, setPending] = React.useState<string>();
  const resources = kind === 'notes' ? snapshot.notes : snapshot.textPosts;
  const canWrite = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  const create = async () => { if (kind === 'notes') await run(() => api.createNote(snapshot.committee.id, {title, content}));
    else await run(() => api.createTextPost(snapshot.committee.id, {title, content})); setTitle(''); setContent(''); };
  const edit = async (resource: CommitteeNote | CommitteeTextPost) => {
    setPending(`edit:${resource.id}`);
    try {
      if (kind === 'notes') await run(() => api.updateNote(resource.id, resource.revision, {title: editTitle, content: editContent}));
      else await run(() => api.updateTextPost(resource.id, resource.revision, {title: editTitle, content: editContent}));
      setEditingId(undefined);
    } finally {setPending(undefined);}
  };
  const remove = (resource: CommitteeNote | CommitteeTextPost) => kind === 'notes'
    ? run(() => api.deleteNote(resource.id, resource.revision))
    : run(() => api.deleteTextPost(resource.id, resource.revision));
  return <>{canWrite && <Form onSubmit={create}><Form.Input label={t('Title')} value={title} onChange={e => setTitle(e.currentTarget.value)} />
    <Form.TextArea label={t('Content')} required value={content} onChange={(_, data) => setContent(String(data.value))} />
    <Button primary disabled={!content}>{kind === 'notes' ? t('Create note') : t('Create text post')}</Button></Form>}
    <List divided relaxed>{resources.map(resource => <List.Item key={resource.id}>{canWrite && editingId !== resource.id && <List.Content floated="right">
      <Button size="mini" onClick={() => {setEditingId(resource.id); setEditTitle(resource.title); setEditContent(resource.content);}}>{t('Edit')}</Button>
      <Button size="mini" negative onClick={() => void remove(resource)}>{t('Delete')}</Button></List.Content>}
      {editingId === resource.id ? <Form onSubmit={() => edit(resource)}><Form.Input label={t('Title')} value={editTitle}
        onChange={event => setEditTitle(event.currentTarget.value)} /><Form.TextArea label={t('Content')} value={editContent}
        onChange={(_, data) => setEditContent(String(data.value))} /><Button primary size="mini" loading={pending === `edit:${resource.id}`}
        disabled={!editContent.trim()}>{t('Save changes')}</Button><Button type="button" size="mini" onClick={() => setEditingId(undefined)}>
          {t('Cancel')}</Button></Form> : <><List.Header>{resource.title || t('Untitled')}</List.Header>
        <List.Description style={{whiteSpace: 'pre-wrap'}}>{resource.content}</List.Description></>}
    </List.Item>)}</List></>;
}

function NotesPanel({snapshot, run, api}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand; api: SelfHostedApi}) {
  const [selectedId, setSelectedId] = React.useState<string | undefined>(snapshot.notes[0]?.id);
  const selected = snapshot.notes.find(note => note.id === selectedId);
  const [title, setTitle] = React.useState(selected?.title ?? ''); const [content, setContent] = React.useState(selected?.content ?? '');
  const [pending, setPending] = React.useState<'save' | 'delete'>();
  const [dirty, setDirty] = React.useState(false);
  const editVersion = React.useRef(0);
  const canWrite = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  React.useEffect(() => {
    if (dirty) return;
    const next = snapshot.notes.find(note => note.id === selectedId);
    setTitle(next?.title ?? ''); setContent(next?.content ?? '');
  }, [dirty, selectedId, selected?.revision, snapshot.notes]);
  const saveDraft = React.useCallback(async (selectCreated: boolean): Promise<boolean> => {
    if (!canWrite || !dirty || !content.trim()) return true;
    if (pending) return false;
    const version = editVersion.current; let saved = false; let createdId: string | undefined;
    setPending('save');
    await run(async () => {
      if (selected) await api.updateNote(selected.id, selected.revision, {title, content});
      else createdId = (await api.createNote(snapshot.committee.id, {title, content})).id;
      saved = true;
    });
    if (saved && editVersion.current === version) {
      setDirty(false);
      if (selectCreated && createdId) setSelectedId(createdId);
    }
    setPending(undefined);
    return saved;
  }, [api, canWrite, content, dirty, pending, run, selected, snapshot.committee.id, title]);
  React.useEffect(() => {
    if (!canWrite || !dirty || !content.trim() || pending) return;
    const timeout = window.setTimeout(() => {void saveDraft(true);}, 600);
    return () => window.clearTimeout(timeout);
  }, [canWrite, content, dirty, pending, saveDraft]);
  const selectNote = async (id: string | undefined) => {
    if (id === selectedId || pending) return;
    if (!await saveDraft(false)) return;
    setDirty(false); setSelectedId(id);
  };
  const remove = async () => {
    if (!selected) return;
    setPending('delete');
    try {await run(() => api.deleteNote(selected.id, selected.revision)); setSelectedId(undefined);}
    finally {setPending(undefined);}
  };
  return <div className="notes-editor">
    <Menu vertical fluid aria-label={t('Note list')}>
      {snapshot.notes.map(note => <Menu.Item key={note.id} active={note.id === selectedId}
        onClick={() => void selectNote(note.id)}>
        {note.title || t('Untitled')}</Menu.Item>)}
      {canWrite && <Menu.Item active={!selectedId} onClick={() => void selectNote(undefined)}><Icon name="plus" />{t('New note')}</Menu.Item>}
    </Menu>
    <Form>
      <Form.Input label={t('Title')} value={title} readOnly={!canWrite}
        onChange={event => {editVersion.current += 1; setTitle(event.currentTarget.value); setDirty(true);}} />
      <Form.TextArea label={t('Content')} value={content} readOnly={!canWrite}
        onChange={(_, data) => {editVersion.current += 1; setContent(String(data.value)); setDirty(true);}} />
      {canWrite && selected && <Button type="button" negative loading={pending === 'delete'} onClick={() => void remove()}>{t('Delete')}</Button>}
    </Form>
  </div>;
}

function LinkResources({snapshot, run, api}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand; api: SelfHostedApi}) { const [title, setTitle] = React.useState(''); const [url, setUrl] = React.useState(''); const canWrite = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE'; const links = snapshot.textPosts.filter(post => post.content.startsWith('link:')).map(post => ({post, url: post.content.slice(5)})).filter(({url}) => {try {return ['http:', 'https:'].includes(new URL(url).protocol);} catch {return false;}}); const create = async () => {if (url.trim()) {await run(() => api.createTextPost(snapshot.committee.id, {title, content: `link:${url.trim()}`})); setTitle(''); setUrl('');}}; return <><Form onSubmit={create}>{canWrite && <><Form.Input label={t('Title')} value={title} onChange={event => setTitle(event.currentTarget.value)} /><Form.Input label={t('URL')} type="url" required value={url} onChange={event => setUrl(event.currentTarget.value)} /><Button primary disabled={!url.trim()}>{t('Publish link')}</Button></>}</Form><List divided relaxed>{links.map(({post, url}) => <List.Item key={post.id}>{canWrite && <List.Content floated="right"><Button size="mini" negative onClick={() => void run(() => api.deleteTextPost(post.id, post.revision))}>{t('Delete')}</Button></List.Content>}<List.Header>{post.title || t('Untitled')}</List.Header><List.Description><a href={url} target="_blank" rel="noreferrer">{url}</a></List.Description><List.Description>{t('Publisher')}: {post.authorDisplayName}</List.Description></List.Item>)}</List></>; }
function PostsPanel({snapshot, run, api, userId, tab}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand;
  api: SelfHostedApi; userId?: string; tab?: string}) {
  const canManageStorage = snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER';
  const active = tab === 'links' || tab === 'attachments' || tab === 'storage' ? tab : 'text';
  const base = `/committees/${snapshot.committee.id}/posts`;
  return <><Menu pointing secondary aria-label={t('Resource sections')}>
    <Menu.Item as={Link} to={base} active={active === 'text'}>{t('Text resources')}</Menu.Item>
    <Menu.Item as={Link} to={`${base}/links`} active={active === 'links'}>{t('Link resources')}</Menu.Item>
    <Menu.Item as={Link} to={`${base}/attachments`} active={active === 'attachments'}>{t('Attachments')}</Menu.Item>
    {canManageStorage && <Menu.Item as={Link} to={`${base}/storage`} active={active === 'storage'}>{t('Storage')}</Menu.Item>}
  </Menu>
    {active === 'text' && <TextResources kind="posts" snapshot={snapshot} run={run} api={api} />}
    {active === 'links' && <LinkResources snapshot={snapshot} run={run} api={api} />}
    {active === 'attachments' && <FilesPanel section="attachments" snapshot={snapshot} api={api} currentUserId={userId} />}
    {active === 'storage' && canManageStorage && <FilesPanel section="storage" snapshot={snapshot} api={api} currentUserId={userId} />}
  </>;
}

type WorkspaceCommand = (operation: () => Promise<unknown>) => Promise<void>;
const ROLL_CALL_PAGE_SIZE = 18;

function rollCallResponseLabel(response: string) {
  return t(response === 'PRESENT_AND_VOTING' ? 'Present and voting'
    : response === 'PRESENT' ? 'Present' : response === 'ABSENT' ? 'Absent' : response);
}

function CommitteeOverviewPanel({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  const share = async () => navigator.clipboard?.writeText(`${window.location.origin}/committees/${snapshot.committee.id}`);
  return <>
    <Header as="h1">{snapshot.committee.name}</Header>
    <List relaxed>
      <List.Item><List.Icon name="conversation" /><List.Content><List.Header>{t('Topic')}</List.Header>
        <List.Description>{snapshot.committee.topic || '—'}</List.Description></List.Content></List.Item>
      <List.Item><List.Icon name="building outline" /><List.Content><List.Header>{t('Conference')}</List.Header>
        <List.Description>{snapshot.committee.conference || '—'}</List.Description></List.Content></List.Item>
      <List.Item><List.Icon name="signal" /><List.Content><List.Header>{t('Meeting status')}</List.Header>
        <List.Description>{t(snapshot.committee.status)}{snapshot.meetingSession ? ` · ${t(snapshot.meetingSession.status)}` : ''}</List.Description>
      </List.Content></List.Item>
    </List>
    <Button icon="share alternate" content={t('Share committee')} onClick={() => void share()} />
  </>;
}

function SetupPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand;
  api: SelfHostedApi; canChair: boolean}) {
  const [seatName, setSeatName] = React.useState('');
  const [seatRank, setSeatRank] = React.useState<'STANDARD' | 'VETO' | 'NGO' | 'OBSERVER'>('STANDARD');
  const [seatCanVote, setSeatCanVote] = React.useState(true); const [seatMustVote, setSeatMustVote] = React.useState(false);
  const [chairEmail, setChairUserId] = React.useState(''); const [assignmentEmail, setAssignmentUserId] = React.useState('');
  const [assignmentSeatId, setAssignmentSeatId] = React.useState(snapshot.seats[0]?.id ?? '');
  const [invitationSeatId, setInvitationSeatId] = React.useState(snapshot.seats[0]?.id ?? '');
  const [invitationExpiresAt, setInvitationExpiresAt] = React.useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  const [invitationCode, setInvitationCode] = React.useState<string>(); const [pending, setPending] = React.useState<string>();
  const [seatNames, setSeatNames] = React.useState<Record<string, string>>(() => Object.fromEntries(snapshot.seats.map(seat => [seat.id, seat.displayName])));
  const owner = snapshot.viewer.audience === 'OWNER';
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const execute = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key); try {await run(operation);} finally {setPending(undefined);}
  };
  const createInvitation = async () => {
    let created: Awaited<ReturnType<SelfHostedApi['createSeatInvitation']>> | undefined;
    await execute('invitation', async () => {created = await api.createSeatInvitation(snapshot.committee.id,
      {seatId: invitationSeatId, maxUses: 1, expiresAt: new Date(invitationExpiresAt).toISOString()});});
    if (created) setInvitationCode(created.code);
  };
  const rankOptions = (['STANDARD', 'VETO', 'NGO', 'OBSERVER'] as const)
    .map(value => ({key: value, value, text: t(value)}));
  return <Container className="committee-setup-page"><Grid columns={2} stackable><Grid.Row>
    <Grid.Column width={9}><Header as="h2">{t('Seats')}</Header>
    <Table className="members-table" compact celled definition stackable><Table.Header><Table.Row>
      <Table.HeaderCell>{t('Seat')}</Table.HeaderCell><Table.HeaderCell>{t('Rank')}</Table.HeaderCell>
      <Table.HeaderCell>{t('Voting')}</Table.HeaderCell><Table.HeaderCell>{t('Must Vote')}</Table.HeaderCell>
      {canChair && !readOnly && <Table.HeaderCell />}</Table.Row>
      {canChair && !readOnly && <Table.Row><Table.HeaderCell><Form.Input aria-label={t('Seat name')} required
        value={seatName} onChange={event => setSeatName(event.currentTarget.value)} /></Table.HeaderCell>
        <Table.HeaderCell><Form.Select aria-label={t('Rank')} search selection fluid value={seatRank} options={rankOptions}
          onChange={(_, data) => {const rank = data.value as typeof seatRank; setSeatRank(rank);
            if (rank === 'VETO') setSeatCanVote(true);}} /></Table.HeaderCell>
        <Table.HeaderCell collapsing><Form.Checkbox aria-label={t('Voting')} toggle checked={seatCanVote}
          disabled={seatRank === 'VETO'} onChange={(_, data) => {const canVote = data.checked ?? false;
            setSeatCanVote(canVote); if (!canVote) setSeatMustVote(false);}} /></Table.HeaderCell>
        <Table.HeaderCell collapsing><Form.Checkbox aria-label={t('Must Vote')} toggle checked={seatMustVote}
          disabled={!seatCanVote} onChange={(_, data) => setSeatMustVote(data.checked ?? false)} /></Table.HeaderCell>
        <Table.HeaderCell collapsing><Button icon="plus" primary basic aria-label={t('Create seat')}
          loading={pending === 'create-seat'} disabled={!seatName.trim()} onClick={() => void (async () => {
            await execute('create-seat', () => api.createSeat(snapshot.committee.id, {
              stableKey: seatName.trim().toLowerCase().replace(/\s+/g, '-'), displayName: seatName.trim(), rank: seatRank,
              canVote: seatCanVote, hasVeto: seatRank === 'VETO', mustVote: seatMustVote, sortOrder: snapshot.seats.length}));
            setSeatName(''); setSeatRank('STANDARD'); setSeatCanVote(true); setSeatMustVote(false);
          })()} /></Table.HeaderCell></Table.Row>}
      </Table.Header><Table.Body>{snapshot.seats.map(seat => <Table.Row key={seat.id}><Table.Cell><Flag seat={seat} />
        {canChair && !readOnly ? <Form.Input aria-label={`${t('Seat name')} · ${seat.displayName}`}
          value={seatNames[seat.id] ?? seat.displayName}
          onChange={event => setSeatNames(current => ({...current, [seat.id]: event.currentTarget.value}))}
          onBlur={() => {const name = seatNames[seat.id]?.trim(); if (name && name !== seat.displayName)
            void execute(`rename-${seat.id}`, () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision,
              {displayName: name}));}} /> : seat.displayName}</Table.Cell>
        <Table.Cell>{canChair && !readOnly ? <Form.Select aria-label={`${t('Rank')} · ${seat.displayName}`}
          search selection fluid value={seat.rank} options={rankOptions} onChange={(_, data) => {
            const rank = data.value as typeof seatRank; void execute(`rank-${seat.id}`, () => api.updateSeat(snapshot.committee.id,
              seat.id, seat.revision, {rank, hasVeto: rank === 'VETO', ...(rank === 'VETO' ? {canVote: true} : {})}));
          }} /> : t(seat.rank)}</Table.Cell>
        <Table.Cell collapsing>{canChair && !readOnly ? <Form.Checkbox aria-label={`${t('Voting')} · ${seat.displayName}`}
          toggle checked={seat.canVote} disabled={seat.rank === 'VETO'} onChange={(_, data) => {
            const canVote = data.checked ?? false; void execute(`voting-${seat.id}`, () => api.updateSeat(snapshot.committee.id,
              seat.id, seat.revision, {canVote, hasVeto: canVote && seat.hasVeto, mustVote: canVote && seat.mustVote}));
          }} /> : seat.canVote ? t('Voting') : t('Non-voting')}</Table.Cell>
        <Table.Cell collapsing>{canChair && !readOnly ? <Form.Checkbox aria-label={`${t('Must Vote')} · ${seat.displayName}`}
          toggle checked={seat.mustVote} disabled={!seat.canVote} onChange={(_, data) => void execute(`must-vote-${seat.id}`,
            () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {mustVote: data.checked ?? false}))} />
          : seat.mustVote ? t('Yes') : t('No')}</Table.Cell>
        {canChair && !readOnly && <Table.Cell collapsing><Button icon="trash" basic negative
          aria-label={`${t('Deactivate')} · ${seat.displayName}`} loading={pending === `deactivate-${seat.id}`} onClick={() => {
            if (window.confirm(t('Deactivate seat?'))) void execute(`deactivate-${seat.id}`,
              () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {active: false}));}} /></Table.Cell>}
      </Table.Row>)}</Table.Body></Table>
      {snapshot.seats.length > 0 && <Button as={Link} to={`/committees/${snapshot.committee.id}/roll-call`} primary fluid>
        {t('Roll call')}<Icon name="arrow right" /></Button>}
    </Grid.Column><Grid.Column width={7}>
    {owner && !readOnly && <><Header as="h2">{t('Chairs')}</Header>
      <Form onSubmit={async () => {await execute('grant-chair', () => api.grantChair(snapshot.committee.id,
        chairEmail.trim(), snapshot.committee.revision)); setChairUserId('');}}>
        <Form.Input label={t('Email')} required value={chairEmail} onChange={event => setChairUserId(event.currentTarget.value)} />
        <Button primary loading={pending === 'grant-chair'} disabled={!chairEmail.trim()}>{t('Grant Chair')}</Button>
      </Form>
      <List divided>{(snapshot.chairs ?? []).map(chair => <List.Item key={chair.userEmail}>
        <List.Content floated="right"><Button size="mini" negative loading={pending === `chair-${chair.userEmail}`}
          onClick={() => void execute(`chair-${chair.userEmail}`, () => api.revokeChair(snapshot.committee.id,
            chair.userEmail, snapshot.committee.revision))}>{t('Revoke Chair')}</Button></List.Content>
        <List.Content>{chair.userEmail}</List.Content>
      </List.Item>)}</List></>}
    {canChair && !readOnly && snapshot.seats.length > 0 && <>
      <Header as="h2">{t('Seat assignments')}</Header>
      <Form onSubmit={async () => {await execute('assign-seat', () => api.assignSeat(snapshot.committee.id,
        assignmentSeatId, assignmentEmail.trim())); setAssignmentUserId('');}}>
        <Form.Select label={t('Seat')} value={assignmentSeatId} options={snapshot.seats.map(seat =>
          ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setAssignmentSeatId(String(data.value))} />
        <Form.Input label={t('Email')} required value={assignmentEmail} onChange={event => setAssignmentUserId(event.currentTarget.value)} />
        <Button primary loading={pending === 'assign-seat'} disabled={!assignmentSeatId || !assignmentEmail.trim()}>{t('Assign seat')}</Button>
      </Form>
      <List divided>{(snapshot.assignments ?? []).map(assignment => <List.Item key={assignment.id}>
        <List.Content floated="right"><Button size="mini" negative loading={pending === `assignment-${assignment.id}`}
          onClick={() => void execute(`assignment-${assignment.id}`,
            () => api.endSeatAssignment(snapshot.committee.id, assignment.id))}>{t('End assignment')}</Button></List.Content>
        <List.Header>{snapshot.seats.find(seat => seat.id === assignment.seatId)?.displayName ?? assignment.seatId}</List.Header>
        <List.Description>{assignment.userEmail}</List.Description>
      </List.Item>)}</List>
      <Header as="h2">{t('One-time seat invitation')}</Header>
      <Form onSubmit={createInvitation}>
        <Form.Select label={t('Seat')} value={invitationSeatId} options={snapshot.seats.map(seat =>
          ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setInvitationSeatId(String(data.value))} />
        <Form.Input label={t('Expires at')} type="datetime-local" required value={invitationExpiresAt}
          onChange={event => setInvitationExpiresAt(event.currentTarget.value)} />
        <Button primary loading={pending === 'invitation'} disabled={!invitationSeatId || !invitationExpiresAt}>{t('Create invitation')}</Button>
      </Form>
      {invitationCode && <Message positive header={t('Invitation created')} content={<code>{invitationCode}</code>} />}
    </>}
    </Grid.Column></Grid.Row></Grid></Container>;
}

function SettingsPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand;
  api: SelfHostedApi; canChair: boolean}) {
  const history = useHistory();
  const [name, setName] = React.useState(snapshot.committee.name); const [topic, setTopic] = React.useState(snapshot.committee.topic);
  const [conference, setConference] = React.useState(snapshot.committee.conference);
  const [visibility, setVisibility] = React.useState(snapshot.committee.visibility); const [pending, setPending] = React.useState<string>();
  const [operationMode, setOperationMode] = React.useState(snapshot.committee.operationMode);
  const [rulePackages, setRulePackages] = React.useState<Awaited<ReturnType<SelfHostedApi['listRulePackages']>>>([]);
  const [ruleVersionId, setRuleVersionId] = React.useState(snapshot.committee.activeRulePackageVersionId);
  const [deleteName, setDeleteName] = React.useState('');
  const owner = snapshot.viewer.audience === 'OWNER';
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const execute = async (key: string, operation: () => Promise<unknown>) => {setPending(key); try {await run(operation);} finally {setPending(undefined);}};
  React.useEffect(() => {if (canChair) void api.listRulePackages().then(setRulePackages);}, [api, canChair]);
  const ruleOptions = rulePackages.flatMap(rulePackage => rulePackage.versions.filter(version => version.status === 'PUBLISHED')
    .map(version => ({key: version.id, value: version.id, text: `${rulePackage.key} · v${version.version}`})));
  const setLayoutSetting = (patch: Partial<CommitteeWorkspaceSnapshot['layoutSettings']>) => execute('layout', () =>
    api.setLayoutSettings(snapshot.committee.id, {...snapshot.layoutSettings, ...patch}, snapshot.committee.revision));
  return <>{canChair && <><Header as="h3" attached="top">{t('Settings')}</Header><Segment attached="bottom" loading={pending === 'layout'}>
    <Checkbox slider checked={snapshot.layoutSettings.moveQueueUp} disabled={readOnly}
      onChange={(_, data) => void setLayoutSetting({moveQueueUp: Boolean(data.checked)})}
      label={t("'Queue' should appear above 'Next speaking'")} />
    <Checkbox slider checked={snapshot.layoutSettings.timersInSeparateColumns} disabled={readOnly}
      onChange={(_, data) => void setLayoutSetting({timersInSeparateColumns: Boolean(data.checked)})}
      label={t("Alternate arrangement with 'Speaker timer' and 'Caucus timer' in separate columns")} />
  </Segment></>}
    <Header as="h2">{t('Committee profile')}</Header>{owner && !readOnly ? <Form onSubmit={() => execute('profile',
    () => api.updateCommittee(snapshot.committee.id, snapshot.committee.revision, {name, topic, conference, visibility}))}>
      <Form.Input label={t('Committee name')} value={name} onChange={event => setName(event.currentTarget.value)} />
      <Form.Input label={t('Topic')} value={topic} onChange={event => setTopic(event.currentTarget.value)} />
      <Form.Input label={t('Conference')} value={conference} onChange={event => setConference(event.currentTarget.value)} />
      <Form.Select label={t('Visibility')} value={visibility} options={['PRIVATE', 'PUBLIC'].map(value => ({key: value, value, text: t(value)}))}
        onChange={(_, data) => setVisibility(data.value as 'PRIVATE' | 'PUBLIC')} />
      <Button primary loading={pending === 'profile'}>{t('Save changes')}</Button>
    </Form> : <List><List.Item>{snapshot.committee.name}</List.Item><List.Item>{snapshot.committee.topic}</List.Item>
      <List.Item>{snapshot.committee.conference}</List.Item></List>}
    {canChair && <><Header as="h2">{t('Committee operation')}</Header>
      <Form onSubmit={() => execute('operation-mode', () => api.setOperationMode(snapshot.committee.id, operationMode,
        snapshot.committee.revision))}><Form.Select label={t('Operation mode')} value={operationMode}
        options={(['DELEGATE_OPERATED', 'CHAIR_OPERATED'] as const).map(value => ({key: value, value, text: t(value)}))}
        onChange={(_, data) => setOperationMode(data.value as typeof operationMode)} />
        <Button primary loading={pending === 'operation-mode'}>{t('Save operation mode')}</Button></Form>
      <Form onSubmit={() => execute('rules', () => api.activateRules(snapshot.committee.id, ruleVersionId,
        snapshot.committee.revision))}><Form.Select label={t('Rule version')} value={ruleVersionId} options={ruleOptions}
        onChange={(_, data) => setRuleVersionId(String(data.value))} />
        <Button primary loading={pending === 'rules'} disabled={!ruleVersionId}>{t('Activate rule version')}</Button></Form>
      <Button loading={pending === 'status'} onClick={() => void execute('status', () => api.setCommitteeStatus(snapshot.committee.id,
        snapshot.committee.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED', snapshot.committee.revision))}>
        {t(snapshot.committee.status === 'PAUSED' ? 'Resume committee' : 'Pause committee')}</Button></>}
    {owner && snapshot.committee.status === 'ARCHIVED' && <><Button as="a" href={api.committeeExportUrl(snapshot.committee.id)} download>{t('Export records')}</Button>
      <Form onSubmit={() => run(async () => {await api.requestCommitteeDeletion(snapshot.committee.id,
        snapshot.committee.revision, deleteName); history.replace('/committees');})}>
        <Form.Input label={t('Enter “{name}” to confirm permanent deletion:').replace('{name}', snapshot.committee.name)}
          value={deleteName} onChange={event => setDeleteName(event.currentTarget.value)} />
        <Button negative disabled={deleteName !== snapshot.committee.name}>{t('Permanently delete committee')}</Button>
      </Form></>}
    {owner && !readOnly && <Button negative loading={pending === 'archive'} onClick={() => {if (window.confirm(t('Archive committee?'))) {
      void execute('archive', () => api.archiveCommittee(snapshot.committee.id, snapshot.committee.revision));
    }}}>{t('Archive committee')}</Button>}
  </>;
}

function RollCallPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  const chair = canChair; const session = snapshot.meetingSession; const rollCall = snapshot.rollCall;
  const [pending, setPending] = React.useState<string>();
  const [phaseId, setPhaseId] = React.useState(snapshot.activeRules.activePhaseId ?? snapshot.activeRules.phases[0]?.id ?? '');
  const [page, setPage] = React.useState(0); const [resetOpen, setResetOpen] = React.useState(false);
  const execute = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key); try {await run(operation);} finally {setPending(undefined);}
  };
  const seats = React.useMemo(() => [...snapshot.seats]
    .sort((first, second) => first.displayName.localeCompare(second.displayName, 'en')), [snapshot.seats]);
  const entryBySeat = React.useMemo(() => new Map(rollCall?.entries.map(entry => [entry.seatId, entry]) ?? []), [rollCall?.entries]);
  const currentSeat = snapshot.seats.find(seat => seat.id === rollCall?.currentSeatId);
  React.useEffect(() => {
    const index = seats.findIndex(seat => seat.id === rollCall?.currentSeatId);
    if (index >= 0) setPage(Math.floor(index / ROLL_CALL_PAGE_SIZE));
  }, [rollCall?.currentSeatId, seats]);
  if (!rollCall) return <>{chair && !session && <Form onSubmit={() => execute('meeting', () => api.startMeetingSession(snapshot.committee.id, phaseId || undefined))}>
      <Form.Select label={t('Meeting phase')} value={phaseId} options={snapshot.activeRules.phases.map(phase => ({key: phase.id, value: phase.id,
        text: phase.names ? localizedDisplayName(phase.names, 'zh-CN') : phase.id}))} onChange={(_, data) => setPhaseId(String(data.value))} />
      <Button primary loading={pending === 'meeting'} disabled={!phaseId}>{t('Start meeting')}</Button>
    </Form>}
    {chair && session?.status === 'OPEN' && !rollCall && <Button primary loading={pending === 'roll-call'}
      onClick={() => void execute('roll-call', () => api.startRollCall(snapshot.committee.id, session.id))}>{t('Start roll call')}</Button>}
  </>;

  const totalPages = Math.max(1, Math.ceil(seats.length / ROLL_CALL_PAGE_SIZE));
  const activePage = Math.min(page, totalPages - 1);
  const visibleSeats = seats.slice(activePage * ROLL_CALL_PAGE_SIZE, (activePage + 1) * ROLL_CALL_PAGE_SIZE);
  const setSeat = (seatId: string) => {
    const existing = entryBySeat.get(seatId);
    const next = existing?.response === 'ABSENT' ? 'PRESENT' : existing ? 'ABSENT' : 'PRESENT';
    if (!rollCall.allowedResponses.includes(next)) return;
    return execute(`seat:${seatId}`, () => api.setRollCallResponse(rollCall.id, rollCall.revision, seatId, next));
  };
  const presentSeatIds = new Set(seats.filter(seat => {
    const attendance = snapshot.attendance.find(item => item.seatId === seat.id)?.state;
    if (attendance) return attendance === 'PRESENT';
    return entryBySeat.get(seat.id)?.response !== 'ABSENT' && entryBySeat.has(seat.id);
  }).map(seat => seat.id));
  const votingPresent = seats.filter(seat => seat.canVote && presentSeatIds.has(seat.id)).length;
  const simpleMajority = votingPresent > 0 ? Math.floor(votingPresent / 2) + 1 : 0;
  const twoThirdsMajority = votingPresent > 0 ? Math.ceil(votingPresent * 2 / 3) : 0;
  return <Container fluid className="roll-call-page">
    <div className="roll-call-heading"><Header as="h1">{t('Roll call')}</Header><Label basic size="large">
      {t('{called} of {total} called', {called: rollCall.entries.length, total: seats.length})}</Label></div>
    {seats.length === 0 ? <Message warning content={t('Add at least one committee member to proceed')} /> : <>
      <Segment className="roll-call-board">
        <div className="roll-call-legend" aria-label={t('Status legend')}>
          <span><i className="status-uncalled" />{t('Not called')}</span>
          <span><i className="status-absent" />{t('Absent')}</span>
          <span><i className="status-present" />{t('Present')}</span>
        </div>
        <div className="roll-call-grid">{visibleSeats.map(seat => {
          const entry = entryBySeat.get(seat.id); const status = !entry ? 'uncalled' : entry.response === 'ABSENT' ? 'absent' : 'present';
          const label = !entry ? t('Not called') : rollCallResponseLabel(entry.response);
          return <button type="button" key={seat.id} data-roll-call-seat={seat.id}
            className={`roll-call-member status-${status}${seat.id === rollCall.currentSeatId ? ' is-current' : ''}`}
            aria-label={`${seat.displayName}: ${label}`} aria-pressed={entry ? entry.response !== 'ABSENT' : undefined}
            disabled={!chair || !!pending} onClick={() => void setSeat(seat.id)}>
            <span className="roll-call-status-light" aria-hidden="true" /><span className="roll-call-member-name">{seat.displayName}</span>
          </button>;
        })}</div>
        {totalPages > 1 && <Pagination className="roll-call-pagination" activePage={activePage + 1} totalPages={totalPages}
          boundaryRange={1} siblingRange={1} ellipsisItem={null} onPageChange={(_, data) => setPage(Number(data.activePage) - 1)} />}
      </Segment>
      <Segment className="roll-call-current" textAlign="center">
        {currentSeat ? <><div className="roll-call-current-label">{t('Now calling')}</div><Header as="h2"><Flag seat={currentSeat} />
          <span className="roll-call-current-name">{currentSeat.displayName}</span></Header></>
          : <Header as="h2" color="green">{t('Roll call complete')}</Header>}
        {chair && <div className="roll-call-actions">
          {currentSeat && rollCall.allowedResponses.map(response => <Button key={response}
            positive={response !== 'ABSENT'} negative={response === 'ABSENT'}
            icon={response === 'ABSENT' ? 'close' : 'check'} content={rollCallResponseLabel(response)}
            loading={pending === `response:${response}`} disabled={!!pending}
            onClick={() => void execute(`response:${response}`,
              () => api.recordRollCallResponse(rollCall.id, rollCall.revision, currentSeat.id, response))} />)}
          {rollCall.status === 'IN_PROGRESS' && <><Button basic icon="undo" content={t('Undo')}
            loading={pending === 'undo'} disabled={rollCall.entries.length === 0 || !!pending}
            onClick={() => void execute('undo', () => api.undoRollCall(rollCall.id, rollCall.revision))} />
            <Button basic color="orange" icon="refresh" content={t('Reset')} loading={pending === 'reset'}
              disabled={!!pending} onClick={() => setResetOpen(true)} /></>}
        </div>}
      </Segment>
      {rollCall.status === 'COMPLETED' && <Segment className="roll-call-summary"><Header as="h2">{t('Attendance and thresholds')}</Header>
        <div className="roll-call-summary-highlights">
          <div className="roll-call-summary-highlight highlight-present"><span className="roll-call-summary-label">{t('Present')}</span>
            <strong>{presentSeatIds.size}</strong></div>
          <div className="roll-call-summary-highlight highlight-two-thirds"><span className="roll-call-summary-label">{t('Two-thirds majority')}</span>
            <strong>{twoThirdsMajority}</strong></div>
          <div className="roll-call-summary-highlight highlight-simple-majority"><span className="roll-call-summary-label">{t('Simple majority')}</span>
            <strong>{simpleMajority}</strong></div>
        </div><Button as={Link} to={`/committees/${snapshot.committee.id}/motions`} primary fluid size="large">
          {t('Go to motions')}<Icon name="arrow right" /></Button></Segment>}
    </>}
    <Confirm open={resetOpen} header={t('Reset roll call?')}
      content={t('This will clear every roll-call status and mark all delegations absent.')}
      cancelButton={t('Cancel')} confirmButton={t('Reset')} onCancel={() => setResetOpen(false)}
      onConfirm={() => {setResetOpen(false); void execute('reset', () => api.resetRollCall(rollCall.id, rollCall.revision));}} />
  </Container>;
}

function PointResolutionForm({point, run, api}: {point: CommitteePoint; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi}) {
  const [status, setStatus] = React.useState<Exclude<PointStatus, 'PENDING'>>('ANSWERED');
  const [response, setResponse] = React.useState(''); const [attendance, setAttendance] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const personalPrivilege = point.pointTypeId === 'point-of-personal-privilege';
  const submit = async () => {
    setPending(true); await run(() => api.resolvePoint(point.id, {baseRevision: point.revision, status,
      ...(response.trim() ? {chairResponse: response.trim()} : {}),
      ...(personalPrivilege && attendance ? {attendanceChange: {type: attendance as AttendanceEventType}} : {})}));
    setPending(false);
  };
  return <Form onSubmit={submit} size="small">
    <Form.Select label={t('Ruling')} value={status} options={(['ANSWERED', 'UPHELD', 'OVERRULED', 'RESOLVED', 'REJECTED'] as const)
      .map(value => ({key: value, value, text: t(value)}))} onChange={(_, data) => setStatus(data.value as Exclude<PointStatus, 'PENDING'>)} />
    <Form.TextArea label={t('Chair response')} value={response} onChange={(_, data) => setResponse(String(data.value))} />
    {personalPrivilege && <Form.Select label={t('Attendance change')} value={attendance} options={[
      {key: 'none', value: '', text: t('No attendance change')},
      ...(['PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT'] as const).map(value => ({key: value, value, text: t(value)}))
    ]} onChange={(_, data) => setAttendance(String(data.value))} />}
    <Button primary size="mini" loading={pending}>{t('Save ruling')}</Button>
  </Form>;
}

function PointsPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  const pointTypes = snapshot.activeRules.pointTypes;
  const [type, setType] = React.useState(pointTypes[0]?.id ?? ''); const [content, setContent] = React.useState('');
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? ''); const chair = canChair;
  const session = snapshot.meetingSession;
  const create = async () => { if (!session) return; await run(() => api.createPoint(snapshot.committee.id,
    {meetingSessionId: session.id, pointTypeId: type, content, ...(chair && seatId ? {onBehalfOfSeatId: seatId} : {})})); setContent(''); };
  const canRaise = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  return <>{canRaise && session?.status === 'OPEN' && <Form onSubmit={create}><Form.Select label={t('Point type')} value={type}
    options={pointTypes.map(item => ({key: item.id, value: item.id,
      text: item.names ? localizedDisplayName(item.names, 'zh-CN') : t(item.id)}))}
    onChange={(_, data) => setType(String(data.value))} />
    {chair && <Form.Select label={t('Represented seat')} value={seatId} options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
      onChange={(_, data) => setSeatId(String(data.value))} />}
    <Form.TextArea label={t('Point')} required value={content} onChange={(_, data) => setContent(String(data.value))} />
    <Button primary disabled={!type || !content.trim() || (chair && !seatId)}>{t('Raise point')}</Button></Form>}
    <List divided>{snapshot.points.map(item => { const full = 'content' in item ? item as CommitteePoint : undefined;
      return <List.Item key={item.id}><List.Header>{item.raisedBySeatDisplayName} · {t(item.pointTypeId)}</List.Header>
        <List.Description>{full?.content}<Label>{t(item.status)}</Label>{full?.chairResponse && <div>{full.chairResponse}</div>}</List.Description>
        {chair && item.status === 'PENDING' && full && <PointResolutionForm point={full} run={run} api={api} />}</List.Item>;
    })}</List></>;
}

function StatisticsPanel({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  const speechDuration = (seatId: string) => (snapshot.speakerLists ?? []).reduce((total, list) => total
    + (list.speeches ?? []).filter(speech => speech.seatId === seatId && speech.status === 'COMPLETED')
      .reduce((listTotal, speech) => {
        const queueEntry = list.queue.find(entry => entry.id === speech.queueEntryId);
        const allotted = speech.kind === 'INHERITED' ? speech.inheritedTimeMs ?? queueEntry?.speechDurationMs ?? 0
          : queueEntry?.speechDurationMs ?? 0;
        const remaining = speech.actions.at(-1)?.remainingMs ?? allotted;
        return listTotal + Math.max(0, allotted - remaining);
      }, 0), 0);
  const formatDuration = (milliseconds: number) => {
    const seconds = Math.floor(milliseconds / 1000); const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60); const remainder = seconds % 60;
    return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
  };
  const rows = snapshot.seats.map(seat => ({seat,
    speeches: (snapshot.speakerLists ?? []).flatMap(list => list.speeches ?? [])
      .filter(speech => speech.seatId === seat.id && speech.status === 'COMPLETED').length,
    duration: speechDuration(seat.id),
    motions: (snapshot.motions ?? []).filter(motion => motion.proposedBySeatId === seat.id).length,
    amendments: (snapshot.documents ?? []).filter(document => document.kind === 'AMENDMENT'
      && document.proposerSeatId === seat.id).length,
    points: snapshot.points.filter(point => point.raisedBySeatId === seat.id).length,
    documentEntries: (snapshot.documents ?? []).flatMap(document => document.discussion).filter(entry => entry.seatId === seat.id).length
  })).sort((first, second) => second.speeches - first.speeches || first.seat.sortOrder - second.seat.sortOrder);
  return <Container text className="statistics-page"><Table compact celled definition><Table.Header><Table.Row>
    <Table.HeaderCell /><Table.HeaderCell textAlign="right">{t('Times spoken')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Total speaking time')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Motion proposals')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Amendment proposals')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Points')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Document discussion entries')}</Table.HeaderCell></Table.Row></Table.Header>
    <Table.Body>{rows.map(row => <Table.Row key={row.seat.id}><Table.Cell><Flag seat={row.seat} />{row.seat.displayName}</Table.Cell>
      <Table.Cell textAlign="right">{row.speeches}</Table.Cell><Table.Cell textAlign="right">{formatDuration(row.duration)}</Table.Cell>
      <Table.Cell textAlign="right">{row.motions}</Table.Cell><Table.Cell textAlign="right">{row.amendments}</Table.Cell>
      <Table.Cell textAlign="right">{row.points}</Table.Cell><Table.Cell textAlign="right">{row.documentEntries}</Table.Cell>
    </Table.Row>)}</Table.Body></Table></Container>;
}

function HelpPanel({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  const role = {PUBLIC: 'Public visitor', MEMBER: 'Member', CHAIR: 'Chair', OWNER: 'Owner'}[snapshot.viewer.audience];
  const shortcut = (key: string, label: string) => <List.Item><Button size="mini">Alt</Button>
    <Button size="mini">{key}</Button>{t(label)}</List.Item>;
  return <Container text className="help-page">
    <Header as="h3" attached="top">{t('Keyboard shortcuts')}</Header><Segment attached="bottom"><List>
      {shortcut('N', 'Next speaker')}{shortcut('S', 'Toggle speaker timer')}{shortcut('C', 'Toggle caucus timer')}
    </List></Segment>
    <Header as="h3" attached="top">{t('Permissions')}</Header><Segment attached="bottom"><List>
      <List.Item><List.Header>{t('Current role')}</List.Header>{t(role)}</List.Item>
      <List.Item><List.Header>{t('Rule version')}</List.Header>{snapshot.activeRules.versionId}</List.Item>
    </List></Segment>
    <Header as="h3" attached="top">{t('Bug reporting & help requests')}</Header><Segment attached="bottom">
      <List ordered><List.Item><a href="https://github.com/brepublic/Quorum/issues">{t('Quorum issue tracking page')}</a></List.Item>
        <List.Item>{t('Describe what you intended to do')}</List.Item><List.Item>{t('Describe what happened instead')}</List.Item>
        <List.Item>{t('List the time, date, and browser that you were using when this occurred')}</List.Item></List>
    </Segment>
    <Header as="h3" attached="top">{t('Version')}</Header><Segment attached="bottom"><List>
      <List.Item>Quorum self-hosted</List.Item><List.Item>Theme API 2</List.Item></List></Segment>
    <Header as="h3" attached="top">{t('License')}</Header><Segment attached="bottom">
      {t('Quorum is licensed under')} <a href="https://github.com/brepublic/Quorum/blob/master/LICENSE">GNU GPLv3</a>
    </Segment>
    <Header as="h3" attached="top">{t('Community')}</Header><Segment attached="bottom">
      <a href="https://github.com/brepublic/Quorum/discussions">{t('Visit the Quorum discussion space')}</a>
    </Segment>
    <Header as="h3" attached="top">{t('Acknowledgements')}</Header><Segment attached="bottom">
      {t('Quorum is based on')} <a href="https://github.com/MaxwellBo/Muncoordinated-2">Muncoordinated</a>.{' '}
      {t('Thanks to its original authors and contributors.')}
    </Segment>
  </Container>;
}

export function SelfHostedCommitteeWorkspace({api = selfHostedApi, user, logout = () => undefined}: {
  api?: SelfHostedApi; user?: SelfHostedUser; logout?(): void;
}) {
  const {id} = useParams<{id: string}>();
  return <CommitteeWorkspaceProvider committeeId={id} api={api}>
    <CommitteeWorkspaceContent id={id} api={api} user={user} logout={logout} />
  </CommitteeWorkspaceProvider>;
}

function CommitteeWorkspaceContent({id, api, user, logout}: {
  id: string; api: SelfHostedApi; user?: SelfHostedUser; logout(): void;
}) {
  const {snapshot, error, realtimeStatus, refresh, run} = useCommitteeWorkspace();
  if (!snapshot && !error) return <Loading />;
  if (!snapshot) return <Container text><Message error content={error} /><Button onClick={() => void refresh()}>{t('Retry')}</Button></Container>;
  const interactionSnapshot: CommitteeWorkspaceSnapshot = realtimeStatus === 'OFFLINE_READONLY'
    ? {...snapshot, viewer: {audience: 'PUBLIC', seatId: null}} : snapshot;
  const canChair = (interactionSnapshot.viewer.audience === 'CHAIR' || interactionSnapshot.viewer.audience === 'OWNER')
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  const base = `/committees/${id}`;
  return <CommitteeNavigation snapshot={snapshot} user={user} logout={logout} realtimeStatus={realtimeStatus}>
    <Container fluid className="committee-workspace-page">{error && <Message error content={error} />}
        <Switch>
          <Route exact path={base}><CommitteeOverviewPanel snapshot={snapshot} /></Route>
          <Route exact path={`${base}/setup`}><SetupPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={`${base}/roll-call`}><RollCallPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={`${base}/points`}><PointsPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={`${base}/notes`}><NotesPanel snapshot={interactionSnapshot} run={run} api={api} /></Route>
          <Route path={`${base}/posts/:tab?`} render={({match}) => <PostsPanel snapshot={interactionSnapshot} run={run} api={api}
            userId={user?.id} tab={match.params.tab} />} />
          <Route exact path={`${base}/files`}><Redirect to={`${base}/posts/attachments`} /></Route>
          <Route path={`${base}/motions`}><ProceedingsPanel view="motions" snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route path={`${base}/unmod`}><ProceedingsPanel view="unmod" snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route path={`${base}/caucuses/:listId`} render={({match}) => <ProceedingsPanel view="caucus" resourceId={match.params.listId}
            snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} />} />
          <Route path={`${base}/resolutions/:documentId/:tab?`} render={({match}) => <ProceedingsPanel view="resolution"
            resourceId={match.params.documentId} tab={match.params.tab} snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} />} />
          <Route path={`${base}/strawpolls/:pollId`} render={({match}) => <ProceedingsPanel view="strawpoll" resourceId={match.params.pollId}
            snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} />} />
          <Route path={`${base}/stats`}><StatisticsPanel snapshot={snapshot} /></Route>
          <Route path={`${base}/settings`}><SettingsPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route path={`${base}/help`}><HelpPanel snapshot={snapshot} /></Route>
          <Redirect to={base} />
        </Switch>
    </Container>
  </CommitteeNavigation>;
}

export default function SelfHostedWorkspace({user, logout, accountManager, api = selfHostedApi}: {
  user: SelfHostedUser; logout(): void; accountManager?: React.ReactNode; api?: SelfHostedApi;
}) {
  const location = useLocation();
  const committeeRoute = /^\/committees\/[^/]+/.test(location.pathname);
  return <>{!committeeRoute && <AppMenu user={user} logout={logout} />}<Switch>
    <Route exact path="/committees"><CommitteeList api={api} user={user} logout={logout} /></Route>
    <Route exact path="/countries"><CountryTemplateManager api={api} /></Route>
    <Route exact path="/templates"><CommitteeTemplateManager api={api} /></Route>
    {user.isSystemAdmin && <Route exact path="/storage"><Container style={{padding: '1em'}}><StorageAdminPanel api={api} /></Container></Route>}
    {user.isSystemAdmin && <Route exact path="/operations"><Container style={{padding: '1em'}}><OperationsPanel api={api} /></Container></Route>}
    <Route path="/committees/:id"><SelfHostedCommitteeWorkspace api={api} user={user} logout={logout} /></Route>
    {user.isSystemAdmin && <Route exact path="/admin">{accountManager}</Route>}
    <Route exact path="/"><Redirect to={user.isSystemAdmin ? '/admin' : '/committees'} /></Route>
    <Redirect to="/committees" />
  </Switch></>;
}

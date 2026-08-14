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
import {Button, Card, Container, Form, Header, Icon, Label, List, Menu, Message, Popup, Segment, Table} from 'semantic-ui-react';
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
  if (seat.flag.type === 'IMAGE') return <img src={seat.flag.value} alt="" style={{width: '2em', maxHeight: '1.4em', objectFit: 'contain'}} />;
  if (seat.flag.type === 'STANDARD') return <span className={`fi fi-${seat.flag.value}`} aria-hidden="true" />;
  return <span aria-hidden="true">{seat.flag.value}</span>;
}

function AppMenu({user, logout}: {user: SelfHostedUser; logout(): void}) {
  return <Menu>
    <Menu.Item header as={Link} to="/committees">Quorum</Menu.Item>
    <Menu.Menu position="right"><AccountMenu user={user} logout={logout} /></Menu.Menu>
  </Menu>;
}

function CommitteeList({api}: {api: SelfHostedApi}) {
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
  return <Container style={{padding: '1em'}}>
    <Header as="h1">{t('Committees')}</Header>{error && <Message error content={error} />}
    <Segment><Form onSubmit={create} loading={working}>
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
    </Form></Segment>
    {loading ? <Loading /> : committees.length === 0 ? <Message content={t('No committees created')} /> : <Card.Group>
      {committees.map(committee => <Card key={committee.id} as={Link} to={`/committees/${committee.id}`}>
        <Card.Content><Card.Header>{committee.name}</Card.Header><Card.Meta>{t(committee.status)}</Card.Meta></Card.Content>
      </Card>)}
    </Card.Group>}
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
  const canWrite = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  React.useEffect(() => {
    const next = snapshot.notes.find(note => note.id === selectedId);
    setTitle(next?.title ?? ''); setContent(next?.content ?? '');
  }, [selectedId, selected?.revision, snapshot.notes]);
  const save = async () => {
    if (!content.trim()) return;
    setPending('save');
    try {
      if (selected) await run(() => api.updateNote(selected.id, selected.revision, {title, content}));
      else await run(() => api.createNote(snapshot.committee.id, {title, content}));
    } finally {setPending(undefined);}
  };
  const remove = async () => {
    if (!selected) return;
    setPending('delete');
    try {await run(() => api.deleteNote(selected.id, selected.revision)); setSelectedId(undefined);}
    finally {setPending(undefined);}
  };
  return <div className="notes-editor">
    <Menu vertical fluid aria-label={t('Note list')}>
      {snapshot.notes.map(note => <Menu.Item key={note.id} active={note.id === selectedId} onClick={() => setSelectedId(note.id)}>
        {note.title || t('Untitled')}</Menu.Item>)}
      {canWrite && <Menu.Item active={!selectedId} onClick={() => setSelectedId(undefined)}><Icon name="plus" />{t('New note')}</Menu.Item>}
    </Menu>
    <Form onSubmit={save}>
      <Form.Input label={t('Title')} value={title} readOnly={!canWrite} onChange={event => setTitle(event.currentTarget.value)} />
      <Form.TextArea label={t('Content')} value={content} readOnly={!canWrite} onChange={(_, data) => setContent(String(data.value))} />
      {canWrite && <><Button primary loading={pending === 'save'} disabled={!content.trim()}>{t('Save note')}</Button>
        {selected && <Button type="button" negative loading={pending === 'delete'} onClick={() => void remove()}>{t('Delete')}</Button>}</>}
    </Form>
  </div>;
}

function PostsPanel({snapshot, run, api, userId, tab}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand;
  api: SelfHostedApi; userId?: string; tab?: string}) {
  const canManageStorage = snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER';
  const active = tab === 'attachments' || tab === 'storage' ? tab : 'text';
  const base = `/committees/${snapshot.committee.id}/posts`;
  return <><Menu pointing secondary aria-label={t('Resource sections')}>
    <Menu.Item as={Link} to={base} active={active === 'text'}>{t('Text resources')}</Menu.Item>
    <Menu.Item as={Link} to={`${base}/attachments`} active={active === 'attachments'}>{t('Attachments')}</Menu.Item>
    {canManageStorage && <Menu.Item as={Link} to={`${base}/storage`} active={active === 'storage'}>{t('Storage')}</Menu.Item>}
  </Menu>
    {active === 'text' && <TextResources kind="posts" snapshot={snapshot} run={run} api={api} />}
    {active === 'attachments' && <FilesPanel section="attachments" snapshot={snapshot} api={api} currentUserId={userId} />}
    {active === 'storage' && canManageStorage && <FilesPanel section="storage" snapshot={snapshot} api={api} currentUserId={userId} />}
  </>;
}

type WorkspaceCommand = (operation: () => Promise<unknown>) => Promise<void>;

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
  const [chairUserId, setChairUserId] = React.useState(''); const [assignmentUserId, setAssignmentUserId] = React.useState('');
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
  return <>
    {owner && !readOnly && <><Header as="h2">{t('Chairs')}</Header>
      <Form onSubmit={async () => {await execute('grant-chair', () => api.grantChair(snapshot.committee.id,
        chairUserId.trim(), snapshot.committee.revision)); setChairUserId('');}}>
        <Form.Input label={t('Account ID')} required value={chairUserId} onChange={event => setChairUserId(event.currentTarget.value)} />
        <Button primary loading={pending === 'grant-chair'} disabled={!chairUserId.trim()}>{t('Grant Chair')}</Button>
      </Form>
      <List divided>{(snapshot.chairs ?? []).map(chair => <List.Item key={chair.userId}>
        <List.Content floated="right"><Button size="mini" negative loading={pending === `chair-${chair.userId}`}
          onClick={() => void execute(`chair-${chair.userId}`, () => api.revokeChair(snapshot.committee.id,
            chair.userId, snapshot.committee.revision))}>{t('Revoke Chair')}</Button></List.Content>
        <List.Content>{chair.userId}</List.Content>
      </List.Item>)}</List></>}
    <Header as="h2">{t('Seats')}</Header>
    {canChair && !readOnly && <Form onSubmit={async () => {await execute('create-seat', () => api.createSeat(snapshot.committee.id,
      {stableKey: seatName.trim().toLowerCase().replace(/\s+/g, '-'), displayName: seatName})); setSeatName('');}}>
      <Form.Input label={t('Seat name')} required value={seatName} onChange={event => setSeatName(event.currentTarget.value)} />
      <Button primary loading={pending === 'create-seat'} disabled={!seatName.trim()}>{t('Create seat')}</Button>
    </Form>}
    <Table basic="very" stackable><Table.Header><Table.Row><Table.HeaderCell>{t('Seat')}</Table.HeaderCell>
      <Table.HeaderCell>{t('Rank')}</Table.HeaderCell><Table.HeaderCell>{t('Voting')}</Table.HeaderCell>
      {canChair && !readOnly && <Table.HeaderCell>{t('Actions')}</Table.HeaderCell>}</Table.Row></Table.Header>
      <Table.Body>{snapshot.seats.map(seat => <Table.Row key={seat.id}><Table.Cell><Flag seat={seat} />{canChair && !readOnly
        ? <Form.Input aria-label={`${t('Seat name')} · ${seat.displayName}`} value={seatNames[seat.id] ?? seat.displayName}
          onChange={event => setSeatNames(current => ({...current, [seat.id]: event.currentTarget.value}))} /> : seat.displayName}</Table.Cell>
        <Table.Cell>{t(seat.rank)}</Table.Cell><Table.Cell>{seat.canVote ? t('Voting') : t('Non-voting')}</Table.Cell>
        {canChair && !readOnly && <Table.Cell><Button size="mini" loading={pending === `rename-${seat.id}`}
          disabled={!seatNames[seat.id]?.trim() || seatNames[seat.id] === seat.displayName} onClick={() => void execute(`rename-${seat.id}`,
            () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {displayName: seatNames[seat.id]!.trim()}))}>{t('Save name')}</Button>
          <Button size="mini" negative loading={pending === `deactivate-${seat.id}`} onClick={() => {
            if (window.confirm(t('Deactivate seat?'))) void execute(`deactivate-${seat.id}`,
              () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {active: false}));}}>{t('Deactivate')}</Button>
        </Table.Cell>}</Table.Row>)}</Table.Body></Table>
    {canChair && !readOnly && snapshot.seats.length > 0 && <>
      <Header as="h2">{t('Seat assignments')}</Header>
      <Form onSubmit={async () => {await execute('assign-seat', () => api.assignSeat(snapshot.committee.id,
        assignmentSeatId, assignmentUserId.trim())); setAssignmentUserId('');}}>
        <Form.Select label={t('Seat')} value={assignmentSeatId} options={snapshot.seats.map(seat =>
          ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setAssignmentSeatId(String(data.value))} />
        <Form.Input label={t('Account ID')} required value={assignmentUserId} onChange={event => setAssignmentUserId(event.currentTarget.value)} />
        <Button primary loading={pending === 'assign-seat'} disabled={!assignmentSeatId || !assignmentUserId.trim()}>{t('Assign seat')}</Button>
      </Form>
      <List divided>{(snapshot.assignments ?? []).map(assignment => <List.Item key={assignment.id}>
        <List.Content floated="right"><Button size="mini" negative loading={pending === `assignment-${assignment.id}`}
          onClick={() => void execute(`assignment-${assignment.id}`,
            () => api.endSeatAssignment(snapshot.committee.id, assignment.id))}>{t('End assignment')}</Button></List.Content>
        <List.Header>{snapshot.seats.find(seat => seat.id === assignment.seatId)?.displayName ?? assignment.seatId}</List.Header>
        <List.Description>{assignment.userId}</List.Description>
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
  </>;
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
  return <><Header as="h2">{t('Committee profile')}</Header>{owner && !readOnly ? <Form onSubmit={() => execute('profile',
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
  const execute = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key); await run(operation); setPending(undefined);
  };
  const currentSeat = snapshot.seats.find(seat => seat.id === rollCall?.currentSeatId);
  return <>{chair && !session && <Form onSubmit={() => execute('meeting', () => api.startMeetingSession(snapshot.committee.id, phaseId || undefined))}>
      <Form.Select label={t('Meeting phase')} value={phaseId} options={snapshot.activeRules.phases.map(phase => ({key: phase.id, value: phase.id,
        text: phase.names ? localizedDisplayName(phase.names, 'zh-CN') : phase.id}))} onChange={(_, data) => setPhaseId(String(data.value))} />
      <Button primary loading={pending === 'meeting'} disabled={!phaseId}>{t('Start meeting')}</Button>
    </Form>}
    {chair && session?.status === 'OPEN' && !rollCall && <Button primary loading={pending === 'roll-call'}
      onClick={() => void execute('roll-call', () => api.startRollCall(snapshot.committee.id, session.id))}>{t('Start roll call')}</Button>}
    {rollCall && <Segment><Header as="h3">{currentSeat?.displayName ?? t(rollCall.status)}</Header>
      {chair && rollCall.status === 'IN_PROGRESS' && currentSeat && <Button.Group>{rollCall.allowedResponses.map(response => <Button key={response}
        loading={pending === `response:${response}`} onClick={() => void execute(`response:${response}`,
          () => api.recordRollCallResponse(rollCall.id, rollCall.revision, currentSeat.id, response))}>{t(response)}</Button>)}</Button.Group>}
      {chair && rollCall.status === 'IN_PROGRESS' && <><Button size="small" loading={pending === 'undo'}
        onClick={() => void execute('undo', () => api.undoRollCall(rollCall.id, rollCall.revision))}>{t('Undo last response')}</Button>
        <Button size="small" loading={pending === 'reset'} onClick={() => void execute('reset',
          () => api.resetRollCall(rollCall.id, rollCall.revision))}>{t('Reset roll call')}</Button></>}
      <List>{rollCall.entries.map(entry => <List.Item key={entry.id}>{entry.seatDisplayName}<Label>{t(entry.response)}</Label></List.Item>)}</List></Segment>}
    <Table basic="very"><Table.Header><Table.Row><Table.HeaderCell>{t('Seat')}</Table.HeaderCell><Table.HeaderCell>{t('Attendance')}</Table.HeaderCell>
      {chair && <Table.HeaderCell>{t('Actions')}</Table.HeaderCell>}</Table.Row></Table.Header><Table.Body>{snapshot.seats.map(seat => {
        const state = snapshot.attendance.find(item => item.seatId === seat.id)?.state ?? 'ABSENT';
        return <Table.Row key={seat.id}><Table.Cell>{seat.displayName}</Table.Cell><Table.Cell>{t(state)}</Table.Cell>{chair && session?.status === 'OPEN' && <Table.Cell>
          {(['PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT'] as const).map(type => <Button key={type} size="mini"
            loading={pending === `attendance:${seat.id}:${type}`} onClick={() => void execute(`attendance:${seat.id}:${type}`,
              () => api.createAttendanceEvent(snapshot.committee.id, session.id, seat.id, type))}>{t(type)}</Button>)}</Table.Cell>}</Table.Row>;
      })}</Table.Body></Table>
  </>;
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
  const rows = snapshot.seats.map(seat => ({seat,
    speeches: (snapshot.speakerLists ?? []).flatMap(list => list.speeches ?? []).filter(speech => speech.seatId === seat.id).length,
    motions: (snapshot.motions ?? []).filter(motion => motion.proposedBySeatId === seat.id).length,
    points: snapshot.points.filter(point => point.raisedBySeatId === seat.id).length,
    documentEntries: (snapshot.documents ?? []).flatMap(document => document.discussion).filter(entry => entry.seatId === seat.id).length
  }));
  return <><Header as="h1">{t('Statistics')}</Header><Table basic="very" stackable><Table.Header><Table.Row>
    <Table.HeaderCell>{t('Seat')}</Table.HeaderCell><Table.HeaderCell>{t('Speeches')}</Table.HeaderCell>
    <Table.HeaderCell>{t('Motions')}</Table.HeaderCell><Table.HeaderCell>{t('Points')}</Table.HeaderCell>
    <Table.HeaderCell>{t('Document discussion entries')}</Table.HeaderCell></Table.Row></Table.Header>
    <Table.Body>{rows.map(row => <Table.Row key={row.seat.id}><Table.Cell>{row.seat.displayName}</Table.Cell>
      <Table.Cell>{row.speeches}</Table.Cell><Table.Cell>{row.motions}</Table.Cell><Table.Cell>{row.points}</Table.Cell>
      <Table.Cell>{row.documentEntries}</Table.Cell></Table.Row>)}</Table.Body></Table></>;
}

function HelpPanel({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  const role = {PUBLIC: 'Public visitor', MEMBER: 'Member', CHAIR: 'Chair', OWNER: 'Owner'}[snapshot.viewer.audience];
  return <><Header as="h1">{t('Help')}</Header><Header as="h2">{t('Permissions')}</Header>
    <List><List.Item><List.Header>{t('Current role')}</List.Header>{t(role)}</List.Item></List>
    <Header as="h2">{t('Version')}</Header><List><List.Item>Quorum self-hosted</List.Item>
      <List.Item>Theme API 2</List.Item><List.Item>{t('Rule version')}: {snapshot.activeRules.versionId}</List.Item></List></>;
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
  return <>
    <CommitteeNavigation snapshot={snapshot} user={user} logout={logout} realtimeStatus={realtimeStatus} />
    <Container className="committee-workspace-page" style={{padding: '1em'}}>{error && <Message error content={error} />}
      <Segment>
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
      </Segment>
    </Container>
  </>;
}

export default function SelfHostedWorkspace({user, logout, accountManager, api = selfHostedApi}: {
  user: SelfHostedUser; logout(): void; accountManager?: React.ReactNode; api?: SelfHostedApi;
}) {
  const location = useLocation();
  const committeeRoute = /^\/committees\/[^/]+/.test(location.pathname);
  return <>{!committeeRoute && <AppMenu user={user} logout={logout} />}<Switch>
    <Route exact path="/committees"><CommitteeList api={api} /></Route>
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

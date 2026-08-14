import * as React from 'react';
import type {
  CommitteeNote,
  CommitteePoint,
  CommitteeTemplate,
  CommitteeTextPost,
  CommitteeWorkspaceSnapshot,
  CountryTemplate,
  Stage4CommitteeSeat
} from '@quorum/contracts';
import {Link, Redirect, Route, Switch, useHistory, useParams} from 'react-router-dom';
import {Button, Card, Container, Form, Header, Icon, Label, List, Menu, Message, Popup, Segment, Table} from 'semantic-ui-react';
import Loading from '../components/Loading';
import {LanguageMenuItem, t} from '../i18n';
import {SelfHostedApiError, selfHostedApi, type SelfHostedApi} from '../services/self-hosted-api';
import type {SelfHostedUser} from '../services/self-hosted-identity';
import ProceedingsPanel from './self-hosted/ProceedingsPanel';
import FilesPanel from './self-hosted/FilesPanel';
import StorageAdminPanel from './self-hosted/StorageAdminPanel';
import OperationsPanel from './self-hosted/OperationsPanel';
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
  return <Menu stackable>
    <Menu.Item header as={Link} to="/committees">Quorum</Menu.Item>
    <Menu.Item as={Link} to="/committees">{t('Committees')}</Menu.Item>
    <Menu.Item as={Link} to="/templates">{t('Committee templates')}</Menu.Item>
    <Menu.Item as={Link} to="/countries">{t('Country templates')}</Menu.Item>
    {user.isSystemAdmin && <Menu.Item as={Link} to="/admin">{t('Account administration')}</Menu.Item>}
    {user.isSystemAdmin && <Menu.Item as={Link} to="/storage">存储配置</Menu.Item>}
    {user.isSystemAdmin && <Menu.Item as={Link} to="/operations">运行状态</Menu.Item>}
    <Menu.Menu position="right"><LanguageMenuItem /><Menu.Item onClick={logout}>{t('Logout')}</Menu.Item></Menu.Menu>
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

type WorkspaceView = 'overview' | 'notes' | 'posts' | 'files' | 'roll-call' | 'points' | 'proceedings';

function TextResources({kind, snapshot, run, api}: {kind: 'notes' | 'posts'; snapshot: CommitteeWorkspaceSnapshot;
  run(operation: () => Promise<unknown>): Promise<void>; api: SelfHostedApi}) {
  const [title, setTitle] = React.useState(''); const [content, setContent] = React.useState('');
  const resources = kind === 'notes' ? snapshot.notes : snapshot.textPosts;
  const canWrite = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  const create = async () => { if (kind === 'notes') await run(() => api.createNote(snapshot.committee.id, {title, content}));
    else await run(() => api.createTextPost(snapshot.committee.id, {title, content})); setTitle(''); setContent(''); };
  const edit = (resource: CommitteeNote | CommitteeTextPost) => {
    const next = window.prompt(t('Content'), resource.content); if (next === null) return Promise.resolve();
    return kind === 'notes' ? run(() => api.updateNote(resource.id, resource.revision, {content: next}))
      : run(() => api.updateTextPost(resource.id, resource.revision, {content: next}));
  };
  const remove = (resource: CommitteeNote | CommitteeTextPost) => kind === 'notes'
    ? run(() => api.deleteNote(resource.id, resource.revision))
    : run(() => api.deleteTextPost(resource.id, resource.revision));
  return <>{canWrite && <Form onSubmit={create}><Form.Input label={t('Title')} value={title} onChange={e => setTitle(e.currentTarget.value)} />
    <Form.TextArea label={t('Content')} required value={content} onChange={(_, data) => setContent(String(data.value))} />
    <Button primary disabled={!content}>{kind === 'notes' ? t('Create note') : t('Create text post')}</Button></Form>}
    <List divided relaxed>{resources.map(resource => <List.Item key={resource.id}>{canWrite && <List.Content floated="right">
      <Button size="mini" onClick={() => void edit(resource)}>{t('Edit')}</Button>
      <Button size="mini" negative onClick={() => void remove(resource)}>{t('Delete')}</Button></List.Content>}
      <List.Header>{resource.title || t('Untitled')}</List.Header><List.Description style={{whiteSpace: 'pre-wrap'}}>{resource.content}</List.Description>
    </List.Item>)}</List></>;
}

function Overview({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  const history = useHistory();
  const [name, setName] = React.useState(snapshot.committee.name); const [seatName, setSeatName] = React.useState('');
  const [chairUserId, setChairUserId] = React.useState(''); const [assignmentUserId, setAssignmentUserId] = React.useState('');
  const [assignmentSeatId, setAssignmentSeatId] = React.useState(snapshot.seats[0]?.id ?? '');
  const owner = snapshot.viewer.audience === 'OWNER';
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  return <><Header as="h2">{t('Committee profile')}</Header>{owner && !readOnly && <Form onSubmit={() => run(() => api.updateCommittee(
    snapshot.committee.id, snapshot.committee.revision, {name}))}><Form.Input label={t('Committee name')} value={name}
      onChange={e => setName(e.currentTarget.value)} /><Button primary>{t('Save changes')}</Button></Form>}
    {owner && !readOnly && <><Header as="h2">{t('Chairs')}</Header><Form onSubmit={async () => { await run(() => api.grantChair(
      snapshot.committee.id, chairUserId.trim(), snapshot.committee.revision)); setChairUserId(''); }}>
      <Form.Input label={t('Account ID')} required value={chairUserId} onChange={e => setChairUserId(e.currentTarget.value)} />
      <Button primary disabled={!chairUserId.trim()}>{t('Grant Chair')}</Button></Form></>}
    {owner && snapshot.committee.status === 'ARCHIVED' && <><Button as="a" href={api.committeeExportUrl(snapshot.committee.id)} download>导出记录</Button>
      <Button negative onClick={() => {const confirmationName = window.prompt(
        `此操作不可恢复。请输入委员会名称“${snapshot.committee.name}”确认永久删除：`);
      if (confirmationName === null) return;
      void run(async () => {await api.requestCommitteeDeletion(snapshot.committee.id,
        snapshot.committee.revision, confirmationName); history.replace('/committees');});}}>永久删除委员会</Button></>}
    {owner && !readOnly && <Button negative onClick={() => {if (window.confirm('归档后委员会只读。继续？')) {
      void run(() => api.archiveCommittee(snapshot.committee.id, snapshot.committee.revision));
    }}}>归档委员会</Button>}
    <Header as="h2">{t('Seats')}</Header>{canChair && !readOnly && <Form onSubmit={async () => {await run(() => api.createSeat(snapshot.committee.id,
      {stableKey: seatName.trim().toLowerCase().replace(/\s+/g, '-'), displayName: seatName})); setSeatName('');}}>
      <Form.Input label={t('Seat name')} required value={seatName} onChange={e => setSeatName(e.currentTarget.value)} />
      <Button primary disabled={!seatName.trim()}>{t('Create seat')}</Button></Form>}
    <Table basic="very"><Table.Body>{snapshot.seats.map(seat => <Table.Row key={seat.id}><Table.Cell><Flag seat={seat} /></Table.Cell>
      <Table.Cell>{seat.displayName}</Table.Cell><Table.Cell>{t(seat.rank)}</Table.Cell><Table.Cell>{seat.canVote ? t('Voting') : t('Non-voting')}</Table.Cell>
      {canChair && !readOnly && <Table.Cell><Button size="mini" onClick={() => {const next = window.prompt(t('Seat name'), seat.displayName);
        if (next) void run(() => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {displayName: next}));}}>{t('Rename')}</Button>
        <Button size="mini" negative onClick={() => {if (window.confirm(t('Deactivate seat?'))) void run(() => api.updateSeat(
          snapshot.committee.id, seat.id, seat.revision, {active: false}));}}>{t('Deactivate')}</Button></Table.Cell>}</Table.Row>)}</Table.Body></Table>
    {canChair && !readOnly && snapshot.seats.length > 0 && <><Header as="h2">{t('Seat assignments')}</Header><Form onSubmit={async () => {
      await run(() => api.assignSeat(snapshot.committee.id, assignmentSeatId, assignmentUserId.trim())); setAssignmentUserId('');}}>
      <Form.Select label={t('Seat')} value={assignmentSeatId} options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
        onChange={(_, data) => setAssignmentSeatId(String(data.value))} />
      <Form.Input label={t('Account ID')} required value={assignmentUserId} onChange={e => setAssignmentUserId(e.currentTarget.value)} />
      <Button primary disabled={!assignmentSeatId || !assignmentUserId.trim()}>{t('Assign seat')}</Button></Form></>}
  </>;
}

function RollCallPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  const chair = canChair; const session = snapshot.meetingSession; const rollCall = snapshot.rollCall;
  const currentSeat = snapshot.seats.find(seat => seat.id === rollCall?.currentSeatId);
  return <>{chair && !session && <Button primary onClick={() => void run(() => api.startMeetingSession(snapshot.committee.id))}>{t('Start meeting')}</Button>}
    {chair && session?.status === 'OPEN' && !rollCall && <Button primary onClick={() => void run(() => api.startRollCall(snapshot.committee.id, session.id))}>{t('Start roll call')}</Button>}
    {rollCall && <Segment><Header as="h3">{currentSeat?.displayName ?? t(rollCall.status)}</Header>
      {chair && rollCall.status === 'IN_PROGRESS' && currentSeat && <Button.Group>{rollCall.allowedResponses.map(response => <Button key={response}
        onClick={() => void run(() => api.recordRollCallResponse(rollCall.id, rollCall.revision, currentSeat.id, response))}>{t(response)}</Button>)}</Button.Group>}
      {chair && rollCall.status === 'IN_PROGRESS' && <><Button size="small" onClick={() => void run(() => api.undoRollCall(rollCall.id, rollCall.revision))}>{t('Undo last response')}</Button>
        <Button size="small" onClick={() => void run(() => api.resetRollCall(rollCall.id, rollCall.revision))}>{t('Reset roll call')}</Button></>}
      <List>{rollCall.entries.map(entry => <List.Item key={entry.id}>{entry.seatDisplayName}<Label>{t(entry.response)}</Label></List.Item>)}</List></Segment>}
    <Table basic="very"><Table.Header><Table.Row><Table.HeaderCell>{t('Seat')}</Table.HeaderCell><Table.HeaderCell>{t('Attendance')}</Table.HeaderCell>
      {chair && <Table.HeaderCell>{t('Actions')}</Table.HeaderCell>}</Table.Row></Table.Header><Table.Body>{snapshot.seats.map(seat => {
        const state = snapshot.attendance.find(item => item.seatId === seat.id)?.state ?? 'ABSENT';
        return <Table.Row key={seat.id}><Table.Cell>{seat.displayName}</Table.Cell><Table.Cell>{t(state)}</Table.Cell>{chair && session?.status === 'OPEN' && <Table.Cell>
          {(['PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT'] as const).map(type => <Button key={type} size="mini"
            onClick={() => void run(() => api.createAttendanceEvent(snapshot.committee.id, session.id, seat.id, type))}>{t(type)}</Button>)}</Table.Cell>}</Table.Row>;
      })}</Table.Body></Table>
  </>;
}

function PointsPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  const [type, setType] = React.useState('point-of-order'); const [content, setContent] = React.useState('');
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? ''); const chair = canChair;
  const session = snapshot.meetingSession;
  const create = async () => { if (!session) return; await run(() => api.createPoint(snapshot.committee.id,
    {meetingSessionId: session.id, pointTypeId: type, content, ...(chair && seatId ? {onBehalfOfSeatId: seatId} : {})})); setContent(''); };
  const canRaise = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  return <>{canRaise && session?.status === 'OPEN' && <Form onSubmit={create}><Form.Input label={t('Point type')} value={type} onChange={e => setType(e.currentTarget.value)} />
    {chair && <Form.Select label={t('Represented seat')} value={seatId} options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
      onChange={(_, data) => setSeatId(String(data.value))} />}
    <Form.TextArea label={t('Point')} required value={content} onChange={(_, data) => setContent(String(data.value))} />
    <Button primary disabled={!content.trim() || (chair && !seatId)}>{t('Raise point')}</Button></Form>}
    <List divided>{snapshot.points.map(item => { const full = 'content' in item ? item as CommitteePoint : undefined;
      return <List.Item key={item.id}><List.Content floated="right">{chair && item.status === 'PENDING' && <Button size="mini" onClick={() => {
        const response = window.prompt(t('Chair response'), ''); if (response !== null) void run(() => api.resolvePoint(item.id, item.revision, 'ANSWERED', response));
      }}>{t('Respond')}</Button>}</List.Content><List.Header>{item.raisedBySeatDisplayName} · {t(item.pointTypeId)}</List.Header>
        <List.Description>{full?.content}<Label>{t(item.status)}</Label>{full?.chairResponse && <div>{full.chairResponse}</div>}</List.Description></List.Item>;
    })}</List></>;
}

export function SelfHostedCommitteeWorkspace({api = selfHostedApi, user}: {api?: SelfHostedApi; user?: SelfHostedUser}) {
  const {id} = useParams<{id: string}>(); const [snapshot, setSnapshot] = React.useState<CommitteeWorkspaceSnapshot>();
  const [streamAfter, setStreamAfter] = React.useState<number>();
  const [view, setView] = React.useState<WorkspaceView>('overview'); const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);
  const refresh = React.useCallback(async () => { try { const next = await api.snapshot(id); setSnapshot(next);
      setStreamAfter(current => current ?? next.sync.committeeEventSequence); setError(undefined); return next; }
    catch (caught) { setError(errorText(caught)); return undefined; } }, [api, id]);
  React.useEffect(() => { void refresh(); const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus); }, [refresh]);
  React.useEffect(() => {
    if (streamAfter === undefined) return;
    return api.openCommitteeEvents(id, streamAfter, {
      onEvent: event => { if (event.type !== 'sync.cursor_advanced') void refresh(); },
      onState: () => undefined,
      onResyncRequired: async () => (await refresh())?.sync.committeeEventSequence ?? streamAfter
    });
  }, [api, id, refresh, streamAfter]);
  const run = React.useCallback(async (operation: () => Promise<unknown>) => { setWorking(true); setError(undefined);
    try { await operation(); } catch (caught) { setError(errorText(caught));
      if (caught instanceof SelfHostedApiError && caught.code === 'REVISION_CONFLICT') await refresh();
    } finally { await refresh(); setWorking(false); } }, [refresh]);
  if (!snapshot && !error) return <Loading />;
  if (!snapshot) return <Container text><Message error content={error} /><Button onClick={() => void refresh()}>{t('Retry')}</Button></Container>;
  const canChair = (snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER')
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  const panels: Record<WorkspaceView, React.ReactNode> = {overview: <Overview snapshot={snapshot} run={run} api={api} canChair={canChair} />,
    notes: <TextResources kind="notes" snapshot={snapshot} run={run} api={api} />, posts: <TextResources kind="posts" snapshot={snapshot} run={run} api={api} />,
    files: <FilesPanel snapshot={snapshot} api={api} currentUserId={user?.id} />,
    'roll-call': <RollCallPanel snapshot={snapshot} run={run} api={api} canChair={canChair} />,
    points: <PointsPanel snapshot={snapshot} run={run} api={api} canChair={canChair} />,
    proceedings: <ProceedingsPanel snapshot={snapshot} run={run} api={api} canChair={canChair} />};
  const viewLabels: Record<WorkspaceView, string> = {overview: t('overview'), notes: t('notes'), posts: t('posts'),
    files: '文件', 'roll-call': t('roll-call'), points: t('points'), proceedings: '议事'};
  return <Container style={{padding: '1em'}}><Header as="h1">{snapshot.committee.name}</Header>{error && <Message error content={error} />}
    <Menu pointing secondary stackable>{(['overview', 'notes', 'posts', 'files', 'roll-call', 'points', 'proceedings'] as WorkspaceView[]).map(item => <Menu.Item key={item}
      active={view === item} onClick={() => setView(item)}>{viewLabels[item]}</Menu.Item>)}<Menu.Menu position="right"><Menu.Item onClick={() => void refresh()}>
        <Icon name="refresh" />{t('Refresh')}</Menu.Item></Menu.Menu></Menu>
    <Segment loading={working}>{panels[view]}</Segment>
  </Container>;
}

export default function SelfHostedWorkspace({user, logout, accountManager, api = selfHostedApi}: {
  user: SelfHostedUser; logout(): void; accountManager?: React.ReactNode; api?: SelfHostedApi;
}) {
  return <><AppMenu user={user} logout={logout} /><Switch>
    <Route exact path="/committees"><CommitteeList api={api} /></Route>
    <Route exact path="/countries"><CountryTemplateManager api={api} /></Route>
    <Route exact path="/templates"><CommitteeTemplateManager api={api} /></Route>
    {user.isSystemAdmin && <Route exact path="/storage"><Container style={{padding: '1em'}}><StorageAdminPanel api={api} /></Container></Route>}
    {user.isSystemAdmin && <Route exact path="/operations"><Container style={{padding: '1em'}}><OperationsPanel api={api} /></Container></Route>}
    <Route path="/committees/:id"><SelfHostedCommitteeWorkspace api={api} user={user} /></Route>
    {user.isSystemAdmin && <Route exact path="/admin">{accountManager}</Route>}
    <Route exact path="/"><Redirect to={user.isSystemAdmin ? '/admin' : '/committees'} /></Route>
    <Redirect to="/committees" />
  </Switch></>;
}

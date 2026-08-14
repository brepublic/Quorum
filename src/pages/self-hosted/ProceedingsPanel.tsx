import * as React from 'react';
import type {
  AuthoritativeTimer,
  CommitteeWorkspaceSnapshot,
  ProceedingDocument,
  SpeakerList,
  SpeechRecord,
  YieldType
} from '@quorum/contracts';
import {Button, Card, Form, Header, Label, List, Menu, Message, Segment} from 'semantic-ui-react';
import {Link} from 'react-router-dom';
import {t} from '../../i18n';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {localizedDisplayName} from './TemplateManagers';

type Run = (operation: () => Promise<unknown>) => Promise<void>;
type View = 'motions' | 'unmod' | 'caucus' | 'strawpoll' | 'resolution';

export function mapRuleYieldTypes(values: string[]): YieldType[] {
  const yieldMap: Record<string, YieldType> = {CHAIR: 'CHAIR', DELEGATE: 'SEAT', SEAT: 'SEAT',
    QUESTION: 'QUESTIONS', QUESTIONS: 'QUESTIONS', COMMENT: 'COMMENTS', COMMENTS: 'COMMENTS'};
  return values.map(value => yieldMap[value]).filter((value): value is YieldType => Boolean(value));
}

const statusLabels: Record<string, string> = {
  PENDING: 'Pending second', SECONDED: 'Seconded', VOTING: 'Voting', PASSED: 'Passed', FAILED: 'Failed',
  WITHDRAWN: 'Withdrawn', SUPERSEDED: 'Superseded', OPEN: 'Open', CLOSED: 'Closed', PUBLISHED: 'Published',
  DRAFT: 'Draft', POSTPONED: 'Postponed', INCORPORATED: 'Incorporated', REJECTED: 'Rejected'
};

function statusLabel(value: string): string { return t(statusLabels[value] ?? value); }

function TimerRemaining({timer}: {timer: AuthoritativeTimer}) {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    setElapsed(0);
    if (!timer.running) return;
    const started = performance.now();
    const interval = window.setInterval(() => setElapsed(performance.now() - started), 250);
    return () => window.clearInterval(interval);
  }, [timer.id, timer.revision, timer.running]);
  const seconds = Math.ceil(Math.max(0, timer.remainingMs - (timer.running ? elapsed : 0)) / 1000);
  return <time dateTime={`PT${seconds}S`}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</time>;
}

function TimerControls({timer, run, api, canChair}: {timer?: AuthoritativeTimer; run: Run; api: SelfHostedApi; canChair: boolean}) {
  const [pending, setPending] = React.useState<string>();
  if (!timer) return <Message content={t('No timer')} />;
  const command = async (action: 'start' | 'pause' | 'resume' | 'reset') => {
    setPending(action);
    try {await run(() => api.commandTimer(timer.id, action, timer.revision,
      action === 'reset' ? timer.remainingAtStartMs : undefined));} finally {setPending(undefined);}
  };
  const action = timer.running ? 'pause' : timer.remainingMs === timer.remainingAtStartMs ? 'start' : 'resume';
  return <Segment textAlign="center" className="proceedings-timer">
    <Header as="h2"><TimerRemaining timer={timer} /></Header>
    {canChair && <Button.Group><Button primary loading={pending === action} onClick={() => void command(action)}>{t(action)}</Button>
      <Button loading={pending === 'reset'} onClick={() => void command('reset')}>{t('Reset')}</Button></Button.Group>}
  </Segment>;
}

function UnmoderatedCaucus({snapshot, run, api, canChair}: CommonProps) {
  const [minutes, setMinutes] = React.useState(10); const [pending, setPending] = React.useState(false);
  const timer = (snapshot.timers ?? []).find(item => item.ownerType === 'COMMITTEE' && item.ownerId === snapshot.committee.id);
  const create = async () => {
    setPending(true);
    try {await run(() => api.createTimer(snapshot.committee.id, 'COMMITTEE', snapshot.committee.id, minutes * 60_000));}
    finally {setPending(false);}
  };
  return <><Header as="h1">{t('Unmoderated caucus')}</Header>
    {timer ? <TimerControls timer={timer} run={run} api={api} canChair={canChair} /> : canChair
      ? <Form onSubmit={create}><Form.Input type="number" min={1} label={t('Duration in minutes')} value={minutes}
        onChange={event => setMinutes(Number(event.currentTarget.value))} />
        <Button primary loading={pending} disabled={!Number.isFinite(minutes) || minutes < 1}>{t('Create timer')}</Button></Form>
      : <Message content={t('No timer')} />}</>;
}

function currentSpeech(list: SpeakerList): SpeechRecord | undefined {
  return list.speeches?.find(speech => ['READY', 'RUNNING', 'PAUSED'].includes(speech.status));
}

function SpeakerWorkspace({snapshot, run, api, canChair, resourceId}: CommonProps & {resourceId?: string}) {
  const list = (snapshot.speakerLists ?? []).find(item => item.id === resourceId);
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const [kind, setKind] = React.useState<'GENERAL' | 'MODERATED_CAUCUS'>('GENERAL');
  const defaults = snapshot.activeRules.speakerLists.find(item => item.id === (kind === 'GENERAL' ? 'general-speakers-list' : 'moderated-caucus'));
  const [topic, setTopic] = React.useState(''); const [speechSeconds, setSpeechSeconds] = React.useState(defaults?.defaultDurationSeconds ?? 60);
  const [totalMinutes, setTotalMinutes] = React.useState(Math.ceil((defaults?.defaultTotalDurationSeconds ?? 600) / 60));
  const [yieldType, setYieldType] = React.useState<YieldType>('CHAIR'); const [yieldSeat, setYieldSeat] = React.useState('');
  const [contribution, setContribution] = React.useState(''); const [contributionType, setContributionType] = React.useState<'QUESTION' | 'COMMENT'>('QUESTION');
  const canParticipate = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  if (resourceId === 'new') return <><Header as="h1">{t('Create speaker list')}</Header>{canChair && session
    ? <Form onSubmit={() => run(() => api.createSpeakerList(snapshot.committee.id, {meetingSessionId: session.id, kind,
      ...(topic.trim() ? {topic: topic.trim()} : {}), defaultSpeechMs: speechSeconds * 1000,
      ...(kind === 'MODERATED_CAUCUS' ? {totalDurationMs: totalMinutes * 60_000} : {})}))}>
      <Form.Select label={t('List type')} value={kind} options={[{key: 'general', value: 'GENERAL', text: t('General speakers list')},
        {key: 'moderated', value: 'MODERATED_CAUCUS', text: t('Moderated caucus')}]} onChange={(_, data) => setKind(data.value as typeof kind)} />
      <Form.Input label={t('Topic')} value={topic} onChange={event => setTopic(event.currentTarget.value)} />
      <Form.Input type="number" min={1} label={t('Speaker time in seconds')} value={speechSeconds}
        onChange={event => setSpeechSeconds(Number(event.currentTarget.value))} />
      {kind === 'MODERATED_CAUCUS' && <Form.Input type="number" min={1} label={t('Total time in minutes')} value={totalMinutes}
        onChange={event => setTotalMinutes(Number(event.currentTarget.value))} />}
      <Button primary>{t('Create speaker list')}</Button>
    </Form> : <Message content={session ? t('Chair capability is required.') : t('Start a meeting first.')} />}</>;
  if (!list) return <Message error content={t('Speaker list not found.')} />;
  const current = list.queue.find(entry => entry.id === list.currentEntryId);
  const next = list.queue.find(entry => entry.status === 'QUEUED');
  const speech = currentSpeech(list);
  const speechTimer = (snapshot.timers ?? []).find(timer => timer.id === list.speechTimerId);
  const totalTimer = (snapshot.timers ?? []).find(timer => timer.id === list.totalTimerId);
  const configuredYields = snapshot.activeRules.speakerLists.find(item => item.id === list.kind.toLowerCase().replace('_', '-'))?.yieldTypes;
  const allowedYields = configuredYields ? mapRuleYieldTypes(configuredYields) : ['CHAIR', 'SEAT', 'QUESTIONS', 'COMMENTS'];
  return <><Header as="h1">{list.kind === 'GENERAL' ? t('General speakers list') : t('Moderated caucus')}</Header>
    {list.topic && <Header as="h3">{list.topic}</Header>}
    {canChair && <Form.Select label={t('Represented seat')} value={seatId}
      options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
      onChange={(_, data) => setSeatId(String(data.value))} />}
    <Card.Group itemsPerRow={2} stackable><Card><Card.Content><Card.Meta>{t('Current speaker')}</Card.Meta>
      <Card.Header>{current?.seatDisplayName ?? '—'}</Card.Header></Card.Content></Card>
      <Card><Card.Content><Card.Meta>{t('Next speaker')}</Card.Meta><Card.Header>{next?.seatDisplayName ?? '—'}</Card.Header></Card.Content></Card></Card.Group>
    <div className="proceedings-timers"><TimerControls timer={totalTimer} run={run} api={api} canChair={canChair} />
      <TimerControls timer={speechTimer} run={run} api={api} canChair={canChair} /></div>
    {canParticipate && list.status === 'OPEN' && <Button onClick={() => void run(() => api.joinSpeakerQueue(list.id, canChair ? seatId : undefined))}>
      {t('Join speaker list')}</Button>}
    {canChair && list.status === 'OPEN' && <Button.Group><Button onClick={() => void run(() => api.commandSpeech(list.id,
      speech?.status === 'PAUSED' ? 'resume' : 'start', list.revision))}>{t(speech?.status === 'PAUSED' ? 'Resume speech' : 'Start speech')}</Button>
      <Button onClick={() => void run(() => api.commandSpeech(list.id, 'pause', list.revision))}>{t('Pause speech')}</Button>
      <Button onClick={() => void run(() => api.advanceSpeakerQueue(list.id, list.revision))}>{t('Next speaker')}</Button></Button.Group>}
    {canChair && speech?.canYield && speech.status === 'PAUSED' && <Form onSubmit={() => run(() => api.yieldSpeech(speech.id, speech.revision,
      yieldType, yieldType === 'SEAT' ? yieldSeat : undefined))}><Form.Select label={t('Yield to')} value={yieldType}
      options={allowedYields.map(value => ({key: value, value, text: t(value)}))} onChange={(_, data) => setYieldType(data.value as YieldType)} />
      {yieldType === 'SEAT' && <Form.Select label={t('Target seat')} value={yieldSeat}
        options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
        onChange={(_, data) => setYieldSeat(String(data.value))} />}
      <Button primary disabled={yieldType === 'SEAT' && !yieldSeat}>{t('Record yield')}</Button></Form>}
    {speech?.kind === 'INHERITED' && ['QUESTIONS', 'COMMENTS'].includes(speech.yieldType ?? '') && canParticipate && <Form
      onSubmit={async () => {await run(() => api.recordSpeechContribution(speech.id, contributionType, contribution,
        canChair ? seatId : undefined)); setContribution('');}}><Form.Select label={t('Contribution type')} value={contributionType}
      options={[{key: 'question', value: 'QUESTION', text: t('Question')}, {key: 'comment', value: 'COMMENT', text: t('Comment')}]}
      onChange={(_, data) => setContributionType(data.value as typeof contributionType)} />
      <Form.TextArea label={t('Content')} value={contribution} onChange={(_, data) => setContribution(String(data.value))} />
      <Button primary disabled={!contribution.trim()}>{t('Record contribution')}</Button></Form>}
    <Header as="h2">{t('Speaker queue')}</Header><List ordered>{list.queue.filter(entry => entry.status !== 'COMPLETED')
      .map(entry => <List.Item key={entry.id}>{entry.seatDisplayName} <Label>{t(entry.status)}</Label></List.Item>)}</List></>;
}

function Ballots({snapshot, run, api, canChair, subjectId}: CommonProps & {subjectId?: string}) {
  const ballots = (snapshot.ballots ?? []).filter(ballot => !subjectId || ballot.subjectId === subjectId);
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const canVote = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  return <><Header as="h2">{t('Formal ballot')}</Header>{canChair && <Form.Select label={t('Represented seat')} value={seatId}
    options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
    onChange={(_, data) => setSeatId(String(data.value))} />}
    <List divided>{ballots.map(ballot => <List.Item key={ballot.id}><List.Header>{statusLabel(ballot.status)}</List.Header>
      {ballot.status === 'OPEN' && canVote && ballot.choices.map(choice => <Button key={choice} size="mini"
        onClick={() => void run(() => api.castVote(ballot.id, choice, canChair ? seatId : undefined))}>{t(choice)}</Button>)}
      {canChair && ballot.status === 'OPEN' && <Button size="mini" onClick={() => void run(() => api.closeBallot(ballot.id, ballot.revision))}>{t('Close ballot')}</Button>}
      {canChair && ballot.status === 'CLOSED' && <Button size="mini" primary onClick={() => void run(() => api.publishBallot(ballot.id,
        ballot.revision))}>{t('Publish result')}</Button>}
      {canChair && snapshot.activeRules.ballots.chairMayCorrectVote && ballot.status === 'OPEN'
        && <BallotCorrection ballot={ballot} run={run} api={api} />}
      {ballot.votes.length > 0 && <List.Description>{ballot.votes.map(vote => `${vote.seatDisplayName}: ${t(vote.choice)}`).join(' · ')}</List.Description>}
      {ballot.result && <List.Description>{t('FOR')} {ballot.result.forCount} · {t('AGAINST')} {ballot.result.againstCount} · {t('ABSTAIN')} {ballot.result.abstainCount}</List.Description>}
    </List.Item>)}</List></>;
}

function BallotCorrection({ballot, run, api}: {ballot: NonNullable<CommitteeWorkspaceSnapshot['ballots']>[number]; run: Run; api: SelfHostedApi}) {
  const [seatId, setSeatId] = React.useState(ballot.eligibility[0]?.seatId ?? '');
  const [choice, setChoice] = React.useState<'FOR' | 'AGAINST' | 'ABSTAIN'>(ballot.choices[0] ?? 'FOR');
  const [reason, setReason] = React.useState('');
  return <Form onSubmit={async () => {await run(() => api.correctVote(ballot.id, ballot.revision, seatId, choice, reason)); setReason('');}}>
    <Form.Select label={t('Corrected seat')} value={seatId} options={ballot.eligibility.map(seat => ({key: seat.seatId,
      value: seat.seatId, text: seat.seatDisplayName}))} onChange={(_, data) => setSeatId(String(data.value))} />
    <Form.Select label={t('Corrected vote')} value={choice} options={ballot.choices.map(value => ({key: value, value, text: t(value)}))}
      onChange={(_, data) => setChoice(data.value as typeof choice)} />
    <Form.Input label={t('Correction reason')} value={reason} onChange={event => setReason(event.currentTarget.value)} />
    <Button size="mini" disabled={!seatId || !reason.trim()}>{t('Correct vote')}</Button>
  </Form>;
}

function Motions({snapshot, run, api, canChair}: CommonProps) {
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const types = snapshot.activeRules.motionTypes;
  const [motionType, setMotionType] = React.useState(types[0]?.id ?? '');
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const represented = canChair && seatId ? {onBehalfOfSeatId: seatId} : {};
  const canParticipate = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  if (!session) return <Message content={t('Start a meeting first.')} />;
  return <><Header as="h1">{t('Motions')}</Header>{canChair && <Form.Select label={t('Represented seat')} value={seatId}
    options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
    onChange={(_, data) => setSeatId(String(data.value))} />}
    {canParticipate && <Form onSubmit={() => run(() => api.proposeMotion(snapshot.committee.id,
      {meetingSessionId: session.id, motionTypeId: motionType, ...represented}))}>
      <Form.Select label={t('Motion type')} value={motionType} options={types.map(type => ({key: type.id, value: type.id,
        text: type.names ? localizedDisplayName(type.names, 'zh-CN') : type.id}))} onChange={(_, data) => setMotionType(String(data.value))} />
      <Button primary disabled={!motionType || (canChair && !seatId)}>{t('Propose motion')}</Button></Form>}
    <Card.Group>{(snapshot.motions ?? []).map(motion => <Card key={motion.id}><Card.Content><Card.Header>{types.find(type => type.id === motion.motionTypeId)?.names
      ? localizedDisplayName(types.find(type => type.id === motion.motionTypeId)!.names!, 'zh-CN') : motion.motionTypeId}</Card.Header>
      <Card.Meta>{motion.proposedBySeatDisplayName} · {statusLabel(motion.status)}</Card.Meta>
      <Card.Description>{t('Seconds')}: {motion.seconds.length}/{motion.requiredSecondCount}</Card.Description></Card.Content>
      <Card.Content extra>{canParticipate && motion.status === 'PENDING' && <Button size="mini" onClick={() => void run(() => api.secondMotion(motion.id,
        canChair ? seatId : undefined))}>{t('Second')}</Button>}{canChair && ['PENDING', 'SECONDED', 'VOTING'].includes(motion.status) && <>
        <Button size="mini" positive onClick={() => void run(() => api.decideMotion(motion.id, motion.revision, 'PASSED'))}>{t('Pass')}</Button>
        <Button size="mini" negative onClick={() => void run(() => api.decideMotion(motion.id, motion.revision, 'FAILED'))}>{t('Fail')}</Button></>}
      {canChair && motion.status === 'PASSED' && <Button size="mini" onClick={() => void run(() => api.createBallot(snapshot.committee.id,
        {meetingSessionId: session.id, subjectType: 'MOTION', subjectId: motion.id, procedural: true,
          thresholdKind: 'SIMPLE_MAJORITY'}))}>{t('Open procedural ballot')}</Button>}</Card.Content></Card>)}</Card.Group>
    <Ballots snapshot={snapshot} run={run} api={api} canChair={canChair} /></>;
}

function StrawpollWorkspace({snapshot, run, api, canChair, resourceId}: CommonProps & {resourceId?: string}) {
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [question, setQuestion] = React.useState(''); const [options, setOptions] = React.useState(t('For,Against'));
  const [mode, setMode] = React.useState<'ANONYMOUS' | 'SEAT_AUTHENTICATED'>(snapshot.activeRules.ballots.anonymousStrawpoll
    ? 'ANONYMOUS' : 'SEAT_AUTHENTICATED');
  const [token, setToken] = React.useState(''); const [choice, setChoice] = React.useState('');
  const [createdCode, setCreatedCode] = React.useState<string>();
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  if (resourceId === 'new') return <><Header as="h1">{t('Create strawpoll')}</Header>{canChair && session
    ? <><Form onSubmit={async () => {let created: Awaited<ReturnType<SelfHostedApi['createStrawpoll']>> | undefined;
      await run(async () => {created = await api.createStrawpoll(snapshot.committee.id, {meetingSessionId: session.id, question,
        votingMode: mode, multipleChoice: false, options: options.split(',').map(value => value.trim()).filter(Boolean)});});
      if (created?.anonymousAccessToken) setCreatedCode(created.anonymousAccessToken);
    }}>
      <Form.Input label={t('Question')} value={question} onChange={event => setQuestion(event.currentTarget.value)} />
      <Form.Input label={t('Options separated by commas')} value={options} onChange={event => setOptions(event.currentTarget.value)} />
      <Form.Select label={t('Voting mode')} value={mode} options={[{key: 'seat', value: 'SEAT_AUTHENTICATED', text: t('Seat-authenticated')},
        {key: 'anonymous', value: 'ANONYMOUS', text: t('Anonymous')}]} onChange={(_, data) => setMode(data.value as typeof mode)} />
      <Button primary disabled={!question.trim()}>{t('Create strawpoll')}</Button></Form>
      {createdCode && <Message info header={t('Anonymous voting code')} content={<code>{createdCode}</code>} />}</>
    : <Message content={session ? t('Chair capability is required.') : t('Start a meeting first.')} />}</>;
  const poll = (snapshot.strawpolls ?? []).find(item => item.id === resourceId);
  if (!poll) return <Message error content={t('Strawpoll not found.')} />;
  const canVote = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  return <><Header as="h1">{poll.question}</Header><Label>{poll.votingMode === 'ANONYMOUS' ? t('Anonymous') : t('Seat-authenticated')}</Label>
    {canChair && poll.votingMode === 'SEAT_AUTHENTICATED' && <Form.Select label={t('Represented seat')} value={seatId}
      options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setSeatId(String(data.value))} />}
    {poll.status === 'OPEN' && canVote && <Form onSubmit={() => run(() => api.voteStrawpoll(poll.id, {optionIds: [choice],
      ...(poll.votingMode === 'ANONYMOUS' ? {anonymousAccessToken: token} : canChair ? {onBehalfOfSeatId: seatId} : {})}))}>
      <Form.Select label={t('Vote choice')} value={choice} options={poll.options.map(option => ({key: option.id, value: option.id, text: option.label}))}
        onChange={(_, data) => setChoice(String(data.value))} />
      {poll.votingMode === 'ANONYMOUS' && <Form.Input label={t('Anonymous voting code')} value={token}
        onChange={event => setToken(event.currentTarget.value)} />}
      <Button primary disabled={!choice || (poll.votingMode === 'ANONYMOUS' && !token)}>{t('Vote')}</Button></Form>}
    {canChair && poll.status === 'OPEN' && <Button onClick={() => void run(() => api.closeStrawpoll(poll.id, poll.revision))}>{t('Close poll')}</Button>}
    <List>{poll.options.map(option => <List.Item key={option.id}>{option.label}<Label>{option.voteCount}</Label></List.Item>)}</List></>;
}

function DocumentWorkspace({snapshot, run, api, canChair, resourceId, tab}: CommonProps & {resourceId?: string; tab?: string}) {
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [title, setTitle] = React.useState(''); const [content, setContent] = React.useState('');
  const selectedDocument = (snapshot.documents ?? []).find(item => item.id === resourceId && item.kind === 'RESOLUTION');
  const [versionTitle, setVersionTitle] = React.useState(selectedDocument?.title ?? '');
  const [versionContent, setVersionContent] = React.useState(selectedDocument?.currentVersion.content ?? '');
  const [discussion, setDiscussion] = React.useState(''); const [amendmentTitle, setAmendmentTitle] = React.useState('');
  const [amendmentContent, setAmendmentContent] = React.useState('');
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const represented = canChair && seatId ? {onBehalfOfSeatId: seatId} : {};
  const canParticipate = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  React.useEffect(() => {
    if (!selectedDocument) return;
    setVersionTitle(selectedDocument.title); setVersionContent(selectedDocument.currentVersion.content);
  }, [selectedDocument?.id, selectedDocument?.revision]);
  if (resourceId === 'new') return <><Header as="h1">{t('Create draft resolution')}</Header>{canParticipate && session
    ? <Form onSubmit={async () => {await run(() => api.createResolution(snapshot.committee.id,
      {meetingSessionId: session.id, title, content, ...represented})); setTitle(''); setContent('');}}>
      {canChair && <Form.Select label={t('Represented seat')} value={seatId} options={snapshot.seats.map(seat => ({key: seat.id,
        value: seat.id, text: seat.displayName}))} onChange={(_, data) => setSeatId(String(data.value))} />}
      <Form.Input label={t('Title')} value={title} onChange={event => setTitle(event.currentTarget.value)} />
      <Form.TextArea label={t('Body')} value={content} onChange={(_, data) => setContent(String(data.value))} />
      <Button primary disabled={!title.trim() || !content.trim()}>{t('Create draft resolution')}</Button></Form>
    : <Message content={session ? t('An active seat assignment is required.') : t('Start a meeting first.')} />}</>;
  const document = selectedDocument;
  if (!document) return <Message error content={t('Draft resolution not found.')} />;
  const amendments = (snapshot.documents ?? []).filter(item => item.resolutionId === document.id);
  const activeTab = tab && ['body', 'amendments', 'ballot'].includes(tab) ? tab : 'activity';
  const base = `/committees/${snapshot.committee.id}/resolutions/${document.id}`;
  const command = (target: ProceedingDocument, action: 'PUBLISH' | 'POSTPONE' | 'RESUME' | 'RECOMMEND_BALLOT') => {
    const ids = target.kind === 'RESOLUTION'
      ? {PUBLISH: 'introduce-draft-resolution', POSTPONE: 'postpone-resolution', RESUME: 'resume-resolution', RECOMMEND_BALLOT: 'vote-on-resolution'}
      : {PUBLISH: 'introduce-amendment', POSTPONE: 'postpone-amendment', RESUME: 'resume-amendment', RECOMMEND_BALLOT: 'vote-on-amendment'};
    return run(() => api.commandDocument(target.id, target.revision, action, ids[action]));
  };
  return <><Header as="h1">{document.title}</Header>{canChair && <Form.Select label={t('Represented seat')} value={seatId}
    options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
    onChange={(_, data) => setSeatId(String(data.value))} />}<Menu pointing secondary>
    {[['activity', 'Activity'], ['body', 'Body'], ['amendments', 'Amendments'], ['ballot', 'Ballot']].map(([path, label]) =>
      <Menu.Item key={path} as={Link} to={path === 'activity' ? base : `${base}/${path}`} active={activeTab === path}>{t(label)}</Menu.Item>)}</Menu>
    {activeTab === 'activity' && <><Label>{statusLabel(document.status)}</Label><List>{document.discussion.map(entry =>
      <List.Item key={entry.id}><List.Header>{entry.seatDisplayName}</List.Header>{entry.content}</List.Item>)}</List>
      {canChair && document.status === 'DRAFT' && <Button onClick={() => void command(document, 'PUBLISH')}>{t('Publish')}</Button>}
      {canChair && document.status === 'PUBLISHED' && <><Button onClick={() => void command(document, 'POSTPONE')}>{t('Postpone')}</Button>
        <Button onClick={() => void command(document, 'RECOMMEND_BALLOT')}>{t('Recommend ballot')}</Button></>}
      {canChair && document.status === 'POSTPONED' && <Button onClick={() => void command(document, 'RESUME')}>{t('Resume discussion')}</Button>}</>}
      {activeTab === 'activity' && canParticipate && document.status === 'PUBLISHED' && <Form onSubmit={async () => {
        await run(() => api.addDocumentDiscussion(document.id, {content: discussion, ruleStableId: 'discuss-resolution', ...represented}));
        setDiscussion('');
      }}><Form.TextArea label={t('Discussion')} value={discussion} onChange={(_, data) => setDiscussion(String(data.value))} />
        <Button primary disabled={!discussion.trim()}>{t('Record discussion')}</Button></Form>}
    {activeTab === 'body' && <>{canParticipate && !['VOTING', 'PASSED', 'FAILED'].includes(document.status)
      ? <Form onSubmit={() => run(() => api.createDocumentVersion(document.id, {baseRevision: document.revision,
        title: versionTitle, content: versionContent, ...represented}))}><Form.Input label={t('Title')} value={versionTitle}
        onChange={event => setVersionTitle(event.currentTarget.value)} /><Form.TextArea label={t('Body')} value={versionContent}
        onChange={(_, data) => setVersionContent(String(data.value))} /><Button primary disabled={!versionTitle.trim() || !versionContent.trim()}>
          {t('Save new version')}</Button></Form> : <Segment style={{whiteSpace: 'pre-wrap'}}>{document.currentVersion.content}</Segment>}</>}
    {activeTab === 'amendments' && <>{canParticipate && session && document.status === 'PUBLISHED' && <Form onSubmit={async () => {
      await run(() => api.createAmendment(document.id, {meetingSessionId: session.id, title: amendmentTitle,
        content: amendmentContent, ...represented})); setAmendmentTitle(''); setAmendmentContent('');
    }}><Form.Input label={t('Amendment title')} value={amendmentTitle} onChange={event => setAmendmentTitle(event.currentTarget.value)} />
      <Form.TextArea label={t('Amendment body')} value={amendmentContent} onChange={(_, data) => setAmendmentContent(String(data.value))} />
      <Button primary disabled={!amendmentTitle.trim() || !amendmentContent.trim()}>{t('Create amendment')}</Button></Form>}
      <List divided>{amendments.map(amendment => <List.Item key={amendment.id}>
      <List.Header>{amendment.title} · {statusLabel(amendment.status)}</List.Header><List.Description>{amendment.currentVersion.content}</List.Description>
      {canChair && amendment.status === 'DRAFT' && <Button size="mini" onClick={() => void command(amendment, 'PUBLISH')}>{t('Publish')}</Button>}
    </List.Item>)}</List></>}
    {activeTab === 'ballot' && <><Ballots snapshot={snapshot} run={run} api={api} canChair={canChair} subjectId={document.id} />
      {canChair && document.status === 'VOTING' && session && <Button onClick={() => void run(() => api.createBallot(snapshot.committee.id,
        {meetingSessionId: session.id, subjectType: 'RESOLUTION', subjectId: document.id, procedural: false,
          thresholdKind: 'TWO_THIRDS'}))}>{t('Open formal ballot')}</Button>}</>}</>;
}

interface CommonProps {snapshot: CommitteeWorkspaceSnapshot; run: Run; api: SelfHostedApi; canChair: boolean}

export default function ProceedingsPanel({snapshot, run, api, canChair, view, resourceId, tab}: CommonProps & {
  view: View; resourceId?: string; tab?: string;
}) {
  if (view === 'unmod') return <UnmoderatedCaucus snapshot={snapshot} run={run} api={api} canChair={canChair} />;
  if (view === 'caucus') return <SpeakerWorkspace snapshot={snapshot} run={run} api={api} canChair={canChair} resourceId={resourceId} />;
  if (view === 'strawpoll') return <StrawpollWorkspace snapshot={snapshot} run={run} api={api} canChair={canChair} resourceId={resourceId} />;
  if (view === 'resolution') return <DocumentWorkspace snapshot={snapshot} run={run} api={api} canChair={canChair} resourceId={resourceId} tab={tab} />;
  return <Motions snapshot={snapshot} run={run} api={api} canChair={canChair} />;
}

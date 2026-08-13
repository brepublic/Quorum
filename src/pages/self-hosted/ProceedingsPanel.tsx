import * as React from 'react';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {Button, Form, Header, List, Message} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

const statusLabels: Record<string, string> = {
  PENDING: '待附议', SECONDED: '已附议', VOTING: '表决中', PASSED: '通过', FAILED: '未通过',
  WITHDRAWN: '已撤回', SUPERSEDED: '已替代', OPEN: '进行中', CLOSED: '已结束', PUBLISHED: '已发布',
  DRAFT: '草案', POSTPONED: '已延置', INCORPORATED: '已纳入', REJECTED: '未通过'
};

function statusLabel(value: string): string { return statusLabels[value] ?? value; }

function TimerRemaining({timer}: {timer: NonNullable<CommitteeWorkspaceSnapshot['timers']>[number]}) {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    setElapsed(0);
    if (!timer.running) return;
    const started = performance.now();
    const interval = window.setInterval(() => setElapsed(performance.now() - started), 250);
    return () => window.clearInterval(interval);
  }, [timer.id, timer.revision, timer.running]);
  const seconds = Math.ceil(Math.max(0, timer.remainingMs - (timer.running ? elapsed : 0)) / 1000);
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>;
}

export default function ProceedingsPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot;
  run(operation: () => Promise<unknown>): Promise<void>; api: SelfHostedApi; canChair: boolean}) {
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const [motionType, setMotionType] = React.useState('open-moderated-caucus');
  const [strawQuestion, setStrawQuestion] = React.useState('');
  const [strawOptions, setStrawOptions] = React.useState('赞成,反对');
  const [strawMode, setStrawMode] = React.useState<'ANONYMOUS' | 'SEAT_AUTHENTICATED'>('SEAT_AUTHENTICATED');
  const [strawTokens, setStrawTokens] = React.useState<Record<string, string>>({});
  const [strawAccess, setStrawAccess] = React.useState<Record<string, string>>({});
  const [strawChoices, setStrawChoices] = React.useState<Record<string, string>>({});
  const [resolutionTitle, setResolutionTitle] = React.useState('');
  const [resolutionContent, setResolutionContent] = React.useState('');
  const represented = canChair && seatId ? {onBehalfOfSeatId: seatId} : {};
  const activeLists = snapshot.speakerLists ?? []; const motions = snapshot.motions ?? [];
  const ballots = snapshot.ballots ?? []; const strawpolls = snapshot.strawpolls ?? [];
  const documents = snapshot.documents ?? [];
  if (!session) return <Message content="请先开始会期。" />;

  const createStrawpoll = async () => {
    const options = strawOptions.split(',').map(item => item.trim()).filter(Boolean);
    let created: Awaited<ReturnType<SelfHostedApi['createStrawpoll']>> | undefined;
    await run(async () => { created = await api.createStrawpoll(snapshot.committee.id, {meetingSessionId: session.id,
      question: strawQuestion.trim(), votingMode: strawMode, multipleChoice: false, options}); });
    if (created?.anonymousAccessToken) {
      setStrawTokens(current => ({...current, [created!.id]: created!.anonymousAccessToken as string}));
    }
    setStrawQuestion('');
  };

  const discuss = (document: NonNullable<CommitteeWorkspaceSnapshot['documents']>[number]) => {
    const content = window.prompt('讨论内容', ''); if (!content?.trim()) return;
    const ruleStableId = document.kind === 'RESOLUTION' ? 'discuss-resolution' : 'discuss-amendment';
    void run(() => api.addDocumentDiscussion(document.id, {content, ruleStableId, ...represented}));
  };

  const createAmendment = (resolutionId: string) => {
    const title = window.prompt('修正案标题', ''); if (!title?.trim()) return;
    const content = window.prompt('修正案正文', ''); if (!content?.trim()) return;
    void run(() => api.createAmendment(resolutionId, {meetingSessionId: session.id, title, content, ...represented}));
  };

  const createVersion = (document: NonNullable<CommitteeWorkspaceSnapshot['documents']>[number]) => {
    const title = window.prompt('标题', document.title); if (!title?.trim()) return;
    const content = window.prompt('正文', document.currentVersion.content); if (!content?.trim()) return;
    void run(() => api.createDocumentVersion(document.id, {baseRevision: document.revision, title, content, ...represented}));
  };

  return <>
    {canChair && <Form><Form.Select label="代行席位" value={seatId}
      options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
      onChange={(_, data) => setSeatId(String(data.value))} /></Form>}

    <Header as="h2">计时器</Header>
    {canChair && <Button size="small" onClick={() => void run(() => api.createTimer(snapshot.committee.id, 'COMMITTEE',
      snapshot.committee.id, 60_000))}>新建计时器</Button>}
    <List divided>{(snapshot.timers ?? []).map(timer => <List.Item key={timer.id}><List.Content floated="right">
      {canChair && <><Button size="mini" onClick={() => void run(() => api.commandTimer(timer.id,
        timer.running ? 'pause' : timer.remainingMs === timer.remainingAtStartMs ? 'start' : 'resume', timer.revision))}>
        {timer.running ? '暂停' : '开始'}</Button><Button size="mini" onClick={() => void run(() => api.commandTimer(
          timer.id, 'reset', timer.revision, timer.remainingAtStartMs))}>重置</Button></>}</List.Content>
      <List.Header><TimerRemaining timer={timer} /></List.Header></List.Item>)}</List>

    <Header as="h2">发言名单</Header>
    {canChair && <Button size="small" onClick={() => void run(() => api.createSpeakerList(snapshot.committee.id,
      {meetingSessionId: session.id, kind: 'GENERAL', defaultSpeechMs: 60_000}))}>新建主发言名单</Button>}
    {canChair && <Button size="small" onClick={() => void run(() => api.createSpeakerList(snapshot.committee.id,
      {meetingSessionId: session.id, kind: 'MODERATED_CAUCUS', topic: '有主持核心磋商', defaultSpeechMs: 60_000,
        totalDurationMs: 600_000}))}>新建有主持核心磋商</Button>}
    <List divided>{activeLists.map(list => <List.Item key={list.id}><List.Content floated="right">
      {snapshot.viewer.audience !== 'PUBLIC' && list.status === 'OPEN' && <Button size="mini" onClick={() => void run(() =>
        api.joinSpeakerQueue(list.id, canChair ? seatId : undefined))}>加入名单</Button>}
      {canChair && list.status === 'OPEN' && <><Button size="mini" onClick={() => void run(() => api.commandSpeech(
        list.id, 'start', list.revision))}>开始发言</Button><Button size="mini" onClick={() => void run(() => api.commandSpeech(
          list.id, 'pause', list.revision))}>暂停发言</Button><Button size="mini" onClick={() => void run(() => api.advanceSpeakerQueue(
            list.id, list.revision))}>下一位发言人</Button></>}</List.Content>
      <List.Header>{list.kind === 'GENERAL' ? '主发言名单' : '有主持核心磋商'} · {list.topic}</List.Header>
      <List.Description>{list.queue.map(entry => `${entry.position}. ${entry.seatDisplayName}`).join('　')}</List.Description>
    </List.Item>)}</List>

    <Header as="h2">动议</Header>
    {snapshot.viewer.audience !== 'PUBLIC' && <Form onSubmit={() => run(() => api.proposeMotion(snapshot.committee.id,
      {meetingSessionId: session.id, motionTypeId: motionType, ...represented}))}><Form.Input label="动议稳定 ID"
      value={motionType} onChange={event => setMotionType(event.currentTarget.value)} /><Button primary disabled={!motionType.trim()
        || (canChair && !seatId)}>提出动议</Button></Form>}
    <List divided>{motions.map(motion => <List.Item key={motion.id}><List.Content floated="right">
      {motion.status === 'PENDING' && <Button size="mini" onClick={() => void run(() => api.secondMotion(motion.id,
        canChair ? seatId : undefined))}>附议</Button>}
      {canChair && ['PENDING', 'SECONDED', 'VOTING'].includes(motion.status) && <><Button size="mini" positive onClick={() => void run(() =>
        api.decideMotion(motion.id, motion.revision, 'PASSED'))}>裁定通过</Button><Button size="mini" negative onClick={() => void run(() =>
          api.decideMotion(motion.id, motion.revision, 'FAILED'))}>裁定未通过</Button></>}</List.Content>
      <List.Header>{motion.motionTypeId}</List.Header><List.Description>{motion.proposedBySeatDisplayName} · {statusLabel(motion.status)}</List.Description>
      {canChair && motion.status === 'PASSED' && <Button size="mini" onClick={() => void run(() => api.createBallot(snapshot.committee.id,
        {meetingSessionId: session.id, subjectType: 'MOTION', subjectId: motion.id, procedural: true,
          thresholdKind: 'SIMPLE_MAJORITY'}))}>开始程序性表决</Button>}</List.Item>)}</List>

    <Header as="h2">正式表决</Header>
    <List divided>{ballots.map(ballot => <List.Item key={ballot.id}><List.Content floated="right">
      {ballot.status === 'OPEN' && snapshot.viewer.audience !== 'PUBLIC' && ballot.choices.map(choice => <Button key={choice}
        size="mini" onClick={() => void run(() => api.castVote(ballot.id, choice, canChair ? seatId : undefined))}>
        {choice === 'FOR' ? '赞成' : choice === 'AGAINST' ? '反对' : '弃权'}</Button>)}
      {canChair && ballot.status === 'OPEN' && <Button size="mini" onClick={() => void run(() => api.closeBallot(ballot.id,
        ballot.revision))}>结束投票</Button>}{canChair && ballot.status === 'CLOSED' && <Button size="mini" primary onClick={() => void run(() =>
          api.publishBallot(ballot.id, ballot.revision))}>公布结果</Button>}</List.Content>
      <List.Header>{ballot.subjectType === 'MOTION' ? '动议' : ballot.subjectType === 'RESOLUTION' ? '决议草案' : '修正案'} · {statusLabel(ballot.status)}</List.Header>{ballot.result && <List.Description>
        赞成 {ballot.result.forCount}　反对 {ballot.result.againstCount}　弃权 {ballot.result.abstainCount}</List.Description>}
    </List.Item>)}</List>

    <Header as="h2">意向性投票</Header>
    {canChair && <Form onSubmit={createStrawpoll}><Form.Input label="问题" required value={strawQuestion}
      onChange={event => setStrawQuestion(event.currentTarget.value)} /><Form.Input label="选项（逗号分隔）" required
      value={strawOptions} onChange={event => setStrawOptions(event.currentTarget.value)} /><Form.Select label="记名方式"
      value={strawMode} options={[{key: 'seat', value: 'SEAT_AUTHENTICATED', text: '席位实名'},
        {key: 'anonymous', value: 'ANONYMOUS', text: '匿名'}]} onChange={(_, data) => setStrawMode(data.value as typeof strawMode)} />
      <Button primary disabled={!strawQuestion.trim()}>发起意向性投票</Button></Form>}
    <List divided>{strawpolls.map(poll => <List.Item key={poll.id}><List.Content floated="right">
      {poll.status === 'OPEN' && snapshot.viewer.audience !== 'PUBLIC' && <><Form.Select inline aria-label="投票选项"
        value={strawChoices[poll.id] ?? ''} options={poll.options.map(option => ({key: option.id, value: option.id, text: option.label}))}
        onChange={(_, data) => setStrawChoices(current => ({...current, [poll.id]: String(data.value)}))} />
        {poll.votingMode === 'ANONYMOUS' && <Form.Input inline aria-label="匿名投票码" placeholder="匿名投票码"
          value={strawAccess[poll.id] ?? ''} onChange={event => setStrawAccess(current => ({...current,
            [poll.id]: event.currentTarget.value}))} />}
        <Button size="mini" disabled={!strawChoices[poll.id]} onClick={() => void run(() => api.voteStrawpoll(poll.id,
          {optionIds: [strawChoices[poll.id] as string], ...(poll.votingMode === 'ANONYMOUS'
            ? {anonymousAccessToken: strawAccess[poll.id] ?? strawTokens[poll.id]} : canChair ? {onBehalfOfSeatId: seatId} : {})}))}>投票</Button></>}
      {canChair && poll.status === 'OPEN' && <Button size="mini" onClick={() => void run(() => api.closeStrawpoll(poll.id,
        poll.revision))}>结束投票</Button>}</List.Content><List.Header>{poll.question} · {poll.votingMode === 'ANONYMOUS' ? '匿名' : '席位实名'}</List.Header>
      {strawTokens[poll.id] && <List.Description>匿名投票码：{strawTokens[poll.id]}</List.Description>}
      <List.Description>{poll.options.map(option => `${option.label} ${option.voteCount}`).join('　')}</List.Description></List.Item>)}</List>

    <Header as="h2">决议草案与修正案</Header>
    {snapshot.viewer.audience !== 'PUBLIC' && <Form onSubmit={async () => { await run(() => api.createResolution(snapshot.committee.id,
      {meetingSessionId: session.id, title: resolutionTitle, content: resolutionContent, ...represented}));
      setResolutionTitle(''); setResolutionContent(''); }}><Form.Input label="标题" required value={resolutionTitle}
      onChange={event => setResolutionTitle(event.currentTarget.value)} /><Form.TextArea label="正文" required value={resolutionContent}
      onChange={(_, data) => setResolutionContent(String(data.value))} /><Button primary disabled={!resolutionTitle.trim()
        || !resolutionContent.trim() || (canChair && !seatId)}>新建决议草案</Button></Form>}
    <List divided>{documents.map(document => <List.Item key={document.id}><List.Content floated="right">
      {snapshot.viewer.audience !== 'PUBLIC' && !['VOTING', 'PASSED', 'FAILED', 'INCORPORATED', 'REJECTED'].includes(document.status)
        && <Button size="mini" onClick={() => createVersion(document)}>新版本</Button>}
      {document.status === 'PUBLISHED' && snapshot.viewer.audience !== 'PUBLIC'
        && <Button size="mini" onClick={() => discuss(document)}>记录讨论</Button>}
      {document.kind === 'RESOLUTION' && document.status === 'PUBLISHED' && snapshot.viewer.audience !== 'PUBLIC'
        && <Button size="mini" onClick={() => createAmendment(document.id)}>新建修正案</Button>}
      {canChair && document.status === 'DRAFT' && <Button size="mini" onClick={() => void run(() => api.commandDocument(document.id,
        document.revision, 'PUBLISH', document.kind === 'RESOLUTION' ? 'introduce-draft-resolution' : 'introduce-amendment'))}>发布</Button>}
      {canChair && document.status === 'PUBLISHED' && <><Button size="mini" onClick={() => void run(() => api.commandDocument(
        document.id, document.revision, 'POSTPONE', document.kind === 'RESOLUTION' ? 'postpone-resolution' : 'postpone-amendment'))}>延置</Button>
        <Button size="mini" onClick={() => void run(() => api.commandDocument(document.id, document.revision, 'RECOMMEND_BALLOT',
          document.kind === 'RESOLUTION' ? 'vote-on-resolution' : 'vote-on-amendment'))}>建议表决</Button></>}
      {canChair && document.status === 'POSTPONED' && <Button size="mini" onClick={() => void run(() => api.commandDocument(
        document.id, document.revision, 'RESUME', document.kind === 'RESOLUTION' ? 'resume-resolution' : 'resume-amendment'))}>恢复讨论</Button>}
      {canChair && document.status === 'VOTING' && <Button size="mini" onClick={() => void run(() => api.createBallot(
        snapshot.committee.id, {meetingSessionId: session.id, subjectType: document.kind, subjectId: document.id,
          procedural: false, thresholdKind: 'TWO_THIRDS'}))}>开始正式表决</Button>}</List.Content>
      <List.Header>{document.title} · {document.kind === 'RESOLUTION' ? '决议草案' : '修正案'} · {statusLabel(document.status)}</List.Header>
      <List.Description style={{whiteSpace: 'pre-wrap'}}>{document.currentVersion.content}</List.Description>
    </List.Item>)}</List>
  </>;
}

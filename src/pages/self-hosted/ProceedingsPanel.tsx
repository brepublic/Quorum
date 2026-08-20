import * as React from 'react';
import type {
  AuthoritativeTimer,
  CommitteeWorkspaceSnapshot,
  FileEntry,
  SpeakerList,
  SpeakerQueueEntry,
  SpeakerStance,
  SpeechRecord,
  YieldType
} from '@quorum/contracts';
import {DragDropContext, Draggable, Droppable, type DropResult} from 'react-beautiful-dnd';
import {Button, Card, Checkbox, Container, Divider, Dropdown, Feed, Form, Grid, Header, Icon, Input, Label, List,
  Menu, Message, Pagination, Popup, Progress, Segment, Select, Statistic, TextArea} from 'semantic-ui-react';
import {Link, useHistory} from 'react-router-dom';
import {CountryFlagDisplay} from '../../components/CountryFlagDisplay';
import Loading from '../../components/Loading';
import {localizeGeneratedName, t} from '../../i18n';
import {newIdempotencyKey, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';
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
  DRAFT: 'Draft', POSTPONED: 'Postponed', INCORPORATED: 'Incorporated', REJECTED: 'Rejected',
  UPLOAD_COMPLETE: 'Upload complete', PENDING_REVIEW: 'Pending review'
};

function statusLabel(value: string): string { return t(statusLabels[value] ?? value); }

function seatOptionContent(seat: CommitteeWorkspaceSnapshot['seats'][number]) {
  const flag = <CountryFlagDisplay flag={seat.flag} />;
  return <span className="motion-seat-option">{flag}<span>{seat.displayName}</span></span>;
}

function useTimerRemainingMs(timer: AuthoritativeTimer): number {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    setElapsed(0);
    if (!timer.running) return;
    const started = performance.now();
    const interval = window.setInterval(() => setElapsed(performance.now() - started), 250);
    return () => window.clearInterval(interval);
  }, [timer.id, timer.revision, timer.running]);
  return Math.max(0, timer.remainingMs - (timer.running ? elapsed : 0));
}

export function formatLegacyTimer(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60);
  const paddedSeconds = String(seconds % 60).padStart(2, '0');
  const paddedMinutes = String(minutes % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`;
}

function playTimerSound(): void {
  const AudioContextClass = window.AudioContext
    ?? (window as typeof window & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass(); const oscillator = context.createOscillator();
  oscillator.type = 'sine'; oscillator.frequency.value = 440; oscillator.connect(context.destination);
  oscillator.start(); oscillator.stop(context.currentTime + 0.35);
}

type TimerControlsProps = {name: string; timer?: AuthoritativeTimer; run: Run; api: SelfHostedApi; canChair: boolean;
  onToggle?: () => Promise<void>; toggleKey?: string};

function TimerControls(props: TimerControlsProps) {
  return props.timer ? <ReadyTimerControls {...props} timer={props.timer} /> : <Message content={t('No timer')} />;
}

function ReadyTimerControls({name, timer, run, api, canChair, onToggle, toggleKey}: Omit<TimerControlsProps, 'timer'>
  & {timer: AuthoritativeTimer}) {
  const [pending, setPending] = React.useState<string>();
  const [muted, setMuted] = React.useState(true);
  const [unit, setUnit] = React.useState<'sec' | 'min'>('min');
  const [duration, setDuration] = React.useState('1');
  React.useEffect(() => {
    if (!timer) return;
    const seconds = Math.max(1, Math.ceil(timer.remainingAtStartMs / 1000));
    if (seconds % 60 === 0) {setUnit('min'); setDuration(String(seconds / 60));}
    else {setUnit('sec'); setDuration(String(seconds));}
  }, [timer?.id]);
  const remainingMs = useTimerRemainingMs(timer);
  const previousRemaining = React.useRef(remainingMs);
  React.useEffect(() => {
    if (!muted && previousRemaining.current > 0 && remainingMs <= 0) playTimerSound();
    previousRemaining.current = remainingMs;
  }, [muted, remainingMs]);
  const command = async (action: 'start' | 'pause' | 'resume' | 'reset') => {
    setPending(action);
    try {await run(() => api.commandTimer(timer.id, action, timer.revision,
      action === 'reset' ? Number(duration) * (unit === 'min' ? 60_000 : 1_000) : undefined));}
    finally {setPending(undefined);}
  };
  const action = timer.running ? 'pause' : timer.remainingMs === timer.remainingAtStartMs ? 'start' : 'resume';
  const toggle = async () => {
    if (!canChair || remainingMs <= 0 && !timer.running) return;
    setPending('toggle');
    try {if (onToggle) await onToggle(); else await command(action);} finally {setPending(undefined);}
  };
  React.useEffect(() => {
    if (!toggleKey || !canChair) return;
    const listener = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === toggleKey.toLowerCase()) void toggle();
    };
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener);
  });
  const percent = timer.remainingAtStartMs > 0 ? Math.min(100, Math.max(0, remainingMs / timer.remainingAtStartMs * 100)) : 0;
  return <Segment textAlign="center" className="proceedings-timer legacy-timer">
    <Label attached="top left" size="large">{t(name)}</Label>
    <Button size="massive" active={timer.running} loading={pending === 'toggle'} disabled={!canChair}
      onClick={() => void toggle()} className="legacy-timer-display">
      <time dateTime={`PT${Math.ceil(remainingMs / 1000)}S`}>{formatLegacyTimer(remainingMs)}</time>
    </Button>
    <Button icon active={!muted} onClick={() => setMuted(value => !value)} aria-label={muted ? t('Unmute') : t('Mute')}>
      <Icon name={muted ? 'alarm mute' : 'alarm'} />
    </Button>
    <Progress percent={percent} active={false} indicating />
    {canChair && <Form><Form.Input value={duration} placeholder={t('Duration')} error={!Number.isFinite(Number(duration)) || Number(duration) <= 0}
      onChange={event => setDuration(event.currentTarget.value)} action fluid>
      <input />
      <Select compact button value={unit} options={[{key: 'sec', value: 'sec', text: t('sec')},
        {key: 'min', value: 'min', text: t('min')}]} onChange={(_, data) => setUnit(data.value as 'sec' | 'min')} />
      <Button loading={pending === 'reset'} disabled={!Number.isFinite(Number(duration)) || Number(duration) <= 0}
        onClick={() => void command('reset')}>{t('Set')}</Button>
    </Form.Input></Form>}
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
  return <Container text className="legacy-unmod-page">
    {timer ? <TimerControls name="Unmoderated caucus" timer={timer} run={run} api={api} canChair={canChair} /> : canChair
      ? <Form onSubmit={create}><Form.Input type="number" min={1} label={t('Duration in minutes')} value={minutes}
        onChange={event => setMinutes(Number(event.currentTarget.value))} />
        <Button primary loading={pending} disabled={!Number.isFinite(minutes) || minutes < 1}>{t('Create timer')}</Button></Form>
      : <Message content={t('No timer')} />}</Container>;
}

function currentSpeech(list: SpeakerList): SpeechRecord | undefined {
  return list.speeches?.find(speech => ['READY', 'RUNNING', 'PAUSED'].includes(speech.status));
}

function SpeakerFeedEntry({entry, snapshot, canChair, onRemove, onYield, dragHandleProps}: {entry?: SpeakerQueueEntry;
  snapshot: CommitteeWorkspaceSnapshot; canChair: boolean; onRemove?: () => void; onYield?: () => void;
  dragHandleProps?: Record<string, unknown>}) {
  if (!entry) return <Feed.Event><Feed.Content><Feed.Summary>—</Feed.Summary></Feed.Content></Feed.Event>;
  const seat = snapshot.seats.find(item => item.id === entry.seatId);
  const present = snapshot.attendance?.some(item => item.seatId === entry.seatId && item.state === 'PRESENT');
  return <Feed.Event className={present ? undefined : "absent-member"}>
    <Feed.Content><Feed.Summary className="speaker-feed-row"><Feed.User>{seat ? seatOptionContent(seat) : entry.seatDisplayName}
      {!present && <Label size="mini">{t("Absent")}</Label>}</Feed.User>
      {(canChair && (onRemove || onYield) || dragHandleProps) && <span className="speaker-feed-actions">
        {canChair && onRemove && <Label size="mini" as="button" onClick={onRemove}>{t("Remove")}</Label>}
        {canChair && onYield && <Label size="mini" as="button" onClick={onYield}>{t("Yield")}</Label>}
        {dragHandleProps && <span className="speaker-drag-handle" {...dragHandleProps}>⠿</span>}
      </span>}
    </Feed.Summary></Feed.Content>
  </Feed.Event>;
}
function KeyboardShortcut({enabled, shortcut, onTrigger}: {enabled: boolean; shortcut: string; onTrigger: () => void}) {
  React.useEffect(() => {
    if (!enabled) return;
    const listener = (event: KeyboardEvent) => {
      if (event.altKey && event.key.toLowerCase() === shortcut.toLowerCase()) onTrigger();
    };
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener);
  }, [enabled, onTrigger, shortcut]);
  return null;
}

export function legacyInterlacedQueue(entries: SpeakerQueueEntry[], presentSeatIds: Set<string>): SpeakerQueueEntry[] {
  const present = entries.filter(entry => presentSeatIds.has(entry.seatId));
  const groups = {
    FOR: present.filter(entry => entry.stance === 'FOR'),
    AGAINST: present.filter(entry => entry.stance === 'AGAINST'),
    NEUTRAL: present.filter(entry => entry.stance === 'NEUTRAL')
  };
  const ordered: SpeakerQueueEntry[] = [];
  for (let index = 0; index < Math.max(groups.FOR.length, groups.AGAINST.length, groups.NEUTRAL.length); index += 1) {
    for (const stance of ['FOR', 'AGAINST', 'NEUTRAL'] as const) {
      const entry = groups[stance][index];
      if (entry) ordered.push(entry);
    }
  }
  return ordered;
}

function SpeakerWorkspace({snapshot, run, api, canChair, resourceId}: CommonProps & {resourceId?: string}) {
  const history = useHistory();
  const list = (snapshot.speakerLists ?? []).find(item => item.id === resourceId);
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const defaults = snapshot.activeRules.speakerLists.find(item => item.id === 'moderated-caucus');
  const [topic, setTopic] = React.useState(''); const [speechSeconds, setSpeechSeconds] = React.useState(defaults?.defaultDurationSeconds ?? 60);
  const [totalMinutes, setTotalMinutes] = React.useState(Math.ceil((defaults?.defaultTotalDurationSeconds ?? 600) / 60));
  const [yieldType, setYieldType] = React.useState<YieldType>('CHAIR'); const [yieldSeat, setYieldSeat] = React.useState('');
  const [contribution, setContribution] = React.useState('');
  const displayedListName = list ? localizeGeneratedName(list.name) : '';
  const [nameDraft, setNameDraft] = React.useState(displayedListName);
  const [topicDraft, setTopicDraft] = React.useState(list?.topic ?? '');
  React.useEffect(() => {
    setNameDraft(list ? localizeGeneratedName(list.name) : '');
    setTopicDraft(list?.topic ?? '');
  }, [resourceId]);
  const canParticipate = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  if (resourceId === 'new') return <><Header as="h1">{t('New caucus')}</Header>{canChair && session
    ? <Form onSubmit={async () => {let created: Awaited<ReturnType<SelfHostedApi['createSpeakerList']>> | undefined;
      await run(async () => {created = await api.createSpeakerList(snapshot.committee.id, {meetingSessionId: session.id,
        kind: 'MODERATED_CAUCUS', topic: topic.trim(), defaultSpeechMs: speechSeconds * 1000,
        totalDurationMs: totalMinutes * 60_000});});
      if (created) history.replace(`/committees/${snapshot.committee.id}/caucuses/${created.id}`);}}>
      <Form.Input required error={!topic.trim()} label={t('Topic')} value={topic}
        onChange={event => setTopic(event.currentTarget.value)} />
      <Form.Input type="number" min={1} label={t('Speaker time in seconds')} value={speechSeconds}
        onChange={event => setSpeechSeconds(Number(event.currentTarget.value))} />
      <Form.Input type="number" min={1} label={t('Total time in minutes')} value={totalMinutes}
        onChange={event => setTotalMinutes(Number(event.currentTarget.value))} />
      <Button primary disabled={!topic.trim() || speechSeconds < 1 || totalMinutes < 1}>{t('New caucus')}</Button>
    </Form> : <Message content={session ? t('Chair capability is required.') : t('Start a meeting first.')} />}</>;
  if (!list) return <Message error content={t('Speaker list not found.')} />;
  const current = list.queue.find(entry => entry.id === list.currentEntryId);
  const queued = list.queue.filter(entry => entry.status === 'QUEUED');
  const next = queued[0];
  const speech = currentSpeech(list);
  const speechTimer = (snapshot.timers ?? []).find(timer => timer.id === list.speechTimerId);
  const totalTimer = (snapshot.timers ?? []).find(timer => timer.id === list.totalTimerId);
  const configuredYields = snapshot.activeRules.speakerLists.find(item => item.id === list.kind.toLowerCase().replace('_', '-'))?.yieldTypes;
  const allowedYields = configuredYields ? mapRuleYieldTypes(configuredYields) : ['CHAIR', 'SEAT', 'QUESTIONS', 'COMMENTS'];
  const presentSeats = snapshot.seats.filter(seat => snapshot.attendance?.some(item => item.seatId === seat.id && item.state === 'PRESENT'));
  const operationAllowsDelegates = snapshot.committee.operationMode === 'DELEGATE_OPERATED';
  const delegatesCanQueue = operationAllowsDelegates && list.delegatesCanQueue;
  const persistHeader = (change: {name?: string; topic?: string}) => {
    if (!canChair) return;
    const cleaned = {...change, ...(change.name !== undefined ? {name: change.name.trim()} : {})};
    if (cleaned.name === '' || cleaned.name === list.name || cleaned.name === localizeGeneratedName(list.name)
      || cleaned.topic === list.topic) return;
    void run(() => api.updateSpeakerList(list.id, list.revision, cleaned));
  };
  const joinQueue = () => void run(() => api.joinSpeakerQueue(list.id, canChair ? seatId : undefined));
  const removeEntry = (entryId: string) => void run(() => api.removeSpeakerQueueEntry(list.id, entryId, list.revision));
  const reorder = (entryIds: string[]) => void run(() => api.reorderSpeakerQueue(list.id, list.revision, entryIds));
  const onDragEnd = (result: DropResult) => {
    if (!result.destination || result.destination.index === result.source.index) return;
    const entries = [...queued]; const [moved] = entries.splice(result.source.index, 1);
    if (!moved) return; entries.splice(result.destination.index, 0, moved); reorder(entries.map(entry => entry.id));
  };
  const toggleSpeech = () => run(() => api.commandSpeech(list.id,
    speech ? speech.status === 'RUNNING' ? 'pause' : 'resume' : 'start', speech?.revision ?? list.revision));
  const advance = () => run(async () => {
    if (speech) await api.commandSpeech(list.id, 'complete', speech.revision);
    await api.advanceSpeakerQueue(list.id, list.revision);
  });
  const timerRunning = speechTimer?.running === true;
  const pendingYield = speech?.yieldDecisionStatus === 'PENDING';
  const canAdvance = canChair && !pendingYield && (list.kind !== 'GENERAL' || !timerRunning);
  const nextControl = !current
    ? <Button basic icon primary disabled={!queued.length || !canChair} onClick={() => void advance()}><Icon name="arrow up" />{t('Stage')}</Button>
    : list.kind === 'GENERAL' && speech
      ? <><Button basic icon color={timerRunning ? 'orange' : 'green'} disabled={!canChair || pendingYield}
          onClick={() => void toggleSpeech()}><Icon name={timerRunning ? 'pause' : 'play'} />{t(timerRunning ? 'Pause' : 'Continue')}</Button>
          <Button style={{marginLeft: '0.5em'}} basic icon primary disabled={!canAdvance} onClick={() => void advance()}><Icon name="arrow up" />{t('Next')}</Button></>
      : !speech
        ? <Button basic icon positive disabled={!canChair} onClick={() => void toggleSpeech()}><Icon name="hourglass start" />{t('Start')}</Button>
        : speech.status === 'PAUSED' || speech.status === 'READY'
          ? <Button basic icon positive disabled={!canChair} onClick={() => void toggleSpeech()}><Icon name="play" />{t('Continue')}</Button>
          : <Button basic icon primary disabled={!canAdvance} onClick={() => void advance()}><Icon name="arrow up" />{queued.length ? t('Next') : t('Stop')}</Button>;
  const targetOptions = presentSeats.filter(seat => seat.id !== speech?.seatId)
    .map(seat => ({key: seat.id, value: seat.id, text: seat.displayName, content: seatOptionContent(seat)}));
  const offerAndDecide = (decision: 'ACCEPT' | 'REJECT') => {
    const targetSeatId = yieldSeat || speech?.yieldTargetSeatId || '';
    if (!speech || !targetSeatId) return;
    void run(async () => {
      const offered = speech.yieldDecisionStatus === 'PENDING' ? speech
        : await api.yieldSpeech(speech.id, speech.revision, 'SEAT', targetSeatId);
      await api.decideSpeechYield(offered.id, offered.revision, decision);
      setYieldType('CHAIR'); setYieldSeat('');
    });
  };
  const legacyYieldTo = (targetSeatId: string) => {
    if (!speech || (speechTimer?.remainingMs ?? 0) <= 1_000) return;
    void run(async () => {
      const paused = speech.status === 'RUNNING'
        ? await api.commandSpeech(list.id, 'pause', speech.revision)
        : speech;
      const offered = await api.yieldSpeech(paused.id, paused.revision, 'SEAT', targetSeatId);
      await api.decideSpeechYield(offered.id, offered.revision, 'ACCEPT');
    });
  };
  const chooseYield = (type: YieldType) => {
    if (!speech) return;
    if (type === 'CHAIR') {void run(() => api.yieldSpeech(speech.id, speech.revision, type)); return;}
    setYieldType(type); setYieldSeat('');
  };
  const chooseYieldTarget = (target: string) => {
    setYieldSeat(target);
    if (!speech || yieldType === 'SEAT') return;
    void run(async () => {await api.yieldSpeech(speech.id, speech.revision, yieldType, target);
      setYieldType('CHAIR'); setYieldSeat('');});
  };
  const inheritedTarget = snapshot.seats.find(seat => seat.id === speech?.interactionTargetSeatId
    || seat.id === speech?.yieldTargetSeatId)?.displayName;
  const yieldAvailable = list.kind === 'GENERAL' && canChair && speech?.kind === 'ORIGINAL'
    && speech.status === 'PAUSED' && speech.canYield && !pendingYield && (speechTimer?.remainingMs ?? 0) > 1_000;
  const yieldCard = list.kind === 'GENERAL' && (yieldAvailable || pendingYield || yieldType !== 'CHAIR') ? <Segment raised textAlign="center">
    <Label attached="top left" size="large">{t('Yield')}</Label>
    {yieldType === 'CHAIR' && !pendingYield ? <Button.Group vertical fluid>
      {allowedYields.includes('CHAIR') && <Button onClick={() => chooseYield('CHAIR')}>{t('Yield to the chair')}</Button>}
      {allowedYields.includes('SEAT') && <Button onClick={() => chooseYield('SEAT')}>{t('Yield to another delegate')}</Button>}
      {allowedYields.includes('QUESTIONS') && <Button onClick={() => chooseYield('QUESTIONS')}>{t('Yield to questions')}</Button>}
      {allowedYields.includes('COMMENTS') && <Button onClick={() => chooseYield('COMMENTS')}>{t('Yield to comments')}</Button>}
    </Button.Group> : <Form><Header size="small">{t(yieldType === 'QUESTIONS' ? 'Ask a question' : yieldType === 'COMMENTS' ? 'Comment' : 'Yield')}</Header>
      <Form.Dropdown icon="search" search selection value={pendingYield ? speech?.yieldTargetSeatId ?? '' : yieldSeat}
        placeholder={t('Select a delegation')} options={targetOptions} disabled={pendingYield}
        onChange={(_, data) => chooseYieldTarget(String(data.value))} />
      {(yieldType === 'SEAT' || pendingYield) && (yieldSeat || pendingYield) && <Button.Group fluid>
        <Button positive onClick={() => offerAndDecide('ACCEPT')}>{t('Accept')}</Button>
        <Button negative onClick={() => offerAndDecide('REJECT')}>{t('Reject')}</Button>
      </Button.Group>}
    </Form>}
  </Segment> : null;
  const yieldNotice = speech?.kind === 'INHERITED' && speech.yieldType === 'QUESTIONS'
    ? t('{name} may ask a question. The chair may continue the timer when the answer begins.', {name: inheritedTarget ?? ''})
    : speech?.kind === 'INHERITED' && speech.yieldType === 'COMMENTS'
      ? t('{name} will use the remaining time to comment.', {name: speech.seatDisplayName})
      : speech?.kind === 'INHERITED' && speech.yieldType === 'SEAT'
        ? t('{name} accepted the yield and inherited the remaining time.', {name: speech.seatDisplayName}) : undefined;
  const statusControl = canChair ? <Dropdown value={list.status} options={['OPEN', 'CLOSED'].map(value => ({key: value,
    value, text: t(value === 'OPEN' ? 'Open' : 'Closed')}))} onChange={(_, data) => void run(() => api.setSpeakerListStatus(list.id,
      list.revision, data.value as 'OPEN' | 'CLOSED'))} /> : <span>{t(list.status === 'OPEN' ? 'Open' : 'Closed')}</span>;
  const header = <Grid.Row><Grid.Column><Input label={statusControl} labelPosition="right" value={nameDraft} fluid size="massive"
    readOnly={!canChair} placeholder={t(list.kind === 'GENERAL' ? 'Set speakers list name' : 'Set caucus name')}
    onChange={event => setNameDraft(event.currentTarget.value)} onBlur={() => persistHeader({name: nameDraft})} />
    <Form><TextArea value={topicDraft} rows={1} readOnly={!canChair}
      placeholder={t(list.kind === 'GENERAL' ? 'Set speakers list details' : 'Set caucus details')}
      onChange={event => setTopicDraft(event.currentTarget.value)} onBlur={() => persistHeader({topic: topicDraft})} /></Form>
  </Grid.Column></Grid.Row>;
  if (list.status === 'CLOSED') return <Container className="legacy-speaker-workspace"><Grid columns="equal" stackable>{header}
    <Grid.Row><Grid.Column><Segment placeholder textAlign="center"><Header icon><Icon name="check circle outline" />
      {t(list.kind === 'GENERAL' ? 'Speakers list complete' : 'Moderated caucus complete')}</Header>
      <Button primary size="large" as={Link} to={`/committees/${snapshot.committee.id}/motions`}>{t('Go to motions')}<Icon name="arrow right" /></Button>
    </Segment></Grid.Column></Grid.Row></Grid></Container>;
  const nowSpeaking = <Segment><Label attached="top left" size="large">{t('Now speaking')}</Label><Feed size="large">
    {speech?.kind === 'INHERITED' ? <Feed.Event><Feed.Content><Feed.Summary><Feed.User>{speech.seatDisplayName}</Feed.User></Feed.Summary></Feed.Content></Feed.Event>
      : <SpeakerFeedEntry entry={current} snapshot={snapshot} canChair={canChair} onRemove={current ? () => removeEntry(current.id) : undefined} />}
  </Feed></Segment>;
  const nextSpeaking = <Segment textAlign="center"><Label attached="top left" size="large">{t('Next speaking')}</Label>
    {nextControl}
    <DragDropContext onDragEnd={onDragEnd}><Droppable droppableId={`speaker-queue-${list.id}`}>
      {provided => <div ref={provided.innerRef} {...provided.droppableProps}><Feed size="large">{queued.map((entry, index) =>
        <Draggable key={entry.id} draggableId={entry.id} index={index} isDragDisabled={!canChair}>{drag =>
          <div ref={drag.innerRef} {...drag.draggableProps}><SpeakerFeedEntry entry={entry} snapshot={snapshot} canChair={canChair}
            onRemove={() => removeEntry(entry.id)} onYield={list.kind === 'MODERATED_CAUCUS' && speech
              && speech.kind === 'ORIGINAL' && speech.canYield ? () => legacyYieldTo(entry.seatId) : undefined}
            dragHandleProps={drag.dragHandleProps as unknown as Record<string, unknown>} /></div>}
        </Draggable>)}{provided.placeholder}</Feed></div>}
    </Droppable></DragDropContext>
  </Segment>;
  const queuePanel = <Segment textAlign="center"><Label attached="top left" size="large">{t('Queue')}</Label><Form>
    {canChair && <Form.Dropdown icon="search" search selection value={seatId} error={!seatId} options={presentSeats.map(seat => ({key: seat.id,
      value: seat.id, text: seat.displayName, content: seatOptionContent(seat)}))} onChange={(_, data) => setSeatId(String(data.value))} />}
    {canChair && operationAllowsDelegates && <div className="speaker-queue-delegate-toggle"><Form.Checkbox
      label={t("Delegates can queue")} toggle checked={delegatesCanQueue}
      onChange={(_, data) => void run(() => api.updateSpeakerList(list.id, list.revision,
        {delegatesCanQueue: Boolean(data.checked)}))} /></div>}
    <Button fluid disabled={!canParticipate || (canChair ? !seatId : !delegatesCanQueue)} onClick={joinQueue}>
      <Icon name="arrow up" />{t("Join queue")}
    </Button>
  </Form></Segment>;
  const contributionForm = speech?.kind === 'INHERITED' && ['QUESTIONS', 'COMMENTS'].includes(speech.yieldType ?? '') && canParticipate
    ? <Form onSubmit={async () => {await run(() => api.recordSpeechContribution(speech.id,
      speech.yieldType === 'QUESTIONS' ? 'QUESTION' : 'COMMENT', contribution,
      canChair ? speech.interactionTargetSeatId ?? seatId : undefined)); setContribution('');}}>
      <Form.TextArea label={t('Content')} value={contribution} onChange={(_, data) => setContribution(String(data.value))} />
      <Button primary disabled={!contribution.trim()}>{t('Record contribution')}</Button></Form> : null;
  const orderedQueuePanels = snapshot.layoutSettings.moveQueueUp
    ? <>{nowSpeaking}{queuePanel}{nextSpeaking}</> : <>{nowSpeaking}{nextSpeaking}{queuePanel}</>;
  const separateTimers = list.kind === 'MODERATED_CAUCUS' && snapshot.layoutSettings.timersInSeparateColumns;
  return <Container className="legacy-speaker-workspace"><KeyboardShortcut enabled={canAdvance} shortcut="n"
    onTrigger={() => void advance()} /><Grid columns="equal" stackable>{header}{separateTimers ? <Grid.Row>
    <Grid.Column className="speaker-timer-column"><TimerControls name="Speaker timer" timer={speechTimer} run={run} api={api} canChair={canChair}
      onToggle={toggleSpeech} toggleKey="s" />{nowSpeaking}{nextSpeaking}</Grid.Column>
    <Grid.Column className="caucus-timer-column"><TimerControls name="Caucus timer" timer={totalTimer} run={run} api={api}
      canChair={canChair} toggleKey="c" />{queuePanel}</Grid.Column>
  </Grid.Row> : <Grid.Row>
    <Grid.Column>{orderedQueuePanels}</Grid.Column>
    <Grid.Column><TimerControls name="Speaker timer" timer={speechTimer} run={run} api={api} canChair={canChair}
      onToggle={toggleSpeech} toggleKey="s" />
      {list.kind === 'MODERATED_CAUCUS' && <TimerControls name="Caucus timer" timer={totalTimer} run={run} api={api}
        canChair={canChair} toggleKey="c" />}
      {list.kind === 'GENERAL' && yieldCard}{yieldNotice && <Message info content={yieldNotice} />}{contributionForm}
    </Grid.Column></Grid.Row>}</Grid></Container>;
}

function Ballots({snapshot, run, api, canChair, subjectId, embedded = false, stopAction = false}: CommonProps & {
  subjectId?: string; embedded?: boolean; stopAction?: boolean;
}) {
  const ballots = (snapshot.ballots ?? []).filter(ballot => !subjectId || ballot.subjectId === subjectId);
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const canVote = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  return <>{!embedded && <Header as="h2">{t('Formal ballot')}</Header>}{canChair && <Form.Select label={t('Represented seat')} value={seatId}
    options={snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
    onChange={(_, data) => setSeatId(String(data.value))} />}
    <List divided>{ballots.map(ballot => { const choices = Array.isArray(ballot.choices) ? ballot.choices : []; return <List.Item key={ballot.id}><List.Header>{statusLabel(ballot.status)}</List.Header>
      {ballot.status === 'OPEN' && canVote && choices.map(choice => <Button key={choice} size="mini"
        onClick={() => void run(() => api.castVote(ballot.id, choice, canChair ? seatId : undefined))}>{t(choice)}</Button>)}
      {canChair && ballot.status === 'OPEN' && !stopAction && <Button size="mini"
        onClick={() => void run(() => api.closeBallot(ballot.id, ballot.revision))}>{t('Close ballot')}</Button>}
      {canChair && ballot.status === 'CLOSED' && <Button size="mini" primary onClick={() => void run(() => api.publishBallot(ballot.id,
        ballot.revision))}>{t('Publish result')}</Button>}
      {canChair && snapshot.activeRules.ballots.chairMayCorrectVote && ballot.status === 'OPEN'
        && <BallotCorrection ballot={ballot} run={run} api={api} />}
      {ballot.votes.length > 0 && <List.Description>{ballot.votes.map(vote => `${vote.seatDisplayName}: ${t(vote.choice)}`).join(' · ')}</List.Description>}
      {ballot.result && <List.Description>{t('FOR')} {ballot.result.forCount} · {t('AGAINST')} {ballot.result.againstCount} · {t('ABSTAIN')} {ballot.result.abstainCount}</List.Description>}
      {canChair && ballot.status === 'OPEN' && stopAction && <Button className="motion-stop-voting" negative fluid
        onClick={() => void run(() => api.closeBallot(ballot.id, ballot.revision))}>{t('Stop voting')}</Button>}
    </List.Item>;})}</List></>;
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

function AmendmentCard({snapshot, amendment, run, api, canChair, representedSeatId, seatOptions}: CommonProps & {
  amendment: NonNullable<CommitteeWorkspaceSnapshot['documents']>[number]; representedSeatId: string;
  seatOptions: Array<{key: string; value: string; text: string; disabled: boolean}>;
}) {
  const [title, setTitle] = React.useState(amendment.title);
  const [content, setContent] = React.useState(amendment.currentVersion.content);
  const [source, setSource] = React.useState<'TEXT' | 'FILE'>(amendment.currentVersion.contentFile ? 'FILE' : 'TEXT');
  const [fileId, setFileId] = React.useState(amendment.currentVersion.contentFile?.id ?? '');
  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [selectedFileId, setSelectedFileId] = React.useState('');
  const [upload, setUpload] = React.useState<File>();
  const [uploadPercent, setUploadPercent] = React.useState<number>();
  const [fileError, setFileError] = React.useState('');
  const [ballotThreshold, setBallotThreshold] = React.useState<'SIMPLE_MAJORITY' | 'TWO_THIRDS'>('SIMPLE_MAJORITY');
  const represented = canChair && representedSeatId ? {onBehalfOfSeatId: representedSeatId} : {};
  const editable = snapshot.committee.status === 'ACTIVE' && (canChair || amendment.proposerSeatId === snapshot.viewer.seatId)
    && !['VOTING', 'INCORPORATED', 'REJECTED'].includes(amendment.status);
  const amendmentBallots = (snapshot.ballots ?? []).filter(ballot => ballot.subjectType === 'AMENDMENT'
    && ballot.subjectId === amendment.id);
  const hasBallot = amendmentBallots.length > 0;
  const deletable = editable && !hasBallot && !amendment.votingVersionId
    && !['VOTING', 'INCORPORATED', 'REJECTED'].includes(amendment.status);
  React.useEffect(() => {
    setTitle(amendment.title); setContent(amendment.currentVersion.content);
    setSource(amendment.currentVersion.contentFile ? 'FILE' : 'TEXT');
    setFileId(amendment.currentVersion.contentFile?.id ?? '');
  }, [amendment.id, amendment.revision]);
  React.useEffect(() => {
    if (source !== 'FILE') return;
    let active = true; setFileError('');
    void api.listFiles(snapshot.committee.id).then(items => {
      if (active) setFiles(items.filter(file => file.status !== 'DELETED'));
    }).catch(caught => {if (active) setFileError(caught instanceof Error ? caught.message : String(caught));});
    return () => {active = false;};
  }, [api, snapshot.committee.id, snapshot.sync.committeeEventSequence, source]);
  const save = (nextSource = source, nextFileId = fileId) => {
    const nextContent = nextSource === 'TEXT' ? content : '';
    const contentFileEntryId = nextSource === 'FILE' ? nextFileId : null;
    if (!editable || !title.trim() || nextSource === 'TEXT' && !nextContent.trim()
      || nextSource === 'FILE' && !contentFileEntryId
      || title === amendment.title && nextContent === amendment.currentVersion.content
        && contentFileEntryId === amendment.currentVersion.contentFile?.id) return;
    return run(() => api.createDocumentVersion(amendment.id, {baseRevision: amendment.revision,
      title, content: nextContent, contentFileEntryId, ...represented}));
  };
  const uploadFile = async () => {
    if (!upload) return;
    let attached = false; setFileError(''); setUploadPercent(0);
    try {
      await run(async () => {
        const sha256 = await sha256File(upload, {onProgress: (processed, total) =>
          setUploadPercent(total ? Math.round(processed / total * 20) : 0)});
        const created = await api.createFileUpload(snapshot.committee.id, {logicalName: upload.name,
          originalName: upload.name, mediaType: upload.type || 'application/octet-stream',
          expectedSizeBytes: upload.size, sha256}, newIdempotencyKey());
        await api.uploadFileContent(created.id, upload, newIdempotencyKey(), {onProgress: (processed, total) =>
          setUploadPercent(total ? 20 + Math.round(processed / total * 70) : 20)});
        const committed = await api.commitFileUpload(created.id, newIdempotencyKey());
        if ('kind' in committed) throw new Error(t('Waiting for Chair computer to save the file'));
        setUploadPercent(95);
        await api.createDocumentVersion(amendment.id, {baseRevision: amendment.revision, title,
          content: '', contentFileEntryId: committed.id, ...represented});
        attached = true; setUploadPercent(100);
      });
    } finally {
      if (attached) setUpload(undefined);
      setUploadPercent(undefined);
    }
  };
  const attachedFile = files.find(file => file.id === amendment.currentVersion.contentFile?.id);
  const proposed = !['INCORPORATED', 'REJECTED'].includes(amendment.status);
  const setResult = async (outcome: 'INCORPORATED' | 'REJECTED') => {
    let reason: string | undefined;
    if (!proposed) {
      const entered = window.prompt(t('Correction reason'));
      if (entered === null || !entered.trim()) return;
      reason = entered.trim();
    }
    await run(() => api.recordDocumentResult(amendment.id, amendment.revision, outcome, reason));
  };
  return <Card className="amendment-card"><Card.Content><Card.Header>
    <Dropdown selection compact value={proposed ? 'PROPOSED' : amendment.status}
      options={[{key: 'proposed', value: 'PROPOSED', text: t('Proposed'), disabled: !proposed},
        {key: 'incorporated', value: 'INCORPORATED', text: t('Incorporated'), disabled: amendment.status === 'DRAFT'},
        {key: 'rejected', value: 'REJECTED', text: t('Rejected'), disabled: amendment.status === 'DRAFT'}]}
      disabled={!canChair || amendment.status === 'VOTING' || hasBallot} onChange={(_, data) => data.value !== 'PROPOSED'
        && void setResult(data.value as 'INCORPORATED' | 'REJECTED')} />
    <Button floated="right" icon="trash" negative basic disabled={!deletable} aria-label={t('Delete')}
      onClick={() => void run(() => api.deleteAmendment(amendment.id, amendment.revision))} />
  </Card.Header><Card.Meta><Dropdown search selection fluid value={amendment.proposerSeatId || false}
    placeholder={t('Amendment proposer')} options={seatOptions} disabled={!canChair}
    onChange={(_, data) => void run(() => api.updateDocumentSettings(amendment.id,
      {baseRevision: amendment.revision, proposerSeatId: String(data.value)}))} /></Card.Meta>
  <Input fluid value={localizeGeneratedName(title)} disabled={!editable} placeholder={t('Amendment title')}
    onChange={event => setTitle(event.currentTarget.value)} onBlur={() => void save()} />
  <Divider hidden /><Button.Group basic compact><Button active={source === 'TEXT'}
    onClick={() => setSource('TEXT')}>{t('Text')}</Button><Button active={source === 'FILE'}
    onClick={() => setSource('FILE')}>{t('File')}</Button></Button.Group><Divider hidden />
  {source === 'TEXT' ? <Form><TextArea rows={3} value={content} disabled={!editable} placeholder={t('Amendment body')}
    onChange={(_, data) => setContent(String(data.value))} onBlur={() => void save()} /></Form>
    : <Segment>{fileError && <Message error content={fileError} />}
      {amendment.currentVersion.contentFile && <><Header as="h4">{amendment.currentVersion.contentFile.logicalName}</Header>
        <Label>{statusLabel(amendment.currentVersion.contentFile.status)}</Label>
        <Button as="a" href={api.fileDownloadUrl(amendment.currentVersion.contentFile.id)} download>{t('Download')}</Button>
        {editable && amendment.currentVersion.contentFile.status === 'UPLOAD_COMPLETE' && <Button disabled={!attachedFile}
          onClick={() => void run(() => api.submitFileForReview(amendment.currentVersion.contentFile!.id,
            attachedFile!.revision))}>{t('Submit for review')}</Button>}
        {canChair && amendment.currentVersion.contentFile.status === 'PENDING_REVIEW' && <Button primary disabled={!attachedFile}
          onClick={() => void run(() => api.publishFile(amendment.currentVersion.contentFile!.id,
            attachedFile!.revision))}>{t('Publish file')}</Button>}<Divider /></>}
      {editable && <Form onSubmit={() => void uploadFile()}><Form.Input type="file" label={t('Choose file')}
        input={{'aria-label': t('Amendment file'), onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          setUpload(event.currentTarget.files?.[0])}} /><Button primary disabled={!upload}>{t('Upload file')}</Button>
        {uploadPercent !== undefined && <Progress percent={uploadPercent} progress />}
        {files.length > 0 && <><Divider horizontal>{t('Existing file')}</Divider><Form.Select search selection fluid
          value={selectedFileId || false} options={files.map(file => ({key: file.id, value: file.id,
            text: `${file.logicalName} · ${statusLabel(file.status)}`}))}
          onChange={(_, data) => setSelectedFileId(String(data.value))} />
          <Button type="button" disabled={!selectedFileId} onClick={() => {setFileId(selectedFileId);
            void save('FILE', selectedFileId);}}>{t('Attach file')}</Button></>}
      </Form>}</Segment>}
  </Card.Content>
  {canChair && amendment.status === 'VOTING' && !hasBallot && snapshot.meetingSession?.status === 'OPEN'
    && <Card.Content extra><Form.Group widths="equal"><Form.Select value={ballotThreshold}
      options={[{key: 'simple', value: 'SIMPLE_MAJORITY', text: t('Simple majority')},
        {key: 'two-thirds', value: 'TWO_THIRDS', text: t('Two-thirds majority')} ]}
      onChange={(_, data) => setBallotThreshold(data.value as typeof ballotThreshold)} />
      <Button primary onClick={() => void run(() => api.createBallot(snapshot.committee.id, {
        meetingSessionId: amendment.meetingSessionId, subjectType: 'AMENDMENT', subjectId: amendment.id,
        procedural: false, thresholdKind: ballotThreshold}))}>{t('Open substantive ballot')}</Button>
    </Form.Group></Card.Content>}
  {hasBallot && <Card.Content extra><Header as="h4">{t('Formal ballot')}</Header>
    <Ballots snapshot={snapshot} run={run} api={api} canChair={canChair} subjectId={amendment.id} embedded />
  </Card.Content>}
  </Card>;
}

type MotionTimeUnit = 'sec' | 'min';

const OLD_MOTION_DISRUPTIVENESS: Record<string, number> = {
  'extend-unmoderated-caucus': 1, 'extend-moderated-caucus': 2, 'close-moderated-caucus': 2,
  'open-unmoderated-caucus': 4, 'introduce-working-paper': 4, 'open-moderated-caucus': 5,
  'propose-strawpoll': 6, 'introduce-draft-resolution': 7, 'introduce-amendment': 8,
  'suspend-draft-resolution-speakers-list': 9, 'open-debate': 10, 'suspend-debate': 10,
  'resume-debate': 10, 'close-debate': 10, 'vote-on-resolution': 10, 'vote-on-amendment': 10,
  'reorder-draft-resolutions': 11
};
const hasMotionDuration = (id: string) => ['extend-unmoderated-caucus', 'extend-moderated-caucus',
  'open-moderated-caucus', 'open-unmoderated-caucus', 'introduce-working-paper'].includes(id);
const hasMotionSpeakers = (id: string) => id === 'open-moderated-caucus';
const hasMotionDetail = (id: string) => ['open-moderated-caucus',
  'introduce-amendment', 'propose-strawpoll', 'introduce-working-paper'].includes(id);
const hasMotionTextArea = (id: string) => ['introduce-amendment', 'introduce-working-paper'].includes(id);
const hasCaucusTarget = (id: string) => ['extend-moderated-caucus', 'close-moderated-caucus'].includes(id);
const hasResolutionTarget = (id: string) => ['introduce-draft-resolution', 'suspend-draft-resolution-speakers-list',
  'vote-on-resolution'].includes(id);
const hasAmendmentTarget = (id: string) => ['introduce-amendment', 'vote-on-amendment'].includes(id);
const motionDetailLabel = (id: string) => ({'open-moderated-caucus': 'Topic', 'introduce-draft-resolution': 'Name',
  'introduce-amendment': 'Text', 'propose-strawpoll': 'Question', 'introduce-working-paper': 'Task'}[id] ?? '');
const motionDestinationLabel = (id: string) => ({'open-moderated-caucus': 'Caucuses',
  'extend-moderated-caucus': 'Caucuses', 'close-moderated-caucus': 'Caucuses',
  'open-unmoderated-caucus': 'Unmod', 'extend-unmoderated-caucus': 'Unmod',
  'introduce-working-paper': 'Unmod', 'introduce-draft-resolution': 'Draft resolution',
  'introduce-amendment': 'Amendments', 'vote-on-amendment': 'Amendments', 'vote-on-resolution': 'Voting',
  'propose-strawpoll': 'Strawpolls'}[id] ?? '');
const motionSeconds = (value: number, unit: MotionTimeUnit) => unit === 'min' ? value * 60 : value;
const linkedResolutionMotionValue = (resolutionId: string) => `open-moderated-caucus::resolution::${resolutionId}`;
const linkedResolutionMotionPrefix = 'open-moderated-caucus::resolution::';
const motionTypeFallbackLabels: Record<string, string> = {
  'open-unmoderated-caucus': 'Open unmoderated caucus',
  'open-moderated-caucus': 'Open moderated caucus',
  'extend-unmoderated-caucus': 'Extend unmoderated caucus',
  'extend-moderated-caucus': 'Extend moderated caucus',
  'close-moderated-caucus': 'Close moderated caucus',
  'introduce-draft-resolution': 'Introduce draft resolution',
  'discuss-resolution': 'Discuss resolution',
  'postpone-resolution': 'Postpone resolution',
  'resume-resolution': 'Resume resolution',
  'introduce-amendment': 'Introduce amendment',
  'discuss-amendment': 'Discuss amendment',
  'postpone-amendment': 'Postpone amendment',
  'resume-amendment': 'Resume amendment',
  'vote-on-amendment': 'Vote on amendment',
  'suspend-draft-resolution-speakers-list': 'Suspend draft resolution speakers list',
  'vote-on-resolution': 'Vote on resolution',
  'open-debate': 'Open debate',
  'suspend-debate': 'Suspend debate',
  'resume-debate': 'Resume debate',
  'close-debate': 'Close debate',
  'suspend-meeting': 'Suspend the meeting',
  'adjourn-meeting': 'Adjourn the meeting',
  'reorder-draft-resolutions': 'Reorder draft resolutions',
  'propose-strawpoll': 'Propose strawpoll',
  'introduce-working-paper': 'Introduce working paper'
};

function motionTypeName(type: {id: string; names?: Record<string, string>} | undefined, id: string): string {
  return type?.names ? localizedDisplayName(type.names, 'en') : t(motionTypeFallbackLabels[id] ?? id);
}

const motionTypePosition = (id: string): number => ({
  'open-debate': -1,
  'suspend-meeting': 1,
  'close-debate': 2,
  'adjourn-meeting': 3
}[id] ?? 0);

function Motions({snapshot, run, api, canChair}: CommonProps) {
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [meetingJustEnded, setMeetingJustEnded] = React.useState(false);
  const types = [...snapshot.activeRules.motionTypes].sort((first, second) => {
    const firstPosition = motionTypePosition(first.id); const secondPosition = motionTypePosition(second.id);
    if (firstPosition !== secondPosition) return firstPosition - secondPosition;
    return snapshot.activeRules.motionTypes.indexOf(first) - snapshot.activeRules.motionTypes.indexOf(second);
  });
  const [motionType, setMotionType] = React.useState(types[0]?.id ?? '');
  const [motionChoice, setMotionChoice] = React.useState(types[0]?.id ?? '');
  const [proposal, setProposal] = React.useState('');
  const [proposerId, setProposerId] = React.useState(snapshot.viewer.seatId ?? '');
  const [seconderId, setSeconderId] = React.useState('');
  const [caucusDuration, setCaucusDuration] = React.useState(10);
  const [caucusUnit, setCaucusUnit] = React.useState<MotionTimeUnit>('min');
  const [speakerDuration, setSpeakerDuration] = React.useState(60);
  const [speakerUnit, setSpeakerUnit] = React.useState<MotionTimeUnit>('sec');
  const [caucusTarget, setCaucusTarget] = React.useState('');
  const [resolutionTarget, setResolutionTarget] = React.useState('');
  const [amendmentTarget, setAmendmentTarget] = React.useState('');
  const [secondSeats, setSecondSeats] = React.useState<Record<string, string>>({});
  const [votingSeatId, setVotingSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const [proposing, setProposing] = React.useState(false);
  const delegateMode = snapshot.committee.operationMode === 'DELEGATE_OPERATED';
  const chairAdvisoryMode = snapshot.committee.operationMode === 'CHAIR_OPERATED' && canChair;
  const delegateMayPropose = delegateMode && snapshot.motionSettings.delegateMotionProposalsEnabled;
  const canPropose = snapshot.committee.status === 'ACTIVE' && (canChair
    || snapshot.viewer.audience === 'MEMBER' && delegateMayPropose);
  if (!session) return <Container text className="motions-page motions-empty-state">
    <Card className="motions-empty-card">
      <Card.Content textAlign="center">
        <Card.Description>{t(meetingJustEnded ? 'Current meeting session has ended.' : 'Open a meeting first.')}</Card.Description>
        <Button as={Link} to={`/committees/${snapshot.committee.id}/roll-call`} primary>{t('Roll call ->')}</Button>
      </Card.Content>
    </Card>
  </Container>;

  const selectedType = types.find(type => type.id === motionType);
  const needsSeconder = Boolean(selectedType && selectedType.requiredSecondCount > 0);
  const presentSeatIds = new Set(snapshot.attendance.filter(item => item.state === 'PRESENT').map(item => item.seatId));
  const presentSeats = snapshot.seats.filter(seat => presentSeatIds.has(seat.id));
  const seatOptions = snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName,
    content: seatOptionContent(seat), disabled: !presentSeatIds.has(seat.id),
    description: presentSeatIds.has(seat.id) ? undefined : t('Absent')}));
  const openCaucuses = (snapshot.speakerLists ?? []).filter(list => list.kind === 'MODERATED_CAUCUS' && list.status === 'OPEN');
  const resolutions = (snapshot.documents ?? []).filter(document => document.kind === 'RESOLUTION');
  const amendments = (snapshot.documents ?? []).filter(document => document.kind === 'AMENDMENT');
  const linkedResolutionIds = new Set((snapshot.speakerLists ?? []).map(list => list.linkedResolutionId).filter(Boolean));
  const caucusResolutionOptions = resolutions.filter(document => document.status === 'PUBLISHED'
    && document.proposerSeatId && document.seconderSeatId && !linkedResolutionIds.has(document.id));
  const motionOptions = [
    ...types.map(type => ({key: type.id, value: type.id,
      text: motionTypeName(type, type.id)})),
    ...(types.some(type => type.id === 'open-moderated-caucus') ? caucusResolutionOptions.map(document => ({
      key: linkedResolutionMotionValue(document.id), value: linkedResolutionMotionValue(document.id),
      text: `${t('Moderated caucus')} - ${localizeGeneratedName(document.title)}`})) : [])
  ];
  const targetResolutions = resolutions.filter(document => motionType === 'introduce-draft-resolution'
    ? document.status === 'DRAFT'
    : motionType === 'vote-on-resolution' ? document.status === 'PUBLISHED' : true);
  const targetAmendments = amendments.filter(document => motionType === 'introduce-amendment'
    ? document.status === 'DRAFT' : motionType === 'vote-on-amendment' ? document.status === 'PUBLISHED' : true);
  const identicalSeats = Boolean(proposerId && seconderId && proposerId === seconderId);
  const divisible = !hasMotionSpeakers(motionType)
    || motionSeconds(caucusDuration, caucusUnit) % motionSeconds(speakerDuration, speakerUnit) === 0;
  const formValid = Boolean(selectedType && proposerId && presentSeatIds.has(proposerId)
    && (chairAdvisoryMode || !needsSeconder || seconderId && presentSeatIds.has(seconderId)) && !identicalSeats
    && (chairAdvisoryMode || divisible)
    && (!hasMotionDetail(motionType) || proposal.trim())
    && (!hasCaucusTarget(motionType) || caucusTarget)
    && (!hasResolutionTarget(motionType) || resolutionTarget)
    && (!hasAmendmentTarget(motionType) || amendmentTarget));
  const propose = async () => {
    const parameters: Record<string, unknown> = {};
    if (hasMotionDetail(motionType)) parameters.proposal = proposal;
    if (hasMotionDuration(motionType)) Object.assign(parameters, {caucusDuration, caucusUnit});
    if (hasMotionSpeakers(motionType)) Object.assign(parameters, {speakerDuration, speakerUnit});
    if (hasCaucusTarget(motionType)) parameters.caucusTarget = caucusTarget;
    if (hasAmendmentTarget(motionType)) parameters.amendmentTarget = amendmentTarget;
    if (hasResolutionTarget(motionType) || motionChoice.startsWith(linkedResolutionMotionPrefix)) {
      parameters.resolutionTarget = resolutionTarget;
    }
    setProposing(true);
    try {await run(() => api.proposeMotion(snapshot.committee.id, {meetingSessionId: session.id,
      motionTypeId: motionType, ...(canChair ? {onBehalfOfSeatId: proposerId} : {}),
      ...(canChair && needsSeconder ? {secondedBySeatId: seconderId} : {}), parameters}));}
    finally {
      setProposing(false); setProposal(''); setSeconderId('');
      if (motionChoice.startsWith(linkedResolutionMotionPrefix)) {
        setMotionChoice('open-moderated-caucus'); setResolutionTarget('');
      }
      setAmendmentTarget('');
      if (canChair) setProposerId('');
      if (caucusUnit === 'min') setCaucusDuration(current => current + 1);
    }
  };
  const visibleMotions = [...(snapshot.motions ?? [])].filter(motion => motion.status !== 'WITHDRAWN')
    .sort((first, second) => Date.parse(second.createdAt) - Date.parse(first.createdAt));
  const sessionNames = new Map((snapshot.meetingSessions ?? []).map(item => [item.id, item.name]));
  if (snapshot.meetingSession) sessionNames.set(snapshot.meetingSession.id, snapshot.meetingSession.name);
  const motionGroups = visibleMotions.reduce<Array<{meetingSessionId: string; motions: typeof visibleMotions}>>((groups, motion) => {
    const group = groups.at(-1);
    if (group?.meetingSessionId === motion.meetingSessionId) group.motions.push(motion);
    else groups.push({meetingSessionId: motion.meetingSessionId, motions: [motion]});
    return groups;
  }, []);
  const currentSessionHasMotions = Boolean(snapshot.meetingSession
    && motionGroups.some(group => group.meetingSessionId === snapshot.meetingSession?.id));
  return <Container text className="motions-page">
    {canPropose && <Form className="motion-proposal-form"
      error={(!chairAdvisoryMode && !divisible) || identicalSeats} onSubmit={propose}>
      <Form.Select placeholder={t('Select type')} search selection fluid label={t('Type')} icon="search"
        options={motionOptions} value={motionChoice} onChange={(_, data) => {
          const value = String(data.value); setMotionChoice(value);
          if (value.startsWith(linkedResolutionMotionPrefix)) {
            const targetId = value.slice(linkedResolutionMotionPrefix.length);
            const target = caucusResolutionOptions.find(document => document.id === targetId);
            setMotionType('open-moderated-caucus'); setResolutionTarget(targetId);
            setProposal(target ? localizeGeneratedName(target.title) : '');
          } else {
            setMotionType(value); setResolutionTarget(''); setAmendmentTarget(''); setProposal('');
          }
        }} />
      {hasMotionDetail(motionType) && <Form.Group widths="equal">{hasMotionTextArea(motionType)
        ? <Form.TextArea required rows={2} label={t(motionDetailLabel(motionType))} placeholder={t(motionDetailLabel(motionType))}
          value={proposal} onChange={(_, data) => setProposal(String(data.value))} />
        : <Form.Input required fluid label={t(motionDetailLabel(motionType))} placeholder={t(motionDetailLabel(motionType))}
          value={proposal} onChange={event => setProposal(event.currentTarget.value)} />}</Form.Group>}
      <Form.Group widths="equal">
        <Form.Select key="proposer" icon="search" search selection fluid label={t('Proposer')}
          value={proposerId || false} error={!proposerId || !presentSeatIds.has(proposerId) || identicalSeats}
          options={seatOptions} disabled={!canChair}
          onChange={(_, data) => setProposerId(String(data.value))} />
        {needsSeconder && <Form.Select key="seconder" icon="search" search selection fluid label={t('Seconder')}
          value={seconderId || false} error={identicalSeats || !chairAdvisoryMode && (!seconderId || !presentSeatIds.has(seconderId))}
          options={seatOptions} disabled={!canChair}
          onChange={(_, data) => setSeconderId(String(data.value))} />}
      </Form.Group>
      {(hasMotionSpeakers(motionType) || hasMotionDuration(motionType) || hasCaucusTarget(motionType)
        || hasResolutionTarget(motionType) || hasAmendmentTarget(motionType)) && <Form.Group widths="equal">
        {hasCaucusTarget(motionType) && <Form.Select required key="caucusTarget" search selection fluid error={!caucusTarget}
          icon="search" label={t('Target caucus')} value={caucusTarget}
          options={openCaucuses.map(list => ({key: list.id, value: list.id, text: list.topic || t('Moderated caucus')}))}
          onChange={(_, data) => setCaucusTarget(String(data.value))} />}
        {hasResolutionTarget(motionType) && <Form.Select required key="resolutionTarget" search selection fluid error={!resolutionTarget}
          icon="search" label={t('Target resolution')} value={resolutionTarget}
          options={targetResolutions.map(document => ({key: document.id, value: document.id,
            text: localizeGeneratedName(document.title)}))}
          onChange={(_, data) => setResolutionTarget(String(data.value))} />}
        {hasAmendmentTarget(motionType) && <Form.Select required key="amendmentTarget" search selection fluid
          error={!amendmentTarget} icon="search" label={t('Target amendment')} value={amendmentTarget}
          options={targetAmendments.map(document => ({key: document.id, value: document.id,
            text: localizeGeneratedName(document.title)}))}
          onChange={(_, data) => {const id = String(data.value); const target = targetAmendments.find(item => item.id === id);
            setAmendmentTarget(id); setProposal(target?.currentVersion.content.trim()
              || target?.currentVersion.contentFile?.logicalName || target?.title || '');}} />}
        {hasMotionDuration(motionType) && <Form.Field error={!divisible}>
          <label>{t('Duration')}</label><Form.Group widths="equal"><Form.Input type="number" min={1} value={caucusDuration}
            onChange={event => setCaucusDuration(Number(event.currentTarget.value))} />
          <Form.Select value={caucusUnit} options={[{key: 'sec', value: 'sec', text: t('sec')},
            {key: 'min', value: 'min', text: t('min')}]} onChange={(_, data) => setCaucusUnit(data.value as MotionTimeUnit)} /></Form.Group>
        </Form.Field>}
        {hasMotionSpeakers(motionType) && <Form.Field error={!divisible}>
          <label>{t('Speaking time')}</label><Form.Group widths="equal"><Form.Input type="number" min={1} value={speakerDuration}
            onChange={event => setSpeakerDuration(Number(event.currentTarget.value))} />
          <Form.Select value={speakerUnit} options={[{key: 'sec', value: 'sec', text: t('sec')},
            {key: 'min', value: 'min', text: t('min')}]} onChange={(_, data) => setSpeakerUnit(data.value as MotionTimeUnit)} /></Form.Group>
        </Form.Field>}
      </Form.Group>}
      {!divisible && <Message error={!chairAdvisoryMode} warning={chairAdvisoryMode}
        content={t('Speaker time does not evenly divide the caucus time')} />}
      {chairAdvisoryMode && needsSeconder && !seconderId && <Message warning content={t('Rules recommend a seconder')} />}
      {identicalSeats && <Message error content={t("A resolution's proposer and seconder cannot be the same")} />}
      <Button type="submit" icon="plus" basic primary fluid aria-label={t('Propose motion')}
        loading={proposing} disabled={!formValid || proposing} />
    </Form>}
    <Divider hidden />
    {canChair && <><Checkbox style={{paddingRight: 50}} label={t('Delegates can propose motions')} toggle
      disabled={!delegateMode} checked={delegateMode && snapshot.motionSettings.delegateMotionProposalsEnabled}
      onChange={(_, data) => void run(() => api.setMotionSettings(snapshot.committee.id, {
        ...snapshot.motionSettings, delegateMotionProposalsEnabled: data.checked ?? false}, snapshot.committee.revision))} />
    <Checkbox label={t('Delegates can vote on motions')} toggle disabled={!delegateMode}
      checked={delegateMode && snapshot.motionSettings.delegateMotionVotingEnabled}
      onChange={(_, data) => void run(() => api.setMotionSettings(snapshot.committee.id, {
        ...snapshot.motionSettings, delegateMotionVotingEnabled: data.checked ?? false}, snapshot.committee.revision))} /></>}
    <Divider hidden />
    {snapshot.meetingSession && <Divider horizontal className="history-session-divider current-session-divider">{snapshot.meetingSession.name}</Divider>}
    {snapshot.meetingSession && !currentSessionHasMotions && <div className="current-session-empty">{t('(No motions)')}</div>}
    {motionGroups.map(group => <React.Fragment key={group.meetingSessionId}>
      {group.meetingSessionId !== snapshot.meetingSession?.id && <Divider horizontal className="history-session-divider">{sessionNames.get(group.meetingSessionId) ?? t('Meeting session')}</Divider>}
      <Card.Group itemsPerRow={1} className="motion-queue">{group.motions.map(motion => {
      const type = types.find(item => item.id === motion.motionTypeId);
      const proposer = snapshot.seats.find(seat => seat.id === motion.proposedBySeatId);
      const firstSecond = motion.seconds[0]; const seconder = snapshot.seats.find(seat => seat.id === firstSecond?.seatId);
      const duration = Number(motion.parameters.caucusDuration ?? 0);
      const durationUnit = String(motion.parameters.caucusUnit ?? 'min');
      const speech = Number(motion.parameters.speakerDuration ?? 0);
      const speechUnit = String(motion.parameters.speakerUnit ?? 'sec');
      const time = hasMotionDuration(motion.motionTypeId)
        ? hasMotionSpeakers(motion.motionTypeId) ? `${duration} ${t(durationUnit)} / ${speech} ${t(speechUnit)}`
          : `${duration} ${t(durationUnit)}` : '';
      const decided = ['PASSED', 'FAILED'].includes(motion.status);
      const proceduralMotion = motion.ruleEvaluation.resolvedValues.procedural === true;
      const motionBallots = (snapshot.ballots ?? []).filter(ballot => ballot.subjectType === 'MOTION'
        && ballot.subjectId === motion.id);
      const hasMotionBallot = motionBallots.length > 0;
      const availableSeconders = presentSeats.filter(seat => seat.id !== motion.proposedBySeatId);
      const additionalSeconder = secondSeats[motion.id] ?? availableSeconders[0]?.id ?? '';
      const counts = {FOR: 0, AGAINST: 0, ABSTAIN: 0};
      for (const vote of motion.directVote.votes) counts[vote.choice] += 1;
      return <Card className="motion motion-card" key={motion.id}><Card.Content>
        <div className="motion-heading"><Card.Header>{time && `${time} `}{motionTypeName(type, motion.motionTypeId)}</Card.Header>
          {decided ? <time className={`motion-decision motion-decision-${motion.status.toLowerCase()}`}
            dateTime={motion.decidedAt ?? undefined}>{statusLabel(motion.status)}{motion.decidedAt
              ? ` · ${new Date(motion.decidedAt).toLocaleString(document.documentElement.lang)}` : ''}</time>
            : canChair && ['PENDING', 'SECONDED'].includes(motion.status) && <Popup content={t('Delete')} trigger={<Button
              aria-label={t('Delete')} basic circular compact icon="trash" negative
              onClick={() => void run(() => api.withdrawMotion(motion.id, motion.revision))} />} />}
        </div>
        <Card.Meta className="motion-metadata">
          <div className="motion-metadata-row"><Label horizontal>{t('Proposer')}</Label><span className="motion-metadata-value">
            {proposer && seatOptionContent(proposer)}
            {!presentSeatIds.has(motion.proposedBySeatId) && <Label basic size="mini">{t('Absent')}</Label>}
          </span></div>
          {motion.requiredSecondCount > 0 && <div className="motion-metadata-row"><Label horizontal>{t('Seconder')}</Label>
            <span className="motion-metadata-value">{seconder ? seatOptionContent(seconder) : <span>—</span>}
              {seconder && !presentSeatIds.has(seconder.id) && <Label basic size="mini">{t('Absent')}</Label>}
            </span></div>}
          {hasCaucusTarget(motion.motionTypeId) && <div className="motion-metadata-row"><Label horizontal>
            {t('Target caucus')}</Label><span className="motion-metadata-value">
              {openCaucuses.find(list => list.id === motion.parameters.caucusTarget)?.topic
                ?? String(motion.parameters.caucusTarget ?? '')}
            </span></div>}
          {(hasResolutionTarget(motion.motionTypeId) || Boolean(motion.parameters.resolutionTarget))
            && <div className="motion-metadata-row"><Label horizontal>{t('Target resolution')}</Label>
              <span className="motion-metadata-value">{resolutions.find(document => document.id
                === motion.parameters.resolutionTarget)?.title ?? String(motion.parameters.resolutionTarget ?? '')}</span>
            </div>}
          {Boolean(motion.parameters.amendmentTarget) && <div className="motion-metadata-row"><Label horizontal>
            {t('Target amendment')}</Label><span className="motion-metadata-value">
              {amendments.find(document => document.id === motion.parameters.amendmentTarget)?.title
                ?? String(motion.parameters.amendmentTarget ?? '')}
            </span></div>}
          {hasMotionDetail(motion.motionTypeId) && <div className="motion-metadata-row"><Label horizontal>
            {t(motionDetailLabel(motion.motionTypeId))}</Label><span className="motion-metadata-value">
              {String(motion.parameters.proposal ?? '')}
            </span></div>}
        </Card.Meta>
      </Card.Content>
      {canChair && motion.status === 'PENDING' && motion.seconds.length < motion.requiredSecondCount && <Card.Content>
        <Form.Select search selection fluid label={t('Seconder')} value={additionalSeconder}
          options={availableSeconders.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName,
            content: seatOptionContent(seat)}))}
          onChange={(_, data) => setSecondSeats(current => ({...current, [motion.id]: String(data.value)}))} />
        <Button size="mini" disabled={!additionalSeconder}
          onClick={() => void run(() => api.secondMotion(motion.id, additionalSeconder))}>{t('Second')}</Button>
      </Card.Content>}
      {delegateMode && <Card.Content extra>
        {canChair && <Checkbox toggle label={t('Include non-voting seats')}
          disabled={Boolean(motion.directVote.startedAt) && delegateMode}
          checked={motion.directVote.includeNonVotingSeats}
          onChange={(_, data) => void run(() => api.setMotionDirectVoteSettings(motion.id,
            motion.directVote.settingsRevision, data.checked ?? false))} />}
        <div className="motion-vote-panel"><Button.Group fluid>
          <Popup content={t('Against')} trigger={<Button color="red" disabled aria-label={t('Against')}>
            <Icon name="thumbs down outline" />
            {counts.AGAINST}</Button>} />
          {motion.directVote.choices.includes('ABSTAIN') && <Popup content={t('Abstain')} trigger={<Button color="yellow"
            disabled aria-label={t('Abstain')}>
            <Icon name="circle outline" />
            {counts.ABSTAIN}</Button>} />}
          <Popup content={t('In favour')} trigger={<Button color="green" disabled aria-label={t('In favour')}>
            <Icon name="thumbs up outline" />
            {counts.FOR}</Button>} />
        </Button.Group><div className="motion-vote-result">
          <span>{t('{count} votes required to pass a motion', {count: motion.directVote.threshold})}</span>
          {motion.directVote.automaticResult === 'PASSED' && <Label color="green">{t('Passed')}</Label>}
          {motion.directVote.automaticResult === 'FAILED' && <Label color="red">{t('Failed')}</Label>}
        </div></div>
      </Card.Content>}
      {delegateMode && canChair && motion.status === 'SECONDED' && !hasMotionBallot && <Card.Content extra>
        <Button size="mini" onClick={() => void run(() => api.createBallot(snapshot.committee.id,
          {meetingSessionId: session.id, subjectType: 'MOTION', subjectId: motion.id, procedural: proceduralMotion,
            thresholdKind: 'SIMPLE_MAJORITY'}))}>{t(proceduralMotion ? 'Open procedural ballot' : 'Open substantive ballot')}</Button>
      </Card.Content>}
      {delegateMode && hasMotionBallot && <Card.Content extra className="motion-ballot-panel"><Header as="h4">{t('Formal ballot')}</Header>
        <Ballots snapshot={snapshot} run={run} api={api} canChair={canChair} subjectId={motion.id} embedded stopAction />
      </Card.Content>}
      {!decided && chairAdvisoryMode && <>
        <Button.Group fluid attached="bottom"><Button negative
          onClick={() => void run(() => api.decideMotion(motion.id, motion.revision, 'FAILED'))}>{t('Failed')}</Button>
          <Button positive disabled={!chairAdvisoryMode && !['SECONDED', 'VOTING'].includes(motion.status)}
            onClick={() => void run(async () => {
              await api.decideMotion(motion.id, motion.revision, 'PASSED');
              if (motion.motionTypeId === 'suspend-meeting') setMeetingJustEnded(true);
            })}>{t('Passed')}</Button>
        </Button.Group>
      </>}
      {decided && motion.destinationPath && motionDestinationLabel(motion.motionTypeId) && <Button as={Link}
        to={motion.destinationPath} attached="bottom" fluid primary>{t(motionDestinationLabel(motion.motionTypeId))}
        <Icon name="arrow right" /></Button>}
      </Card>;
      })}</Card.Group>
    </React.Fragment>)}
  </Container>;
}

function StrawpollWorkspace({snapshot, run, api, canChair, resourceId}: CommonProps & {resourceId?: string}) {
  const history = useHistory();
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const poll = (snapshot.strawpolls ?? []).find(item => item.id === resourceId);
  const [question, setQuestion] = React.useState(poll?.question ?? '');
  const [optionLabels, setOptionLabels] = React.useState<string[]>(poll?.options.map(option => option.label) ?? []);
  const [mode, setMode] = React.useState<'ANONYMOUS' | 'SEAT_AUTHENTICATED'>(poll?.votingMode
    ?? (snapshot.activeRules.ballots.anonymousStrawpoll ? 'ANONYMOUS' : 'SEAT_AUTHENTICATED'));
  const [multipleChoice, setMultipleChoice] = React.useState(poll?.multipleChoice ?? true);
  const [optionsArePublic, setOptionsArePublic] = React.useState(poll?.optionsArePublic ?? false);
  const [token, setToken] = React.useState('');
  const [anonymousChoices, setAnonymousChoices] = React.useState<string[]>([]);
  const [anonymousSubmitted, setAnonymousSubmitted] = React.useState(false);
  const [createdCode, setCreatedCode] = React.useState<string>();
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const [manualTallies, setManualTallies] = React.useState<Record<string, string>>(
    Object.fromEntries(poll?.options.map(option => [option.id, String(option.voteCount)]) ?? []));
  const creatingPoll = React.useRef(false);
  React.useEffect(() => {
    if (resourceId !== 'new' || creatingPoll.current || !canChair || !session) return;
    creatingPoll.current = true;
    void (async () => {
      let created: Awaited<ReturnType<SelfHostedApi['createStrawpoll']>> | undefined;
      await run(async () => {created = await api.createStrawpoll(snapshot.committee.id, {meetingSessionId: session.id,
        question: '', votingMode: mode, multipleChoice: true, options: [], medium: 'LINK', optionsArePublic: false});});
      if (created) {setCreatedCode(created.anonymousAccessToken);
        history.replace(`/committees/${snapshot.committee.id}/strawpolls/${created.id}`);}
      else creatingPoll.current = false;
    })();
  }, [api, canChair, history, mode, resourceId, run, session, snapshot.committee.id]);
  React.useEffect(() => {
    if (!poll) return;
    setQuestion(poll.question); setOptionLabels(poll.options.map(option => option.label)); setMode(poll.votingMode);
    setMultipleChoice(poll.multipleChoice); setOptionsArePublic(poll.optionsArePublic);
    setManualTallies(Object.fromEntries(poll.options.map(option => [option.id, String(option.voteCount)])));
  }, [poll?.id, poll?.revision]);
  React.useEffect(() => {setAnonymousChoices([]); setAnonymousSubmitted(false);}, [poll?.id]);
  if (resourceId === 'new') return canChair && session ? <Loading />
    : <Message content={session ? t('Chair capability is required.') : t('Start a meeting first.')} />;
  if (!poll) return <Message error content={t('Strawpoll not found.')} />;
  const canVote = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  const cleanOptions = optionLabels.map(value => value.trim()).filter(Boolean);
  const ready = Boolean(question.trim() && !/^New strawpoll \d+$/.test(question.trim()) && cleanOptions.length >= 2
    && cleanOptions.length === optionLabels.length && new Set(cleanOptions).size === cleanOptions.length);
  const canDelegateAdd = snapshot.committee.operationMode === 'DELEGATE_OPERATED' && poll.optionsArePublic
    && snapshot.viewer.audience === 'MEMBER';
  const revise = async (next: Partial<{question: string; mode: typeof mode; multipleChoice: boolean;
    options: string[]; medium: 'LINK' | 'MANUAL'; optionsArePublic: boolean}>) => {
    let created: Awaited<ReturnType<SelfHostedApi['reviseStrawpoll']>> | undefined;
    await run(async () => {created = await api.reviseStrawpoll(poll.id, {baseRevision: poll.revision,
      question: next.question ?? question, votingMode: next.mode ?? mode, multipleChoice: next.multipleChoice ?? multipleChoice,
      options: next.options ?? cleanOptions, medium: next.medium ?? poll.medium,
      optionsArePublic: next.optionsArePublic ?? optionsArePublic});});
    if (created) {if (created.anonymousAccessToken) setCreatedCode(created.anonymousAccessToken);
      history.replace(`/committees/${snapshot.committee.id}/strawpolls/${created.id}`);}
    return created;
  };
  const start = async (medium: 'LINK' | 'MANUAL') => {
    if (!ready) return;
    let created: Awaited<ReturnType<SelfHostedApi['reviseStrawpoll']>> | undefined;
    await run(async () => {
      created = await api.reviseStrawpoll(poll.id, {baseRevision: poll.revision, question: question.trim(),
        votingMode: medium === 'MANUAL' ? 'SEAT_AUTHENTICATED' : mode, multipleChoice, options: cleanOptions,
        medium, optionsArePublic});
      if (created) await api.commandStrawpollStage(created.id, created.revision, 'START');
    });
    if (created) {if (created.anonymousAccessToken) setCreatedCode(created.anonymousAccessToken);
      history.replace(`/committees/${snapshot.committee.id}/strawpolls/${created.id}`);}
  };
  const selectedSeatVote = poll.seatVotes.find(vote => vote.seatId === seatId);
  const setSeatChoice = (optionId: string) => {
    const current = selectedSeatVote?.optionIds ?? [];
    const next = poll.multipleChoice ? current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId]
      : current.includes(optionId) ? [] : [optionId];
    return run(() => api.voteStrawpoll(poll.id, {optionIds: next, ...(canChair ? {onBehalfOfSeatId: seatId} : {})}));
  };
  const toggleAnonymous = (optionId: string) => setAnonymousChoices(current => poll.multipleChoice
    ? current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId]
    : current.includes(optionId) ? [] : [optionId]);
  const totalVotes = poll.options.reduce((sum, option) => sum + option.voteCount, 0);
  return <Container text className="strawpoll-page" style={{padding: '1em 0'}}>
    <Header as="h2"><Input value={localizeGeneratedName(question)} fluid placeholder={t('Type your question here')}
      disabled={poll.stage !== 'PREPARING' || !canChair} onChange={event => setQuestion(event.currentTarget.value)}
      onBlur={() => {if (canChair && question.trim() && question !== poll.question) void revise({question: question.trim()});}} /></Header>
    {poll.stage === 'PREPARING' && <>
      {canChair && <List><List.Item><Button.Group fluid>
        <Dropdown basic button className="purple centered" options={[{key: 'many', value: true, text: t('Choose many'), icon: 'check square'},
          {key: 'one', value: false, text: t('Choose one'), icon: 'radio'}]} value={multipleChoice}
          onChange={(_, data) => {const value = Boolean(data.value); setMultipleChoice(value); void revise({multipleChoice: value});}} />
        <Dropdown basic button options={[{key: 'seat', value: 'SEAT_AUTHENTICATED', text: t('Seat-authenticated')},
          {key: 'anonymous', value: 'ANONYMOUS', text: t('Anonymous')}]} value={mode}
          onChange={(_, data) => {const value = data.value as typeof mode; setMode(value); void revise({mode: value});}} />
      </Button.Group></List.Item><List.Item><Checkbox toggle label={t('Delegates can add options')} checked={optionsArePublic}
        onChange={(_, data) => {const value = Boolean(data.checked); setOptionsArePublic(value); void revise({optionsArePublic: value});}} />
      </List.Item></List>}
      <List>{optionLabels.map((label, index) => <List.Item key={`${poll.id}-${index}`}><Input fluid action value={label}
        placeholder={t('Enter poll option')} disabled={!canChair}
        onChange={(_, data) => setOptionLabels(current => current.map((value, item) => item === index
          ? String(data.value ?? '') : value))}
        onBlur={() => {const next = optionLabels.map(value => value.trim());
          if (canChair && next[index] && next.join('\0') !== poll.options.map(option => option.label).join('\0')) void revise({options: next});}}>
        <input />{canChair && <Button negative basic icon="trash" onClick={() => {const next = optionLabels.filter((_, item) => item !== index);
          setOptionLabels(next); void revise({options: next.filter(Boolean)});}} />}</Input></List.Item>)}
        {(canChair || canDelegateAdd) && <List.Item><Button basic fluid onClick={() => {
          if (canDelegateAdd) void revise({options: [...cleanOptions, t('New option')]});
          else setOptionLabels(current => [...current, '']);}}><Icon name="plus" />{t('Add option')}</Button></List.Item>}
      </List>
      {canChair && <Button.Group fluid><Button primary basic disabled={!ready} onClick={() => void start('LINK')}>
        {t('Create shareable poll')}<Icon name="arrow right" /></Button><Button.Or text={t('or')} />
        <Button primary basic disabled={!ready} onClick={() => void start('MANUAL')}>
          {t('Create manual poll')}<Icon name="arrow right" /></Button></Button.Group>}
    </>}
    {poll.stage === 'VOTING' && <>
      {poll.medium === 'LINK' && poll.votingMode === 'SEAT_AUTHENTICATED' && canChair && <Form.Select
        label={t('Represented seat')} value={seatId} options={snapshot.seats.map(seat =>
          ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setSeatId(String(data.value))} />}
      {poll.medium === 'LINK' && poll.votingMode === 'ANONYMOUS' && canVote && <Form onSubmit={() => {
        if (!token || !anonymousChoices.length || anonymousSubmitted) return;
        void run(async () => {await api.voteStrawpoll(poll.id,
          {optionIds: anonymousChoices, anonymousAccessToken: token}); setAnonymousSubmitted(true);});}}>
        <Form.Input data-strawpoll-token label={t('Anonymous voting code')} value={token} disabled={anonymousSubmitted}
          onChange={event => setToken(event.currentTarget.value)} />
        {poll.options.map(option => <Form.Field key={option.id}><Checkbox data-strawpoll-option={option.id} label={option.label}
          radio={!poll.multipleChoice || undefined} checked={anonymousChoices.includes(option.id)} disabled={anonymousSubmitted}
          onClick={() => toggleAnonymous(option.id)} /></Form.Field>)}
        <Button primary disabled={anonymousSubmitted || !token || !anonymousChoices.length}>{t('Vote')}</Button></Form>}
      {poll.medium === 'LINK' && poll.votingMode === 'SEAT_AUTHENTICATED' && canVote && <Form>
        {poll.options.map(option => <Form.Field key={option.id}><Checkbox data-strawpoll-option={option.id} label={option.label}
          radio={!poll.multipleChoice || undefined} checked={Boolean(selectedSeatVote?.optionIds.includes(option.id))}
          onClick={() => void setSeatChoice(option.id)} /></Form.Field>)}</Form>}
      {poll.medium === 'MANUAL' && <List>{poll.options.map(option => <List.Item key={option.id}><Input fluid
        data-strawpoll-manual={option.id}
        placeholder={t('Number of votes received')} label={option.label} value={manualTallies[option.id] ?? ''}
        disabled={!canChair} onChange={event => {const value = event.currentTarget.value.replace(/\D/g, '');
          setManualTallies(current => ({...current, [option.id]: value}));}}
        onBlur={() => {const tally = Number(manualTallies[option.id]);
          if (canChair && Number.isSafeInteger(tally) && tally >= 0 && tally !== option.voteCount)
            void run(() => api.setStrawpollManualTally(poll.id, poll.revision, option.id, tally));}} /></List.Item>)}</List>}
      {createdCode && <Message info header={t('Anonymous voting code')} content={<code>{createdCode}</code>} />}
      {canChair && <Button.Group fluid><Button basic secondary onClick={() => void revise({medium: poll.medium})}>
        <Icon name="arrow left" />{t('Edit options')}</Button><Button primary basic
        onClick={() => void run(() => api.commandStrawpollStage(poll.id, poll.revision, 'VIEW_RESULTS'))}>
        {t('View results')}<Icon name="arrow right" /></Button></Button.Group>}
    </>}
    {poll.stage === 'RESULTS' && <><List>{poll.options.map(option => <List.Item key={option.id}>
      <b>{option.label}</b> {t('{count} votes', {count: option.voteCount})}
      <Progress progress="value" value={option.voteCount} total={totalVotes || 1} /></List.Item>)}</List>
      {canChair && <Button fluid secondary basic
        onClick={() => void run(() => api.commandStrawpollStage(poll.id, poll.revision, 'REOPEN'))}>
        <Icon name="arrow left" />{t('Reopen voting')}</Button>}</>}
  </Container>;
}

function DocumentWorkspace({snapshot, run, api, canChair, resourceId, tab}: CommonProps & {resourceId?: string; tab?: string}) {
  const history = useHistory();
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const selectedDocument = (snapshot.documents ?? []).find(item => item.id === resourceId && item.kind === 'RESOLUTION');
  const [versionTitle, setVersionTitle] = React.useState(selectedDocument?.title ?? '');
  const [versionContent, setVersionContent] = React.useState(selectedDocument?.currentVersion.content ?? '');
  const [contentSource, setContentSource] = React.useState<'TEXT' | 'FILE'>(
    selectedDocument?.currentVersion.contentFile ? 'FILE' : 'TEXT');
  const [versionFileId, setVersionFileId] = React.useState(selectedDocument?.currentVersion.contentFile?.id ?? '');
  const [availableFiles, setAvailableFiles] = React.useState<FileEntry[]>([]);
  const [selectedExistingFileId, setSelectedExistingFileId] = React.useState('');
  const [resolutionUpload, setResolutionUpload] = React.useState<File>();
  const [resolutionUploadPercent, setResolutionUploadPercent] = React.useState<number>();
  const [fileError, setFileError] = React.useState('');
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? snapshot.seats[0]?.id ?? '');
  const [votingPage, setVotingPage] = React.useState(0);
  const [currentVotingSeatId, setCurrentVotingSeatId] = React.useState(selectedDocument?.directVote?.eligibility[0]?.seatId ?? '');
  const [votingHistory, setVotingHistory] = React.useState<Array<{seatId: string; previousChoice: 'FOR' | 'AGAINST' | 'ABSTAIN' | null}>>([]);
  const creatingDraft = React.useRef(false);
  const represented = canChair && seatId ? {onBehalfOfSeatId: seatId} : {};
  const canParticipate = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  React.useEffect(() => {
    if (resourceId !== 'new' || creatingDraft.current || !canParticipate || !session) return;
    creatingDraft.current = true;
    void (async () => {
      let created: Awaited<ReturnType<SelfHostedApi['createResolution']>> | undefined;
      await run(async () => {created = await api.createResolution(snapshot.committee.id,
        {meetingSessionId: session.id, title: '', content: ''});});
      if (created) history.replace(`/committees/${snapshot.committee.id}/resolutions/${created.id}`);
      else creatingDraft.current = false;
    })();
  }, [api, canParticipate, history, resourceId, run, session, snapshot.committee.id]);
  React.useEffect(() => {
    if (!selectedDocument) return;
    setVersionTitle(selectedDocument.title); setVersionContent(selectedDocument.currentVersion.content);
    setContentSource(selectedDocument.currentVersion.contentFile ? 'FILE' : 'TEXT');
    setVersionFileId(selectedDocument.currentVersion.contentFile?.id ?? '');
  }, [selectedDocument?.id, selectedDocument?.revision]);
  React.useEffect(() => {
    if (contentSource !== 'FILE') return;
    let active = true; setFileError('');
    void api.listFiles(snapshot.committee.id).then(files => {
      if (active) setAvailableFiles(files.filter(file => file.status !== 'DELETED'));
    }).catch(caught => { if (active) setFileError(caught instanceof Error ? caught.message : String(caught)); });
    return () => { active = false; };
  }, [api, contentSource, snapshot.committee.id, snapshot.sync.committeeEventSequence]);
  React.useEffect(() => {
    setVotingPage(0); setVotingHistory([]);
    setCurrentVotingSeatId(selectedDocument?.directVote?.eligibility[0]?.seatId ?? '');
  }, [selectedDocument?.id]);
  if (resourceId === 'new') return canParticipate && session ? <Loading />
    : <Message content={session ? t('An active seat assignment is required.') : t('Start a meeting first.')} />;
  const document = selectedDocument;
  if (!document) return <Message error content={t('Draft resolution not found.')} />;
  const amendments = (snapshot.documents ?? []).filter(item => item.resolutionId === document.id);
  const activeTab = ({activity: 'text', body: 'text', ballot: 'voting'}[tab ?? '']
    ?? (tab && ['text', 'amendments', 'voting'].includes(tab) ? tab : 'text')) as 'text' | 'amendments' | 'voting';
  const base = `/committees/${snapshot.committee.id}/resolutions/${document.id}`;
  const editable = canParticipate && !['VOTING', 'PASSED', 'FAILED'].includes(document.status);
  const saveVersion = (nextSource = contentSource, nextFileId = versionFileId) => {
    const nextContent = nextSource === 'TEXT' ? versionContent : '';
    const contentFileEntryId = nextSource === 'FILE' ? nextFileId : null;
    if (!editable || !versionTitle.trim() || nextSource === 'FILE' && !contentFileEntryId
      || versionTitle === document.title && nextContent === document.currentVersion.content
        && contentFileEntryId === document.currentVersion.contentFile?.id) return;
    return run(() => api.createDocumentVersion(document.id, {baseRevision: document.revision,
      title: versionTitle, content: nextContent, contentFileEntryId, ...represented}));
  };
  const attachExistingFile = async () => {
    if (!selectedExistingFileId) return;
    setVersionFileId(selectedExistingFileId);
    await saveVersion('FILE', selectedExistingFileId);
  };
  const uploadResolutionFile = async () => {
    if (!resolutionUpload) return;
    let attached = false; setFileError(''); setResolutionUploadPercent(0);
    try {
      await run(async () => {
        const sha256 = await sha256File(resolutionUpload, {onProgress: (processed, total) =>
          setResolutionUploadPercent(total ? Math.round(processed / total * 20) : 0)});
        const upload = await api.createFileUpload(snapshot.committee.id, {logicalName: resolutionUpload.name,
          originalName: resolutionUpload.name, mediaType: resolutionUpload.type || 'application/octet-stream',
          expectedSizeBytes: resolutionUpload.size, sha256}, newIdempotencyKey());
        await api.uploadFileContent(upload.id, resolutionUpload, newIdempotencyKey(), {onProgress: (processed, total) =>
          setResolutionUploadPercent(total ? 20 + Math.round(processed / total * 70) : 20)});
        const committed = await api.commitFileUpload(upload.id, newIdempotencyKey());
        if ('kind' in committed) throw new Error(t('Waiting for Chair computer to save the file'));
        setResolutionUploadPercent(95);
        await api.createDocumentVersion(document.id, {baseRevision: document.revision, title: versionTitle,
          content: '', contentFileEntryId: committed.id, ...represented});
        attached = true; setResolutionUploadPercent(100);
      });
    } finally {
      if (attached) setResolutionUpload(undefined);
      setResolutionUploadPercent(undefined);
    }
  };
  const presentSeatIds = new Set(snapshot.attendance.filter(item => item.state === 'PRESENT').map(item => item.seatId));
  const attachedFile = availableFiles.find(file => file.id === document.currentVersion.contentFile?.id);
  const seatOptions = snapshot.seats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName,
    disabled: !presentSeatIds.has(seat.id)}));
  const directVote = document.directVote;
  const directVotes = directVote?.votes ?? [];
  const directVoteBySeat = new Map(directVotes.map(vote => [vote.seatId, vote]));
  const directEligibility = directVote?.eligibility ?? [];
  const directTotalPages = Math.max(1, Math.ceil(directEligibility.length / 18));
  const directVotingPage = Math.min(votingPage, directTotalPages - 1);
  const visibleDirectSeats = directEligibility.slice(directVotingPage * 18, (directVotingPage + 1) * 18);
  const currentVotingSeat = directEligibility.find(item => item.seatId === currentVotingSeatId);
  const directCounts = {FOR: directVotes.filter(vote => vote.choice === 'FOR').length,
    AGAINST: directVotes.filter(vote => vote.choice === 'AGAINST').length,
    ABSTAIN: directVotes.filter(vote => vote.choice === 'ABSTAIN').length};
  const setDirectResolutionVote = async (choice: 'FOR' | 'AGAINST' | 'ABSTAIN' | null,
    targetSeatId = currentVotingSeatId, recordHistory = true) => {
    if (!canChair || !targetSeatId) return;
    const previousChoice = directVoteBySeat.get(targetSeatId)?.choice ?? null;
    if (previousChoice === choice) return;
    if (recordHistory) setVotingHistory(current => [...current, {seatId: targetSeatId, previousChoice}]);
    await run(() => api.setResolutionDirectVote(document.id, targetSeatId, choice));
    const index = directEligibility.findIndex(item => item.seatId === targetSeatId);
    const next = directEligibility.slice(index + 1).find(item => !directVoteBySeat.has(item.seatId));
    if (next) {
      setCurrentVotingSeatId(next.seatId); setVotingPage(Math.floor(directEligibility.indexOf(next) / 18));
    }
  };
  const undoDirectVote = async () => {
    const previous = votingHistory.at(-1); if (!previous) return;
    setVotingHistory(current => current.slice(0, -1));
    setCurrentVotingSeatId(previous.seatId);
    setVotingPage(Math.floor(Math.max(0, directEligibility.findIndex(item => item.seatId === previous.seatId)) / 18));
    await setDirectResolutionVote(previous.previousChoice, previous.seatId, false);
  };
  return <Container className="resolution-page" fluid style={{paddingBottom: '2em'}}><Grid columns="equal" stackable>
    <Grid.Row><Grid.Column><Input value={localizeGeneratedName(versionTitle)} loading={!document} labelPosition="right"
      label={<Label>{statusLabel(document.status)}</Label>} size="massive" fluid placeholder={t('Set resolution name')}
      disabled={!editable} onChange={event => setVersionTitle(event.currentTarget.value)} onBlur={() => void saveVersion()} /></Grid.Column></Grid.Row>
    <Grid.Row><Grid.Column width={activeTab === 'voting' ? 16 : 11}><Menu pointing secondary>
      {[['text', 'Text'], ['amendments', 'Amendments'], ['voting', 'Voting']].map(([path, label]) =>
        <Menu.Item key={path} as={Link} to={path === 'text' ? base : `${base}/${path}`}
          active={activeTab === path}>{t(label)}</Menu.Item>)}</Menu>
    {activeTab === 'text' && <><Button.Group basic compact className="resolution-content-source">
      <Button active={contentSource === 'TEXT'} onClick={() => setContentSource('TEXT')}>{t('Text')}</Button>
      <Button active={contentSource === 'FILE'} onClick={() => setContentSource('FILE')}>{t('File')}</Button>
    </Button.Group><Divider hidden />
    {contentSource === 'TEXT' ? <Form><TextArea value={versionContent} rows={3} placeholder={t('Resolution text')}
      disabled={!editable} onChange={(_, data) => setVersionContent(String(data.value))} onBlur={() => void saveVersion()} /></Form>
      : <Segment className="resolution-file-body">{fileError && <Message error content={fileError} />}
        {document.currentVersion.contentFile && <><Header as="h4">{document.currentVersion.contentFile.logicalName}</Header>
          <Label>{statusLabel(document.currentVersion.contentFile.status)}</Label>
          <Button as="a" href={api.fileDownloadUrl(document.currentVersion.contentFile.id)} download>
            {t('Download')}</Button>
          {editable && document.currentVersion.contentFile.status === 'UPLOAD_COMPLETE' && <Button
            disabled={!attachedFile}
            onClick={() => void run(() => api.submitFileForReview(document.currentVersion.contentFile!.id,
              attachedFile!.revision))}>
            {t('Submit for review')}</Button>}
          {canChair && document.currentVersion.contentFile.status === 'PENDING_REVIEW' && <Button primary
            disabled={!attachedFile}
            onClick={() => void run(() => api.publishFile(document.currentVersion.contentFile!.id,
              attachedFile!.revision))}>
            {t('Publish file')}</Button>}<Divider />
        </>}
        {editable && <Form onSubmit={() => void uploadResolutionFile()}>
          <Form.Input type="file" label={t('Choose file')} input={{'aria-label': t('Resolution file'),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setResolutionUpload(event.currentTarget.files?.[0])}} />
          <Button primary disabled={!resolutionUpload}>{t('Upload file')}</Button>
          {resolutionUploadPercent !== undefined && <Progress percent={resolutionUploadPercent} progress />}
          {availableFiles.length > 0 && <><Divider horizontal>{t('Existing file')}</Divider>
            <Form.Select search selection fluid value={selectedExistingFileId || false}
              options={availableFiles.map(file => ({key: file.id, value: file.id,
                text: `${file.logicalName} · ${statusLabel(file.status)}`}))}
              onChange={(_, data) => setSelectedExistingFileId(String(data.value))} />
            <Button type="button" disabled={!selectedExistingFileId}
              onClick={() => void attachExistingFile()}>{t('Attach file')}</Button></>}
        </Form>}</Segment>}</>}
    {activeTab === 'amendments' && <Card.Group itemsPerRow={1}>
      {canParticipate && session && ['PUBLISHED', 'POSTPONED'].includes(document.status) && <Card><Button icon="plus"
        primary fluid basic aria-label={t('Create amendment')} onClick={() => void run(() => api.createAmendment(document.id,
          {meetingSessionId: session.id, title: '', content: '', ...represented}))} /></Card>}
      {[...amendments].reverse().map(amendment => <AmendmentCard key={amendment.id} snapshot={snapshot}
        amendment={amendment} run={run} api={api} canChair={canChair} representedSeatId={seatId}
        seatOptions={seatOptions} />)}
    </Card.Group>}
    {activeTab === 'voting' && <>{directVote && <Segment className="resolution-voting-board">
      <div className="resolution-voting-dashboard"><aside className="resolution-voting-metrics resolution-voting-thresholds">
        <div className="resolution-voting-metric metric-present"><span>{t('Present')}</span><strong>{directEligibility.length}</strong></div>
        <div className="resolution-voting-metric metric-simple"><span>{t('Simple majority')}</span>
          <strong>{Math.floor(directEligibility.length / 2) + 1}</strong></div>
        <div className="resolution-voting-metric metric-two-thirds"><span>{t('Two-thirds majority')}</span>
          <strong>{Math.ceil(directEligibility.length * 2 / 3)}</strong></div>
      </aside><div className="resolution-voting-matrix-wrap"><div className="resolution-voting-grid">
        {visibleDirectSeats.map(item => {const vote = directVoteBySeat.get(item.seatId); return <button type="button" key={item.seatId}
          className={`resolution-voting-member${vote ? ` vote-${vote.choice === 'ABSTAIN' ? 'abstaining' : vote.choice.toLowerCase()}` : ''}${item.seatId === currentVotingSeatId ? ' is-current' : ''}`}
          aria-pressed={item.seatId === currentVotingSeatId} onClick={() => canChair && setCurrentVotingSeatId(item.seatId)}>
          <span className="resolution-voting-status-light" aria-hidden="true" />
          <span className="resolution-voting-member-name">{item.seatDisplayName}</span>
        </button>;})}</div>{directTotalPages > 1 && <Pagination className="resolution-voting-pagination"
          activePage={directVotingPage + 1} totalPages={directTotalPages} boundaryRange={1} siblingRange={1} ellipsisItem={null}
          onPageChange={(_, data) => setVotingPage(Number(data.activePage) - 1)} />}</div>
        <aside className="resolution-voting-metrics resolution-vote-counts">
          <div className="resolution-voting-metric metric-for"><span>{t('yes')}</span><strong>{directCounts.FOR}</strong></div>
          <div className="resolution-voting-metric metric-against"><span>{t('no')}</span><strong>{directCounts.AGAINST}</strong></div>
          <div className="resolution-voting-metric metric-abstaining"><span>{t('abstaining')}</span><strong>{directCounts.ABSTAIN}</strong></div>
        </aside></div>
      <div className="resolution-voting-current"><div className="resolution-voting-current-label">{t('Now voting')}</div>
        <Header as="h2">{currentVotingSeat?.seatDisplayName ?? t('No eligible delegations')}</Header>
        {canChair && <div className="resolution-voting-actions"><div className="resolution-voting-primary-actions">
          <Button positive content={t('yes')} icon="plus" disabled={!currentVotingSeat}
            onClick={() => void setDirectResolutionVote('FOR')} />
          <Button negative content={t('no')} icon="remove" disabled={!currentVotingSeat}
            onClick={() => void setDirectResolutionVote('AGAINST')} />
          <Button color="yellow" content={t('abstaining')} icon="minus"
            disabled={!currentVotingSeat || currentVotingSeat.mustVote} onClick={() => void setDirectResolutionVote('ABSTAIN')} />
        </div><Button basic className="resolution-voting-undo" content={t('Undo')} icon="undo"
          disabled={votingHistory.length === 0} onClick={() => void undoDirectVote()} /></div>}
      </div><div className="resolution-voting-outcome">
        {directVote.automaticResult === 'PASSED' && <Statistic className="resolution-result outcome-passed">
          <Statistic.Value>{t('Passed')}</Statistic.Value></Statistic>}
        {directVote.automaticResult === 'FAILED' && <Statistic className="resolution-result outcome-failed">
          <Statistic.Value>{t('Failed')}</Statistic.Value></Statistic>}
        {directVote.automaticResult === 'VETOED' && <Statistic className="resolution-result outcome-vetoed">
          <Statistic.Value>{t('Vetoed')}</Statistic.Value></Statistic>}
      </div>{canChair && <Segment secondary textAlign="center"><Select value={directVote.majority}
        options={[{key: 'simple', value: 'SIMPLE_MAJORITY', text: t('Simple (50%) majority required')},
          {key: 'two-thirds', value: 'TWO_THIRDS', text: t('Two-thirds majority required')},
          {key: 'two-thirds-no-abstain', value: 'TWO_THIRDS_NON_ABSTAINING', text: t('Two-thirds majority required, ignoring abstentions')}]}
        onChange={(_, data) => void run(() => api.updateDocumentSettings(document.id,
          {baseRevision: document.revision, majority: data.value as 'SIMPLE_MAJORITY' | 'TWO_THIRDS' | 'TWO_THIRDS_NON_ABSTAINING'}))} />
      </Segment>}</Segment>}{snapshot.committee.operationMode !== 'CHAIR_OPERATED' && <>
        <Divider horizontal>{t('Formal ballot')}</Divider>
        <Ballots snapshot={snapshot} run={run} api={api} canChair={canChair} subjectId={document.id} />
        {canChair && document.status === 'VOTING' && session && <Button onClick={() => void run(() => api.createBallot(snapshot.committee.id,
          {meetingSessionId: session.id, subjectType: 'RESOLUTION', subjectId: document.id, procedural: false,
            thresholdKind: 'TWO_THIRDS'}))}>{t('Open formal ballot')}</Button>}</>}</>}</Grid.Column>
    {activeTab !== 'voting' && <Grid.Column width={5}><Segment><Form>
      {canChair && <Form.Dropdown label={t('Resolution proposer')} search selection fluid value={document.proposerSeatId ?? false}
        options={seatOptions} onChange={(_, data) => void run(() => api.updateDocumentSettings(document.id,
          {baseRevision: document.revision, proposerSeatId: String(data.value)}))} />}
      {canChair && <Form.Dropdown label={t('Resolution seconder')} search selection clearable fluid value={document.seconderSeatId ?? false}
        options={seatOptions.filter(option => option.value !== document.proposerSeatId)}
        onChange={(_, data) => void run(() => api.updateDocumentSettings(document.id,
          {baseRevision: document.revision, seconderSeatId: data.value ? String(data.value) : null}))} />}
      {canChair && <Form.Checkbox label={t('Delegates can amend')} toggle checked={document.delegatesCanAmend}
        onChange={(_, data) => void run(() => api.updateDocumentSettings(document.id,
          {baseRevision: document.revision, delegatesCanAmend: data.checked ?? false}))} />}
    </Form></Segment></Grid.Column>}
  </Grid.Row></Grid></Container>;
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

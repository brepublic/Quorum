import * as React from 'react';
import {
  Button,
  Container,
  Dropdown,
  DropdownProps,
  Feed,
  FeedEvent,
  Form,
  Grid,
  Header,
  Icon,
  Input,
  Label,
  Message,
  Popup,
  Segment,
  TextArea
} from 'semantic-ui-react';
import Timer, {getTimeWithSkewCorrection} from '../components/Timer';
import {RouteComponentProps} from 'react-router';
import {
  checkboxHandler,
  dropdownHandler,
  fieldHandler,
  textAreaHandler,
  validatedNumberFieldHandler
} from '../modules/handlers';
import {URLParameters} from '../types';
import {NotFound} from '../components/NotFound';
import {
  CAUCUS_STATUS_OPTIONS,
  canAdvanceSpeaker,
  canOfferSpeakerYield,
  CaucusData,
  CaucusID,
  CaucusStatus,
  DEFAULT_CAUCUS,
  formatCaucusLogTime,
  isGeneralSpeakersList,
  Lifecycle,
  recoverDuration,
  recoverUnit,
  runLifecycle,
  speakerCompletionLog,
  speakerStartLog,
  SpeechKind,
  shouldAutoCloseCaucus,
  shouldPauseCaucusTimerAfterSpeakerEnds,
  SpeakerEvent,
  Stance,
  YieldType
} from "../models/caucus";
import {CommitteeData, recoverCaucus, recoverMembers, recoverSettings} from "../models/committee";
import {TimerData, Unit} from "../models/time";
import {useAuthState} from "react-firebase-hooks/auth";
import _ from "lodash";
import {displayMemberName, isMemberPresent, localizedMemberOptions, memberByName, MemberData, MemberFlag, MemberOption, membersToAttendanceOptions, nameToCountryOption} from "../modules/member";
import {TimeSetter} from "../components/TimeSetter";
import firebase from "firebase/compat/app";
import {DragDropContext, Draggable, DraggableProvided, Droppable, DropResult} from "react-beautiful-dnd";
import { Helmet } from 'react-helmet';
import { localizeGeneratedName, t } from '../i18n';

interface Props extends RouteComponentProps<URLParameters> {
}

interface State {
  speakerTimer: TimerData;
  caucusTimer: TimerData;
  committee?: CommitteeData;
  committeeFref: firebase.database.Reference;
  loading: boolean;
  yieldMode?: YieldType;
  yieldTargetID?: string;
  yieldNotice?: string;
}

const isSpeakerPresent = (
  members: Record<string, MemberData> | undefined,
  speaker: SpeakerEvent | undefined
) => !!speaker && (speaker.memberID
  ? !!members?.[speaker.memberID]?.present
  : isMemberPresent(members, speaker.who));

const caucusLogMemberName = (name: string): string => {
  const country = nameToCountryOption(name);
  if (!country || typeof Intl.DisplayNames !== 'function') {
    return name;
  }
  try {
    return new Intl.DisplayNames(['zh-CN'], {type: 'region'})
      .of(country.value.toUpperCase()) ?? name;
  } catch {
    return name;
  }
};

export function NextSpeaking(props: {
  caucus?: CaucusData;
  members?: Record<string, MemberData>;
  speakerTimer: TimerData;
  fref: firebase.database.Reference;
  autoNextSpeaker: boolean;
  caucusID: CaucusID;
  onNextSpeaker: () => void;
  toggleTimers: (skew?: number) => void;
  yieldDecisionActive: boolean;
}) {
  // TODO: Bandaid - I don't think the hook types nicely with the compat patch
  const [user] = useAuthState(firebase.auth() as any);

  const handleKeyDown = (ev: KeyboardEvent) => {
    // if changing this, update Help
    if (ev.keyCode === 78 && ev.altKey) {
      props.onNextSpeaker();
    }
  };

  const interlace = () => {
    if (!props.caucus) {
      return;
    }

    if (!user) {
      return;
    }

    const q = props.caucus.queue || {};

    const vs: SpeakerEvent[] = _.values(q)
      .filter(speaker => isSpeakerPresent(props.members, speaker));

    const fors = vs.filter((se) => se.stance === Stance.For);
    const againsts = vs.filter((se) => se.stance === Stance.Against);
    const neutrals = vs.filter((se) => se.stance === Stance.Neutral);

    const interlaced = _.flatten(_.zip(fors, againsts, neutrals));

    props.fref.child('queue').set({});

    interlaced.forEach((se: SpeakerEvent | undefined) => {
      if (se) {
        props.fref.child('queue').push().set(se);
      }
    });
  };

  const startTimer = () => {
    props.toggleTimers();
  };

  const {caucus} = props;
  const {ticking} = props.speakerTimer;

  const queue = caucus ? caucus.queue : {};
  const hasNowSpeaking = caucus ? !!caucus.speaking : false;
  const currentSpeakerPresent = isSpeakerPresent(props.members, caucus?.speaking);
  const queueLength = _.values(queue)
    .filter(speaker => isSpeakerPresent(props.members, speaker)).length;
  const hasNextSpeaking = queueLength > 0;
  const interlaceable = queueLength > 1;
  const nextable = hasNowSpeaking || hasNextSpeaking;
  const speakersList = isGeneralSpeakersList(props.caucusID);
  const hasStarted = !!caucus?.speaking?.started
    || !!caucus?.speaking?.isYieldedTime
    || props.speakerTimer.elapsed > 0
    || !!props.speakerTimer.ticking;

  const stageButton = (
    <Button
      basic
      icon
      primary
      disabled={!nextable}
      onClick={props.onNextSpeaker}
    >
      <Icon name="arrow up"/>
      {t('Stage')}
    </Button>
  );

  const startButton = (
    <Button
      basic
      icon
      positive
      disabled={!nextable}
      onClick={startTimer}
    >
      <Icon name="hourglass start"/>
      {t('Start')}
    </Button>
  )

  const nextButton = (
    <Button
      basic
      icon
      primary
      disabled={!nextable || (speakersList && (!!ticking || props.yieldDecisionActive))}
      onClick={props.onNextSpeaker}
    >
      <Icon name="arrow up"/>
      {t('Next')}
    </Button>
  );

  const stopButton = (
    <Button
      basic
      icon
      negative
      disabled={!nextable}
      onClick={props.onNextSpeaker}
    >
      <Icon name="hourglass end"/>
      {t('Stop')}
    </Button>
  );

  const pauseContinueButton = (
    <Button
      basic
      icon
      color={ticking ? 'orange' : 'green'}
      disabled={props.yieldDecisionActive || (!ticking && props.speakerTimer.remaining === 0)}
      onClick={startTimer}
    >
      <Icon name={ticking ? 'pause' : 'play'} />
      {t(ticking ? 'Pause' : 'Continue')}
    </Button>
  );

  const speakersListControls = (
    <Button.Group>
      {pauseContinueButton}
      {nextButton}
    </Button.Group>
  );

  const interlaceButton = (
    <Button
      icon
      disabled={!interlaceable}
      basic
      color="purple"
      onClick={interlace}
    >
      <Icon name="random"/>
      {t('Order')}
    </Button>
  );

  let button = nextButton;

  if (!hasNowSpeaking) {
    button = stageButton;
  } else if (hasNowSpeaking && !currentSpeakerPresent) {
    button = hasNextSpeaking ? nextButton : stopButton;
  } else if (speakersList && hasNowSpeaking && hasStarted) {
    button = speakersListControls;
  } else if (hasNowSpeaking && !ticking) {
    button = startButton;
  } else if (hasNowSpeaking && ticking && hasNextSpeaking) {
    button = nextButton;
  } else if (hasNowSpeaking && ticking && !hasNextSpeaking) {
    button = stopButton;
  }

  React.useEffect(() => {
    document.addEventListener<'keydown'>('keydown', handleKeyDown);

    return () => document.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <Segment textAlign="center" loading={!caucus}>
      <Label attached="top left" size="large">{t('Next speaking')}</Label>
      {button}
      <Popup
        trigger={interlaceButton}
        content={t("Orders the list so that speakers are 'For', then 'Against', then 'Neutral', then 'For', etc.")}
      />
      <SpeakerFeed
        data={caucus ? caucus.queue : undefined}
        members={props.members}
        queueFref={props.fref.child('queue')}
        speaking={caucus ? caucus.speaking : undefined}
        speakerTimer={props.speakerTimer}
        allowLegacyYield={!speakersList}
      />
    </Segment>
  );
}

function StanceIcon(props: { stance: Stance }) {
  switch (props.stance) {
    case Stance.For:
      return <Icon name="thumbs up outline"/>;
    case Stance.Against:
      return <Icon name="thumbs down outline"/>;
    default:
      return <Icon name="hand point right outline"/>;
  }
}

class SpeakerFeedEntry extends React.PureComponent<{
  data?: SpeakerEvent,
  members?: Record<string, MemberData>,
  speaking?: SpeakerEvent,
  fref: firebase.database.Reference,
  speakerTimer: TimerData,
  allowLegacyYield?: boolean,
  draggableProvided?: DraggableProvided
}> {

  yieldHandler = () => {
    const {fref, data, speakerTimer, speaking} = this.props;

    const queueHeadDetails = {
      queueHeadData: data,
      queueHead: fref
    };

    // HACK
    // HERE BE DRAGONS
    // The only reason I'm doing this is because I honestly couldn't give a shit about propogating
    // the caucusRef all the way down. Furthermore, the only time this should ever be called is when the
    // SpeakerEvent is in the "queue" zone, meaning we'll pop up into the "caucus" field.
    const caucusRef = (fref.parent as firebase.database.Reference).parent as firebase.database.Reference;

    const lifecycle: Lifecycle = {
      history: caucusRef.child('history'),
      speaking: caucusRef.child('speaking'),
      speakingData: speaking,
      timerData: speakerTimer,
      timer: caucusRef.child('speakerTimer'),
      yielding: true,
      timerResetSeconds: 0 // this shouldn't ever be used when yielding
    };

    runLifecycle({...lifecycle, ...queueHeadDetails});
  };

  renderContent() {
    const {data, speaking, fref} = this.props;
    const absent = !!data && !isSpeakerPresent(this.props.members, data);

    return (
      <Feed.Content>
        <Feed.Summary>
          <Feed.User>
            {data && <MemberFlag member={memberByName(this.props.members, data.who)} />}
            {data ? displayMemberName(data.who) : ''}
            {absent && <Label size="mini">{t('Absent')}</Label>}
          </Feed.User>
          <Feed.Date>{data ? `${data.duration} ${t('seconds')}` : ''}</Feed.Date>
        </Feed.Summary>
        <Feed.Meta>
          <Feed.Like>
            {data && <StanceIcon stance={data.stance}/>}
            {data ? t(data.stance) : ''}
          </Feed.Like>
          {data && <Label size="mini" as="a" onClick={() => fref.remove()}>
              {t('Remove')}
          </Label>}
          {this.props.allowLegacyYield && data && speaking && !absent && (<Label size="mini" as="a" onClick={this.yieldHandler}>
            {t('Yield')}
          </Label>)}
        </Feed.Meta>
      </Feed.Content>
    )
  }

  render() {
    const {draggableProvided} = this.props;
    const absent = !!this.props.data && !isSpeakerPresent(this.props.members, this.props.data);

    return draggableProvided ? (
      <div
        className={`event${absent ? ' absent-member' : ''}`} // XXX: quite possibly the most bullshit hack known to man
        ref={draggableProvided.innerRef}
        {...draggableProvided.draggableProps}>
        {this.renderContent()}
        <div {...draggableProvided.dragHandleProps}
             style={{paddingLeft: '120px'}
             }> ⠿
        </div>
      </div>
    ) : <FeedEvent className={absent ? 'absent-member' : undefined}>
      {this.renderContent()}
    </FeedEvent>
  }
}

function SpeakerFeed(props: {
  data?: Record<string, SpeakerEvent>,
  members?: Record<string, MemberData>,
  queueFref: firebase.database.Reference,
  speaking?: SpeakerEvent,
  speakerTimer: TimerData,
  allowLegacyYield: boolean
}) {
  const {allowLegacyYield, data, members, queueFref, speaking, speakerTimer} = props;
  // TODO: Bandaid - I don't think the hook types nicely with the compat patch
  const [user] = useAuthState(firebase.auth() as any);

  const events = data || {};

  const eventItems = Object.keys(events).map((key, index) =>
    (
      <Draggable key={key} draggableId={key} index={index}>
        {(provided, snapshot) =>
          <SpeakerFeedEntry
            draggableProvided={provided}
            key={key}
            data={events[key]}
            members={members}
            fref={queueFref.child(key)}
            speaking={speaking}
            speakerTimer={speakerTimer}
            allowLegacyYield={allowLegacyYield}
          />
        }
      </Draggable>
    )
  );

  const reorder = <T,>(list: T[], startIndex: number, endIndex: number) => {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);

    return result;
  }

  const onDragEnd = (result: DropResult) => {
    // dropped outside the list
    if (!result.destination) {
      return;
    }

    // no auth
    if (!user) {
      return;
    }

    const events = data || {};

    const reorderedKeys = reorder(
      Object.keys(events),
      result.source.index,
      result.destination.index
    );

    queueFref.set({});

    reorderedKeys.forEach(key => {
      const se = (data || {})[key]

      if (se) {
        queueFref.push().set(se);
      }
    });
  }

  return (
    <DragDropContext
      onDragEnd={onDragEnd}
    >
      <Droppable droppableId="droppable">
        {(provided, snapshot) =>
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
          >
            <Feed
              size="large"
            >
              {eventItems}
              {provided.placeholder}
            </Feed>
          </div>
        }
      </Droppable>
    </DragDropContext>
  );
};

function YieldCard(props: {
  mode?: YieldType;
  targetID?: string;
  options: MemberOption[];
  onChooseMode: (mode: YieldType) => void;
  onChooseTarget: (memberID: string) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const modeLabel = props.mode === YieldType.Question
    ? 'Ask a question'
    : props.mode === YieldType.Comment
      ? 'Comment'
      : 'Yield';

  const setTarget = (_event: React.SyntheticEvent<HTMLElement>, data: DropdownProps) => {
    props.onChooseTarget(String(data.value));
  };

  return (
    <Segment raised textAlign="center">
      <Label attached="top left" size="large">{t('Yield')}</Label>
      {!props.mode ? (
        <Button.Group vertical fluid>
          <Button onClick={() => props.onChooseMode(YieldType.Chair)}>{t('Yield to the chair')}</Button>
          <Button onClick={() => props.onChooseMode(YieldType.Delegate)}>{t('Yield to another delegate')}</Button>
          <Button onClick={() => props.onChooseMode(YieldType.Question)}>{t('Yield to questions')}</Button>
          <Button onClick={() => props.onChooseMode(YieldType.Comment)}>{t('Yield to comments')}</Button>
        </Button.Group>
      ) : (
        <Form>
          <Header size="small">{t(modeLabel)}</Header>
          <Form.Dropdown
            icon="search"
            search
            selection
            value={props.targetID}
            placeholder={t('Select a delegation')}
            onChange={setTarget}
            options={localizedMemberOptions(props.options)}
          />
          {props.mode === YieldType.Delegate && props.targetID && (
            <Button.Group fluid>
              <Button positive onClick={props.onAccept}>{t('Accept')}</Button>
              <Button negative onClick={props.onReject}>{t('Reject')}</Button>
            </Button.Group>
          )}
        </Form>
      )}
    </Segment>
  );
}

function Queuer(props: {
  caucus?: CaucusData;
  members?: Record<string, MemberData>;
  caucusFref: firebase.database.Reference;
}) {
  const {members, caucus, caucusFref} = props;
  const [queueMember, setQueueMember] = React.useState<MemberOption | undefined>(undefined);
  const memberOptions = membersToAttendanceOptions(members);

  const setStance = (stance: Stance) => () => {
    const {caucus} = props;

    const duration = Number(recoverDuration(caucus));

    if (duration && queueMember && !queueMember.disabled && queueMember.memberID) {
      const newEvent: SpeakerEvent = {
        who: queueMember.text,
        memberID: queueMember.memberID,
        stance: stance,
        duration: recoverUnit(caucus) === Unit.Minutes ? duration * 60 : duration,
      };

      props.caucusFref.child('queue').push().set(newEvent);
    }
  }

  const setMember = (event: React.SyntheticEvent<HTMLElement>, data: DropdownProps): void => {
    const selected = memberOptions.find(c => c.value === data.value);
    if (selected && !selected.disabled) {
      setQueueMember(selected);
    }
  }

  const duration = recoverDuration(caucus);
  const disableButtons = !queueMember || queueMember.disabled || !duration;

  return (
    <Segment textAlign="center">
      <Label attached="top left" size="large">{t('Queue')}</Label>
      <Form>
        <Form.Dropdown
          icon="search"
          value={queueMember ? queueMember.value : undefined}
          search
          selection
          loading={!caucus}
          error={!queueMember}
          onChange={setMember}
          options={localizedMemberOptions(memberOptions)}
        />
        <TimeSetter
          loading={!caucus}
          unitValue={recoverUnit(caucus)}
          placeholder={t('Speaking time')}
          durationValue={duration ? duration.toString() : undefined}
          onDurationChange={validatedNumberFieldHandler(caucusFref, 'speakerDuration')}
          onUnitChange={dropdownHandler(caucusFref, 'speakerUnit')}
        />
        <Form.Checkbox
          label={t('Delegates can queue')}
          indeterminate={!caucus}
          toggle
          checked={caucus ? caucus.queueIsPublic : false}
          onChange={checkboxHandler<CaucusData>(caucusFref, 'queueIsPublic')}
        />
        <Button.Group size="large" fluid>
          <Button
            content={t('For')}
            disabled={disableButtons}
            onClick={setStance(Stance.For)}
          />
          <Button.Or text={t('or')} />
          <Button
            disabled={disableButtons}
            content={t('Neutral')}
            onClick={setStance(Stance.Neutral)}
          />
          <Button.Or text={t('or')} />
          <Button
            disabled={disableButtons}
            content={t('Against')}
            onClick={setStance(Stance.Against)}
          />
        </Button.Group>
      </Form>
    </Segment>
  );
}

export default class Caucus extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    const { match } = props;

    this.state = {
      committeeFref: firebase.database().ref('committees').child(match.params.committeeID),
      caucusTimer: DEFAULT_CAUCUS.caucusTimer,
      speakerTimer: DEFAULT_CAUCUS.speakerTimer,
      loading: true
    };
  }

  firebaseCallback = (committee: firebase.database.DataSnapshot | null) => {
    if (committee) {
      this.setState({ committee: committee.val(), loading: false });
    }
  }

  // XXX: I'm worried that this might be the source of a bug that I'm yet to observe
  // Say our route changes the committeeID, _but does not unmount the caucus component_
  // Will these listeners be purged?
  componentDidMount() {
    this.state.committeeFref.on('value', this.firebaseCallback);
  }

  componentWillUnmount() {
    this.state.committeeFref.off('value', this.firebaseCallback);
  }

  recoverCaucusFref = () => {
    const caucusID: CaucusID = this.props.match.params.caucusID;

    return this.state.committeeFref
      .child('caucuses')
      .child(caucusID);
  }

  appendLogs = (messages: string[]) => {
    const logsRef = this.recoverCaucusFref().child('logs');
    messages.forEach(message => {
      logsRef.push().set({
        message,
        createdAt: firebase.database.ServerValue.TIMESTAMP
      });
    });
  }

  currentSpeakerName = (speaker: SpeakerEvent) => caucusLogMemberName(speaker.who);

  advanceSpeaker = ({
    additionalLogs = [],
    force = false,
    logCompletion = true
  }: {
    additionalLogs?: string[];
    force?: boolean;
    logCompletion?: boolean;
  } = {}) => {
    const {caucusTimer, committee, speakerTimer} = this.state;
    const caucusID = this.props.match.params.caucusID;
    const caucus = recoverCaucus(committee, caucusID);

    if (!caucus || (!canAdvanceSpeaker(caucusID, speakerTimer) && !force)) {
      return;
    }

    const q = caucus.queue || {};
    const members = recoverMembers(committee);
    const queueHeadKey = Object.keys(q).find(key => isSpeakerPresent(members, q[key]));
    const duration = recoverDuration(caucus);
    const speakerSeconds = duration
      ? duration * (recoverUnit(caucus) === Unit.Minutes ? 60 : 1)
      : 60;
    const lifecycle: Lifecycle = {
      history: this.recoverCaucusFref().child('history'),
      speakingData: caucus.speaking,
      speaking: this.recoverCaucusFref().child('speaking'),
      timerData: speakerTimer,
      timer: this.recoverCaucusFref().child('speakerTimer'),
      yielding: false,
      timerResetSeconds: speakerSeconds,
      ...(queueHeadKey ? {
        queueHeadData: q[queueHeadKey],
        queueHead: this.recoverCaucusFref().child('queue').child(queueHeadKey)
      } : {})
    };

    if (isGeneralSpeakersList(caucusID) && caucus.speaking) {
      const messages = logCompletion
        ? [speakerCompletionLog(
          caucus.speaking,
          this.currentSpeakerName(caucus.speaking),
          speakerTimer.remaining
        ), ...additionalLogs]
        : additionalLogs;
      this.appendLogs(messages);
    }

    if (!isGeneralSpeakersList(caucusID) && caucus.speaking) {
      this.recoverCaucusFref().child('caucusTimer').set({...caucusTimer, ticking: false});
      if (shouldAutoCloseCaucus(caucusID, caucusTimer, speakerSeconds)) {
        runLifecycle(lifecycle);
        this.recoverCaucusFref().child('status').set(CaucusStatus.Closed);
        return;
      }
    }

    runLifecycle(lifecycle);
    this.setState({yieldMode: undefined, yieldTargetID: undefined});
  }

  replaceCurrentSpeaker = (
    target: MemberOption,
    speechKind: SpeechKind,
    messages: string[],
    notice: string
  ) => {
    const caucusID = this.props.match.params.caucusID;
    const caucus = recoverCaucus(this.state.committee, caucusID);
    const source = caucus?.speaking;
    if (!source || !target.memberID) {
      return;
    }

    const historyKey = this.recoverCaucusFref().child('history').push().key;
    const updates: Record<string, unknown> = {
      speaking: {
        who: target.text,
        memberID: target.memberID,
        stance: Stance.Neutral,
        duration: this.state.speakerTimer.remaining,
        started: false,
        isYieldedTime: true,
        speechKind
      },
      speakerTimer: {
        elapsed: 0,
        remaining: this.state.speakerTimer.remaining,
        ticking: false
      }
    };

    if (historyKey) {
      updates[`history/${historyKey}`] = {...source, duration: this.state.speakerTimer.elapsed};
    }
    Object.entries(caucus?.queue || {}).forEach(([key, queued]) => {
      if (queued.memberID === target.memberID) {
        updates[`queue/${key}`] = null;
      }
    });

    this.appendLogs([
      speakerCompletionLog(source, this.currentSpeakerName(source), this.state.speakerTimer.remaining),
      ...messages
    ]);
    this.recoverCaucusFref().update(updates);
    this.setState({
      yieldMode: undefined,
      yieldTargetID: undefined,
      yieldNotice: notice
    });
  }

  chooseYieldMode = (mode: YieldType) => {
    const caucus = recoverCaucus(this.state.committee, this.props.match.params.caucusID);
    const source = caucus?.speaking;
    if (!source || source.isYieldedTime || this.state.speakerTimer.ticking || this.state.speakerTimer.remaining <= 1) {
      return;
    }

    if (mode === YieldType.Chair) {
      const sourceName = this.currentSpeakerName(source);
      this.advanceSpeaker({
        additionalLogs: [`${sourceName} 代表选择让渡给主席。`],
        force: true
      });
      this.setState({yieldNotice: t('The remaining time was yielded to the chair. The next delegate may prepare to speak.')});
      return;
    }

    this.setState({yieldMode: mode, yieldTargetID: undefined, yieldNotice: undefined});
  }

  yieldOptions = (): MemberOption[] => {
    const caucus = recoverCaucus(this.state.committee, this.props.match.params.caucusID);
    return membersToAttendanceOptions(recoverMembers(this.state.committee))
      .filter(option => option.memberID !== caucus?.speaking?.memberID && option.text !== caucus?.speaking?.who);
  }

  chooseYieldTarget = (targetValue: string) => {
    const target = this.yieldOptions().find(option => option.value === targetValue && !option.disabled);
    const caucus = recoverCaucus(this.state.committee, this.props.match.params.caucusID);
    const source = caucus?.speaking;
    const mode = this.state.yieldMode;
    if (!target || !source || !mode) {
      return;
    }

    if (mode === YieldType.Delegate) {
      this.setState({yieldTargetID: targetValue});
      return;
    }

    const sourceName = this.currentSpeakerName(source);
    const targetName = caucusLogMemberName(target.text);
    const targetDisplayName = displayMemberName(target.text);
    if (mode === YieldType.Comment) {
      this.replaceCurrentSpeaker(
        target,
        SpeechKind.Comment,
        [`${sourceName} 代表让渡给评论。由 ${targetName} 代表评论。`],
        t('{name} will use the remaining time to comment.', {name: targetDisplayName})
      );
      return;
    }

    const historyKey = this.recoverCaucusFref().child('history').push().key;
    const updates: Record<string, unknown> = {
      speaking: {
        ...source,
        duration: this.state.speakerTimer.remaining,
        started: false,
        isYieldedTime: true,
        speechKind: SpeechKind.Answer
      },
      speakerTimer: {
        elapsed: 0,
        remaining: this.state.speakerTimer.remaining,
        ticking: false
      }
    };
    if (historyKey) {
      updates[`history/${historyKey}`] = {...source, duration: this.state.speakerTimer.elapsed};
    }
    this.appendLogs([
      speakerCompletionLog(source, sourceName, this.state.speakerTimer.remaining),
      `${sourceName} 代表让渡给问题。由 ${targetName} 代表提问。`
    ]);
    this.recoverCaucusFref().update(updates);
    this.setState({
      yieldMode: undefined,
      yieldTargetID: undefined,
      yieldNotice: t('{name} may ask a question. The chair may continue the timer when the answer begins.', {name: targetDisplayName})
    });
  }

  acceptDelegateYield = () => {
    const target = this.yieldOptions().find(
      option => option.value === this.state.yieldTargetID && !option.disabled
    );
    const caucus = recoverCaucus(this.state.committee, this.props.match.params.caucusID);
    const source = caucus?.speaking;
    if (!target || !source) {
      return;
    }
    const sourceName = this.currentSpeakerName(source);
    const targetName = caucusLogMemberName(target.text);
    const targetDisplayName = displayMemberName(target.text);
    this.replaceCurrentSpeaker(
      target,
      SpeechKind.Speech,
      [
        `${sourceName} 代表选择让渡给 ${targetName} 代表。`,
        `${targetName} 代表接受此让渡。`
      ],
      t('{name} accepted the yield and inherited the remaining time.', {name: targetDisplayName})
    );
  }

  rejectDelegateYield = () => {
    const target = this.yieldOptions().find(option => option.value === this.state.yieldTargetID);
    const caucus = recoverCaucus(this.state.committee, this.props.match.params.caucusID);
    const source = caucus?.speaking;
    if (!target || !source) {
      return;
    }
    const sourceName = this.currentSpeakerName(source);
    const targetName = caucusLogMemberName(target.text);
    const targetDisplayName = displayMemberName(target.text);
    this.advanceSpeaker({
      additionalLogs: [
        `${sourceName} 代表选择让渡给 ${targetName} 代表。`,
        `${targetName} 代表拒绝此让渡。剩余时间由主席收回。`
      ],
      force: true
    });
    this.setState({
      yieldNotice: t('{name} rejected the yield. The chair reclaimed the remaining time.', {name: targetDisplayName})
    });
  }

  renderHeader = (caucus?: CaucusData) => {
    const caucusFref = this.recoverCaucusFref();
    const speakersList = isGeneralSpeakersList(this.props.match.params.caucusID);

    const statusDropdown = (
      <Dropdown 
        value={caucus ? caucus.status : CaucusStatus.Open} 
        options={CAUCUS_STATUS_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
        onChange={dropdownHandler<CaucusData>(caucusFref, 'status')} 
      /> 
    );

    return (
      <>
        <Input
          label={statusDropdown}
          labelPosition="right"
          value={caucus ? localizeGeneratedName(caucus.name) : ''}
          onChange={fieldHandler<CaucusData>(caucusFref, 'name')}
          loading={!caucus}
          attatched="top"
          size="massive"
          fluid
          placeholder={t(speakersList ? 'Set speakers list name' : 'Set caucus name')}
        />
        <Form loading={!caucus}>
          <TextArea
            value={caucus ? caucus.topic : ''}
            autoHeight
            onChange={textAreaHandler<CaucusData>(caucusFref, 'topic')}
            attatched="top"
            rows={1}
            placeholder={t(speakersList ? 'Set speakers list details' : 'Set caucus details')}
          />
        </Form>
      </>
    );
  }

  renderNowSpeaking =  (caucus?: CaucusData, members?: Record<string, MemberData>) => {
    const { speakerTimer } = this.state;
    
    const caucusFref = this.recoverCaucusFref();

    const entryData = caucus ? caucus.speaking : undefined;

    return (
      <Segment loading={!caucus}>
        <Label attached="top left" size="large">{t('Now speaking')}</Label>
        <Feed size="large">
          <SpeakerFeedEntry data={entryData} members={members} fref={caucusFref.child('speaking')} speakerTimer={speakerTimer}/>
        </Feed>
      </Segment>
    );
  }

  setSpeakerTimer = (timer: TimerData) => {
    const caucusID = this.props.match.params.caucusID;

    if (shouldPauseCaucusTimerAfterSpeakerEnds(caucusID, timer, this.state.caucusTimer)) {
      this.recoverCaucusFref().child('caucusTimer').set({
        ...this.state.caucusTimer,
        ticking: false
      });
    }

    this.setState({ speakerTimer: timer });
  }

  setCaucusTimer = (timer: TimerData) => {
    this.setState({ caucusTimer: timer });
  }

  toggleTimers = (skew?: number) => {
    const {caucusTimer, committee, speakerTimer} = this.state;
    const caucusID: CaucusID = this.props.match.params.caucusID;
    const caucus = recoverCaucus(committee, caucusID);
    const speakersList = isGeneralSpeakersList(caucusID);

    if (!caucus || caucus.status === CaucusStatus.Closed) {
      return;
    }

    const timersAreRunning = !!speakerTimer.ticking || (!speakersList && !!caucusTimer.ticking);

    if (speakersList && this.state.yieldMode) {
      return;
    }

    if (speakersList && !timersAreRunning && speakerTimer.remaining === 0) {
      return;
    }

    if (!timersAreRunning) {
      const members = recoverMembers(committee);
      if (!isSpeakerPresent(members, caucus.speaking)) {
        return;
      }

      const speakerSeconds = recoverDuration(caucus)
        ? Number(recoverDuration(caucus)) * (recoverUnit(caucus) === Unit.Minutes ? 60 : 1)
        : 60;

      if (shouldAutoCloseCaucus(caucusID, caucusTimer, speakerSeconds)) {
        this.recoverCaucusFref().child('status').set(CaucusStatus.Closed);
        return;
      }
    }

    const ticking = timersAreRunning ? false : getTimeWithSkewCorrection(skew);

    if (speakersList && caucus.speaking) {
      const speakerName = this.currentSpeakerName(caucus.speaking);
      const speechAction = caucus.speaking.speechKind === SpeechKind.Answer
        ? '回答'
        : caucus.speaking.speechKind === SpeechKind.Comment
          ? '评论'
          : '发言';
      if (timersAreRunning) {
        this.appendLogs([
          `${speakerName} 代表暂停${speechAction}。剩余时间为${formatCaucusLogTime(speakerTimer.remaining)}。`
        ]);
      } else if (!caucus.speaking.started) {
        this.appendLogs([speakerStartLog(caucus.speaking, speakerName)]);
      } else {
        this.appendLogs([
          `${speakerName} 代表继续${speechAction}。`
        ]);
      }
    }

    const timerUpdate = speakersList
      ? {
        speakerTimer: {...speakerTimer, ticking},
        ...(!timersAreRunning && caucus.speaking && !caucus.speaking.started
          ? {'speaking/started': true}
          : {})
      }
      : {
        caucusTimer: {...caucusTimer, ticking},
        speakerTimer: {...speakerTimer, ticking}
      };

    this.recoverCaucusFref().update(timerUpdate);
    if (speakersList && !timersAreRunning) {
      this.setState({yieldNotice: undefined});
    }
  }

  renderCaucus = (caucus?: CaucusData) => {
    const { renderNowSpeaking, renderHeader, recoverCaucusFref } = this;
    const { caucusTimer, speakerTimer, committee } = this.state;

    const { caucusID } = this.props.match.params;
    const caucusFref = recoverCaucusFref();
    const speakersList = isGeneralSpeakersList(caucusID);

    const members = recoverMembers(committee);

    const renderedSpeakerTimer = (
      <Timer
        name="Speaker timer"
        timerFref={caucusFref.child('speakerTimer')}
        key={caucusID + 'speakerTimer'}
        onChange={this.setSpeakerTimer}
        onToggle={this.toggleTimers}
        toggleKeyCode={83} // S - if changing this, update Help
        defaultUnit={recoverUnit(caucus)}
        defaultDuration={recoverDuration(caucus) || 60}
      />
    );

    const renderedCaucusTimer = (
      <Timer
        name="Caucus timer"
        timerFref={caucusFref.child('caucusTimer')}
        key={caucusID + 'caucusTimer'}
        onChange={this.setCaucusTimer}
        onToggle={this.toggleTimers}
        toggleKeyCode={67} // C - if changing this, update Help
        defaultUnit={Unit.Minutes}
        defaultDuration={10}
      />
    );

    const { 
      autoNextSpeaker, 
      timersInSeparateColumns,
      moveQueueUp
    } = recoverSettings(committee);

    const header = (
      <Grid.Row>
        <Grid.Column>
          {renderHeader(caucus)}
        </Grid.Column>
      </Grid.Row>
    );

    const renderedCaucusQueuer = (
      <Queuer
        caucus={caucus} 
        members={members} 
        caucusFref={caucusFref} 
      />
    );

    const renderedCaucusNextSpeaking = (
      <NextSpeaking
        caucus={caucus} 
        members={members}
        fref={caucusFref} 
        speakerTimer={speakerTimer} 
        autoNextSpeaker={autoNextSpeaker}
        caucusID={caucusID}
        onNextSpeaker={() => this.advanceSpeaker()}
        toggleTimers={this.toggleTimers}
        yieldDecisionActive={!!this.state.yieldMode}
      />
    );

    const yieldAvailable = canOfferSpeakerYield(caucusID, caucus?.speaking, speakerTimer);
    const renderedYieldCard = (yieldAvailable || !!this.state.yieldMode) ? (
      <YieldCard
        mode={this.state.yieldMode}
        targetID={this.state.yieldTargetID}
        options={this.yieldOptions()}
        onChooseMode={this.chooseYieldMode}
        onChooseTarget={this.chooseYieldTarget}
        onAccept={this.acceptDelegateYield}
        onReject={this.rejectDelegateYield}
      />
    ) : null;
    const renderedYieldNotice = this.state.yieldNotice ? (
      <Message info content={this.state.yieldNotice} />
    ) : null;

    const completedBody = (
      <Grid.Row>
        <Grid.Column>
          <Segment placeholder textAlign="center">
            <Header icon>
              <Icon name="check circle outline" />
              {t(speakersList ? 'Speakers list complete' : 'Moderated caucus complete')}
            </Header>
            <Button
              primary
              size="large"
              onClick={() => this.props.history.push(`/committees/${this.props.match.params.committeeID}/motions`)}
            >
              {t('Go to motions')}
              <Icon name="arrow right" />
            </Button>
          </Segment>
        </Grid.Column>
      </Grid.Row>
    );

    const combinedTimerBody = (
      <Grid.Row>
        <Grid.Column>
          {renderNowSpeaking(caucus, members)}
          {moveQueueUp && renderedCaucusQueuer}
          {renderedCaucusNextSpeaking}
          {!moveQueueUp && renderedCaucusQueuer}
        </Grid.Column>
        <Grid.Column>
          {renderedSpeakerTimer}
          {!speakersList && renderedCaucusTimer}
          {speakersList && renderedYieldCard}
          {speakersList && renderedYieldNotice}
        </Grid.Column>
      </Grid.Row>
    );

    const separateTimerBody = (
      <Grid.Row>
        <Grid.Column>
          {renderedSpeakerTimer}
          {renderNowSpeaking(caucus, members)}
          {renderedCaucusNextSpeaking}
        </Grid.Column>
        <Grid.Column>
          {renderedCaucusTimer}
          {renderedCaucusQueuer}
        </Grid.Column>
      </Grid.Row>
    );

    const body = speakersList || !timersInSeparateColumns
      ? combinedTimerBody
      : separateTimerBody;

    return (
      <Container style={{ 'padding-bottom': '2em' }}>
        <Helmet>
            <title>{`${localizeGeneratedName(caucus?.name ?? '')} - Quorum`}</title>
        </Helmet>
        <Grid columns="equal" stackable>
          {header}
          {caucus?.status === CaucusStatus.Closed ? completedBody : body}
        </Grid >
      </Container>
    );
  }

  render() {
    const { committee, loading } = this.state;
    const caucusID: CaucusID = this.props.match.params.caucusID;

    const caucus = recoverCaucus(committee, caucusID);

    if (!loading && !caucus) {
      return (
        <Container text style={{ 'padding-bottom': '2em' }}>
          <NotFound item="caucus" id={caucusID} />
        </Container>
      );
    } else {
      return this.renderCaucus(caucus);
    }
  }
}

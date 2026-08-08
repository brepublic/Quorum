import * as React from 'react';
import firebase from 'firebase/compat/app';
import {RouteComponentProps} from 'react-router';
import {Button, Card, Checkbox, Container, Divider, DropdownProps, Form, Icon, Label, Message, Popup} from 'semantic-ui-react';
import {
  checkboxHandler,
  stateDropdownHandler,
  stateFieldHandler,
  stateTextAreaHandler,
  stateValidatedNumberFieldHandler
} from '../modules/handlers';
import {implies,} from '../utils';
import {TimeSetter} from '../components/TimeSetter';
import {canVote, displayMemberName, isMemberPresent, localizedMemberOptions, memberByName, MemberFlag, MemberID, nameToMemberOption, nonNGO} from '../modules/member';
import {
  CaucusData,
  CaucusStatus,
  closeCaucus,
  DEFAULT_CAUCUS,
  putCaucus,
  putSpeaking, Stance
} from '../models/caucus';
import {
  CommitteeData,
  CommitteeID,
  DEFAULT_COMMITTEE,
  extendModTimer,
  extendUnmodTimer,
  putUnmodTimer,
  recoverCaucus,
  recoverAttendanceMemberOptions,
  recoverResolution,
  recoverSettings
} from '../models/committee';
import {URLParameters} from '../types';
import {IdenticalProposerSeconder} from './Resolution';
import {
  AmendmentData,
  DEFAULT_AMENDMENT,
  DEFAULT_RESOLUTION,
  putAmendment,
  putResolution,
  ResolutionData
} from '../models/resolution';
import {DEFAULT_STRAWPOLL, putStrawpoll} from '../models/strawpoll';
import {MotionsShareHint} from '../components/share-hints';
import _ from 'lodash';
import {makeCommitteeStats} from '../modules/committee-stats';
import {DEFAULT_MOTION, MOTION_TYPE_OPTIONS, MotionData, MotionID, MotionResult, MotionType, MotionVote} from "../models/motion";
import {
  approvable,
  destinationName,
  detailLabel,
  disruptiveness,
  hasCaucusTarget,
  hasDetail,
  hasDuration,
  hasResolutionTarget,
  hasSeconder,
  hasSpeakers,
  hasTextArea,
  procedural,
  showMotionType
} from "../viewmodels/motion";
import {getSeconds, TimerData, Unit} from "../models/time";
import {SettingsData} from "../models/settings";
import { Helmet } from 'react-helmet';
import { getLanguage, localizeGeneratedName, t } from '../i18n';
import {getAutomaticVoteResult} from '../viewmodels/voting';

const DivisibilityError = () => (
  <Message
    error
    content={t('Speaker time does not evenly divide the caucus time')}
  />
);

interface Props extends RouteComponentProps<URLParameters> {
}

interface State {
  newMotion: MotionData;
  committee?: CommitteeData;
  committeeFref: firebase.database.Reference;
  votingMemberID?: MemberID;
}

export class MotionsComponent extends React.Component<Props, State> {
  decidingMotions = new Set<MotionID>();

  constructor(props: Props) {
    super(props);

    const { match } = props;

    this.state = {
      committeeFref: firebase.database().ref('committees').child(match.params.committeeID),
      newMotion: DEFAULT_MOTION
    };
  }

  firebaseCallback = (committee: firebase.database.DataSnapshot | null) => {
    if (committee) {
      this.setState({ committee: committee.val() });
    }
  }

  componentDidMount() {
    this.state.committeeFref.on('value', this.firebaseCallback);
  }

  componentWillUnmount() {
    this.state.committeeFref.off('value', this.firebaseCallback);
  }

  handlePushMotion = (): void => {
    const { newMotion } = this.state;

    if (!isMemberPresent(this.state.committee?.members, newMotion.proposer)
      || (hasSeconder(newMotion.type)
        && !isMemberPresent(this.state.committee?.members, newMotion.seconder))) {
      return;
    }

    this.state.committeeFref.child('motions').push().set(newMotion);

    const duration = newMotion.caucusUnit === 'min'
      ? (newMotion.caucusDuration || 0) + 1
      : newMotion.caucusDuration;

    this.setState(prevState => {
      const { proposer, proposerID, seconder, seconderID, ...rest } = {
        ...prevState.newMotion,
        caucusDuration: duration,
        proposal: ''
      };

      return {
        newMotion: rest
      };
    });
  }

  handleClearMotions = (): void => {
    const { committee } = this.state;

    const { committeeFref } = this.state;

    const motions = committee
      ? committee.motions || {} as Record<string, MotionData>
      : {} as Record<string, MotionData>;

    Object.keys(motions).filter(key => !motions[key].result).forEach(key => {
      committeeFref
        .child('motions')
        .child(key)
        .child('deleted')
        .set(true)
    })
  }

  handleClearAdder = () => {
    this.setState({
      newMotion: DEFAULT_MOTION
    });
  }

  enactMotion = (
    motionData: MotionData
  ): string | undefined => {
    const committeeID: CommitteeID = this.props.match.params.committeeID;
    const { committee } = this.state;

    const { proposer, speakerDuration, speakerUnit,
      caucusDuration, caucusUnit, seconder, proposal } = motionData;

    if (!isMemberPresent(committee?.members, proposer)
      || (hasSeconder(motionData.type) && !isMemberPresent(committee?.members, seconder))) {
      return undefined;
    }

    const caucusID = motionData.caucusTarget;
    const resolutionID = motionData.resolutionTarget;

    if (motionData.type === MotionType.OpenModeratedCaucus && speakerDuration && caucusDuration && proposer) {

      const speakerSeconds = getSeconds(speakerDuration, speakerUnit);
      const caucusSeconds = getSeconds(caucusDuration, caucusUnit);

      const newCaucus: CaucusData = {
        ...DEFAULT_CAUCUS,
        name: proposal,
        speakerTimer: {
          ...DEFAULT_CAUCUS.speakerTimer,
          remaining: speakerSeconds
        },
        caucusTimer: {
          ...DEFAULT_CAUCUS.caucusTimer,
          remaining: caucusSeconds
        },
        speaking: {
          who: proposer,
          memberID: motionData.proposerID,
          stance: Stance.For,
          duration: speakerSeconds
        },
        speakerDuration: speakerDuration,
        speakerUnit: speakerUnit
      };

      const caucusRef = putCaucus(committeeID, newCaucus);

      return `/committees/${committeeID}/caucuses/${caucusRef.key}`;

    }
    else if ((motionData.type === MotionType.OpenUnmoderatedCaucus || motionData.type === MotionType.AddWorkingPaper) && caucusDuration) {
      const caucusSeconds = getSeconds(caucusDuration, caucusUnit);

      const newTimer: TimerData = {
        ...DEFAULT_COMMITTEE.timer,
        remaining: caucusSeconds
      };

      putUnmodTimer(committeeID, newTimer);

      return `/committees/${committeeID}/unmod`;

    } else if (motionData.type === MotionType.IntroduceDraftResolution && proposer && seconder) {
      const newResolution: ResolutionData = {
        ...DEFAULT_RESOLUTION,
        name: proposal,
        proposer: proposer,
        seconder: seconder
      };

      const resolutionRef = putResolution(committeeID, newResolution);

      return `/committees/${committeeID}/resolutions/${resolutionRef.key}`;

    } else if (motionData.type === MotionType.ExtendUnmoderatedCaucus && caucusDuration) {
      const caucusSeconds = getSeconds(caucusDuration, caucusUnit);

      // TODO: Do I wait a second before extending so it looks sexy?

      // FIXME: This has an obvious bug, in that we don't have the actual timer value
      // when this gets fired off
      extendUnmodTimer(committeeID, caucusSeconds);

      return `/committees/${committeeID}/unmod`;

    } else if (motionData.type === MotionType.ExtendModeratedCaucus && caucusDuration && caucusID && proposer && committee) {
      const caucusSeconds = getSeconds(caucusDuration, caucusUnit);

      extendModTimer(committeeID, caucusID, caucusSeconds);

      // @ts-ignore Assert that this exists
      const caucus: CaucusData = committee.caucuses[caucusID];
      const speakerSeconds = getSeconds(caucus.speakerDuration, caucus.speakerUnit);

      putSpeaking(committeeID, caucusID, {
        who: proposer,
        memberID: motionData.proposerID,
        stance: Stance.For,
        duration: speakerSeconds
      });

      return `/committees/${committeeID}/caucuses/${caucusID}`;

    } else if (motionData.type === MotionType.CloseModeratedCaucus && caucusID) {
      closeCaucus(committeeID, caucusID);
      return `/committees/${committeeID}/caucuses/${caucusID}`;
    } else if (motionData.type === MotionType.IntroduceAmendment && resolutionID && proposer) {
      const newAmendment: AmendmentData = {
        ...DEFAULT_AMENDMENT,
        text: proposal,
        proposer: proposer
      };

      putAmendment(committeeID, resolutionID, newAmendment);
      return `/committees/${committeeID}/resolutions/${resolutionID}/amendments`;
    } else if (motionData.type === MotionType.VoteOnResolution && resolutionID) {
      return `/committees/${committeeID}/resolutions/${resolutionID}/voting`;
    } else if (motionData.type === MotionType.ProposeStrawpoll) {
      const strawpollRef = putStrawpoll(committeeID, {
        ...DEFAULT_STRAWPOLL,
        question: proposal
      });

      return `/committees/${committeeID}/strawpolls/${strawpollRef.key}`;
    }

    return undefined;
  }

  handleDecideMotion = async (
    id: MotionID,
    motionFref: firebase.database.Reference,
    motionData: MotionData,
    result: MotionResult
  ): Promise<void> => {
    if (motionData.result || this.decidingMotions.has(id)) {
      return;
    }

    this.decidingMotions.add(id);
    this.forceUpdate();

    try {
      const destination = result === MotionResult.Passed
        ? this.enactMotion(motionData)
        : undefined;

      await motionFref.update({
        result,
        decidedAt: Date.now(),
        destination: destination || null
      });
    } finally {
      this.decidingMotions.delete(id);
      this.forceUpdate();
    }
  }

  renderMotion = (id: MotionID, motionData: MotionData, motionFref: firebase.database.Reference) => {
    const { handleDecideMotion } = this;
    const { committee } = this.state;
    const { proposer, proposal, type, caucusUnit, caucusDuration, speakerUnit,
      speakerDuration, seconder, caucusTarget, resolutionTarget } = motionData;

    const caucus = recoverCaucus(committee, caucusTarget || '');
    const caucusTargetText = caucus ? caucus.name : caucusTarget;

    const resolution = recoverResolution(committee, resolutionTarget || '');
    const resolutionTargetText = resolution ? resolution.name : resolutionTarget;
    const proposerPresent = isMemberPresent(committee?.members, proposer);
    const seconderPresent = !hasSeconder(type) || isMemberPresent(committee?.members, seconder);


    const renderVoteCount = () => {
      const votes = motionData.votes ?? {};
      const members = committee?.members || {};
      const eligibleMemberIDs = Object.keys(members).filter(memberID => {
        const member = members[memberID];
        return member.present && (procedural(motionData.type) ? nonNGO(member) : canVote(member));
      });
      const votingMemberID = this.state.votingMemberID;
      const canSelectedMemberVote = !motionData.result
        && !!votingMemberID
        && eligibleMemberIDs.includes(votingMemberID);

      // Remove vote if same vote, otherwise change vote
      const vote = (vote: MotionVote) => {
        if (!votingMemberID || !canSelectedMemberVote) {
          return;
        }

        if (votes[votingMemberID] === vote) {
          motionFref.child('votes').child(votingMemberID).remove();
        } else {
          motionFref.child('votes').child(votingMemberID).set(vote);
        }
      }

      const eligibleVotes = Object.entries(votes)
        .filter(([memberID]) => eligibleMemberIDs.includes(memberID))
        .map(([, vote]) => vote);
      const counts = _.countBy(eligibleVotes);
      const thresholdStats = makeCommitteeStats(committee);
      const threshold = procedural(motionData.type)
        ? thresholdStats.procedural
        : thresholdStats.operative;
      const fors = counts[MotionVote.For] ?? 0;
      const automaticResult = getAutomaticVoteResult({
        eligibleVoters: eligibleMemberIDs.length,
        votesFor: fors,
        votesCast: eligibleVotes.length,
        threshold
      });
      const passed = automaticResult === 'passed';
      const failed = automaticResult === 'failed';

      return (
        <div className="motion-vote-panel">
          <Button.Group fluid>
            <Popup
              content={t('Against')}
              trigger={
                <Button
                  color='red'
                  disabled={!canSelectedMemberVote}
                  active={!!votingMemberID && votes[votingMemberID] === MotionVote.Against}
                  onClick={() => vote(MotionVote.Against)}
                >
                  <Icon name={
                    votingMemberID && votes[votingMemberID] === MotionVote.Against
                      ? "thumbs down"
                      : "thumbs down outline"}
                  />
                  {counts[MotionVote.Against] ?? 0}
                </Button>
              }
            />
            {!procedural(motionData.type) &&
              <Popup
                content={t('Abstain')}
                trigger={
                  <Button
                    color='yellow'
                    disabled={!canSelectedMemberVote}
                    active={!!votingMemberID && votes[votingMemberID] === MotionVote.Abstain}
                    onClick={() => vote(MotionVote.Abstain)}
                  >
                    <Icon name={
                      votingMemberID && votes[votingMemberID] === MotionVote.Abstain
                        ? "circle"
                        : "circle outline"}
                    />
                    {counts[MotionVote.Abstain] ?? 0}
                  </Button>
                } />
              }
            <Popup
              content={t('In favour')}
              trigger={
                <Button
                  color='green'
                  disabled={!canSelectedMemberVote}
                  active={!!votingMemberID && votes[votingMemberID] === MotionVote.For}
                  onClick={() => vote(MotionVote.For)}
                >
                  <Icon name={
                    votingMemberID && votes[votingMemberID] === MotionVote.For
                      ? "thumbs up"
                      : "thumbs up outline"}
                  />
                  {counts[MotionVote.For] ?? 0}
                </Button>
              } />
          </Button.Group>
          <div className="motion-vote-result">
            <span>{t('{count} votes required to pass a motion', {count: threshold})}</span>
            {passed && <Label color="green">{t('Passed')}</Label>}
            {failed && <Label color="red">{t('Failed')}</Label>}
          </div>
        </div>
      )
    }

    const descriptionTree = (
      <Card.Description>
        <Label horizontal>
          {t(detailLabel(type))}
        </Label>
        {proposal}
      </Card.Description>
    );

    // TODO: we definately can add links here
    const proposerTree = (
      <div>
        <Label horizontal>
          {t('Proposer')}
        </Label>
        <MemberFlag member={memberByName(committee?.members, proposer || '')} /> {proposer ? displayMemberName(proposer) : ''}
        {!proposerPresent && <Label basic size="mini">{t('Absent')}</Label>}
      </div>
    );

    const seconderTree = (
      <div>
        <Label horizontal>
          {t('Seconder')}
        </Label>
        <MemberFlag member={memberByName(committee?.members, seconder || '')} /> {seconder ? displayMemberName(seconder) : ''}
        {!seconderPresent && <Label basic size="mini">{t('Absent')}</Label>}
      </div>
    );

    const caucusTargetTree = (
      <div>
        <Label horizontal>
          {t('Target caucus')}
        </Label>
        {caucusTargetText}
      </div>
    );

    const resolutionTargetTree = (
      <div>
        <Label horizontal>
          {t('Target resolution')}
        </Label>
        {resolutionTargetText}
      </div>
    );

    const time = hasDuration(type) ?
      hasSpeakers(type)
        ? `${caucusDuration || 0} ${t(caucusUnit)} / ${speakerDuration || 0} ${t(speakerUnit)} `
        : `${caucusDuration || 0} ${t(caucusUnit)} `
      : '';
    const isDecided = !!motionData.result;
    const isDeciding = this.decidingMotions.has(id);
    const canPass = !approvable(type)
      || (isMemberPresent(committee?.members, motionData.proposer)
        && (!hasSeconder(type) || isMemberPresent(committee?.members, motionData.seconder)));
    const decisionText = motionData.result === MotionResult.Passed ? t('Passed') : t('Failed');
    const decisionTime = motionData.decidedAt
      ? new Date(motionData.decidedAt).toLocaleString(getLanguage())
      : '';
    const destination = destinationName(type);

    return (
      <Card
        className="motion"
        key={id}
      >
        <Card.Content>
          <div className="motion-heading">
            <Card.Header>
              {t(showMotionType(type, time))}
            </Card.Header>
            {isDecided ? (
              <time
                className={`motion-decision motion-decision-${motionData.result}`}
                dateTime={motionData.decidedAt ? new Date(motionData.decidedAt).toISOString() : undefined}
              >
                {decisionText}{decisionTime && ` · ${decisionTime}`}
              </time>
            ) : (
              <Popup
                content={t('Delete')}
                trigger={
                  <Button
                    aria-label={t('Delete')}
                    basic
                    circular
                    compact
                    icon="trash"
                    negative
                    onClick={() => motionFref.child('deleted').set(true)}
                  />
                }
              />
            )}
          </div>
          <Card.Meta>
            {proposerTree}
            {hasSeconder(type) && seconderTree}
            {hasCaucusTarget(type) && caucusTargetTree}
            {hasResolutionTarget(type) && resolutionTargetTree}
          </Card.Meta>
          {hasDetail(type) && descriptionTree}
        </Card.Content>
        {recoverSettings(committee).motionVotes && (
          <Card.Content extra>{renderVoteCount()}</Card.Content>
        )}
        {!isDecided && (
          <Button.Group fluid attached="bottom">
            <Button
              negative
              disabled={isDeciding}
              loading={isDeciding}
              onClick={() => handleDecideMotion(id, motionFref, motionData, MotionResult.Failed)}
            >
              {t('Failed')}
            </Button>
            <Button
              positive
              disabled={!canPass || isDeciding}
              loading={isDeciding}
              onClick={() => handleDecideMotion(id, motionFref, motionData, MotionResult.Passed)}
            >
              {t('Passed')}
            </Button>
          </Button.Group>
        )}
        {isDecided && motionData.destination && destination && (
          <Button
            attached="bottom"
            fluid
            primary
            onClick={() => this.props.history.push(motionData.destination!)}
          >
            {t(destination)}
            <Icon name="arrow right" />
          </Button>
        )}
      </Card>
    );
  }

  hasDivisiblityError = () => {
    const { type, caucusDuration, caucusUnit, speakerDuration, speakerUnit } = this.state.newMotion;

    const caucusSeconds = getSeconds(caucusDuration || 0, caucusUnit);
    const speakerSeconds = getSeconds(speakerDuration || 0, speakerUnit);

    const doesNotEvenlyDivide = (caucusSeconds % speakerSeconds) !== 0;

    return hasSpeakers(type) && hasDuration(type) && doesNotEvenlyDivide;
  }

  hasIdenticalProposerSeconder = () => {
    const { proposer, seconder } = this.state.newMotion;

    return proposer && seconder ? proposer === seconder : false;
  }

  renderAdder = (committee?: CommitteeData): JSX.Element => {
    const { newMotion } = this.state;
    const { proposer, proposal, type, caucusUnit, caucusDuration, speakerUnit,
      speakerDuration, seconder, caucusTarget, resolutionTarget } = newMotion;

    const boxForAmmendments = (
      <Form.TextArea
        value={proposal}
        autoHeight
        onChange={stateTextAreaHandler<Props, State>(this, 'newMotion', 'proposal')}
        rows={2}
        label={t(detailLabel(newMotion.type))}
        placeholder={t(detailLabel(newMotion.type))}
      />
    );

    const boxForNames = (
      <Form.Input
        label={t('Name')}
        placeholder={t('Name')}
        value={proposal}
        onChange={stateFieldHandler<Props, State>(this, 'newMotion', 'proposal')}
        fluid
      />
    );

    const description = (
      <Form.Group widths="equal">
        {hasTextArea(newMotion.type)
          ? boxForAmmendments
          : boxForNames
        }
      </Form.Group>
    );

    const speakerSetter = (
      <TimeSetter
        error={this.hasDivisiblityError()}
        unitValue={speakerUnit}
        durationValue={speakerDuration ? speakerDuration.toString() : undefined}
        onUnitChange={stateDropdownHandler<Props, State>(this, 'newMotion', 'speakerUnit')}
        onDurationChange={stateValidatedNumberFieldHandler<Props, State>(this, 'newMotion', 'speakerDuration')}
        label={t('Speaking time')}
      />
    );

    const durationSetter = (
      <TimeSetter
        error={this.hasDivisiblityError()}
        unitValue={caucusUnit}
        durationValue={caucusDuration ? caucusDuration.toString() : undefined}
        onUnitChange={stateDropdownHandler<Props, State>(this, 'newMotion', 'caucusUnit')}
        onDurationChange={stateValidatedNumberFieldHandler<Props, State>(this, 'newMotion', 'caucusDuration')}
        label={t('Duration')}
      />
    );

    const resolutions: Record<string, ResolutionData> = this.state.committee?.resolutions || {};
    const caucuses: Record<string, CaucusData> = this.state.committee?.caucuses || {};

    // BADCODE: Filter predicate shared with menu in Committee, also update when changing
    // Prioritize recency
    const caucusOptions = Object.keys(caucuses || {}).filter(key =>
      caucuses![key].status === CaucusStatus.Open.toString()
    ).map(key =>
      ({ key: key, value: key, text: localizeGeneratedName(caucuses![key].name) })
    );

    // Prioritize recency
    const resolutionOptions = Object.keys(resolutions || {}).map(key =>
      ({ key: key, value: key, text: localizeGeneratedName(resolutions![key].name) })
    );

    const caucusTargetSetter = (
      <Form.Dropdown
        key="caucusTarget"
        value={caucusTarget}
        search
        selection
        fluid
        error={!caucusTarget}
        loading={!committee}
        onChange={stateDropdownHandler<Props, State>(this, 'newMotion', 'caucusTarget')}
        options={caucusOptions}
        icon="search"
        label={t('Target caucus')}
      />
    );

    const resolutionTargetSetter = (
      <Form.Dropdown
        key="resolutionTarget"
        value={resolutionTarget}
        search
        selection
        fluid
        error={!resolutionTarget}
        loading={!committee}
        onChange={stateDropdownHandler<Props, State>(this, 'newMotion', 'resolutionTarget')}
        options={resolutionOptions}
        icon="search"
        label={t('Target resolution')}
      />
    );

    const setters = (
      <Form.Group widths="equal">
        {hasCaucusTarget(type) && caucusTargetSetter}
        {hasResolutionTarget(type) && resolutionTargetSetter}
        {hasDuration(type) && durationSetter}
        {hasSpeakers(type) && speakerSetter}
      </Form.Group>
    );

    const memberOptions = recoverAttendanceMemberOptions(this.state.committee);
    const setMotionMember = (
      field: 'proposer' | 'seconder',
      idField: 'proposerID' | 'seconderID'
    ) => (_event: React.SyntheticEvent<HTMLElement>, data: DropdownProps) => {
      const selected = memberOptions.find(option => option.value === data.value);
      if (!selected || selected.disabled) {
        return;
      }

      this.setState(previous => ({
        newMotion: {
          ...previous.newMotion,
          [field]: selected.text,
          [idField]: selected.memberID
        }
      }));
    };
    const proposerPresent = isMemberPresent(committee?.members, proposer);
    const seconderPresent = !hasSeconder(type) || isMemberPresent(committee?.members, seconder);

    const proposerTree = (
      <Form.Dropdown
        icon="search"
        key="proposer"
        value={proposer ? nameToMemberOption(proposer).key : false}
        search
        error={!proposer || !proposerPresent || this.hasIdenticalProposerSeconder()}
        loading={!committee}
        selection
        fluid
        onChange={setMotionMember('proposer', 'proposerID')}
        options={localizedMemberOptions(memberOptions)}
        label={t('Proposer')}
      />
    );

    const seconderTree = (
      <Form.Dropdown
        icon="search"
        key="seconder"
        error={!seconder || !seconderPresent || this.hasIdenticalProposerSeconder()}
        value={seconder ? nameToMemberOption(seconder).key : false}
        loading={!committee}
        search
        selection
        fluid
        onChange={setMotionMember('seconder', 'seconderID')}
        options={localizedMemberOptions(memberOptions)}
        label={t('Seconder')}
      />
    );

    const hasError = this.hasDivisiblityError()
      || this.hasIdenticalProposerSeconder()
      || !proposerPresent
      || !seconderPresent;

    return (
      <Form
        error={hasError}
      >
        <Form.Dropdown
          placeholder={t('Select type')}
          search
          selection
          fluid
          label={t('Type')}
          icon="search"
          options={MOTION_TYPE_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
          onChange={stateDropdownHandler<Props, State>(this, 'newMotion', 'type')}
          value={type}
        />
        {hasDetail(type) && description}
        <Form.Group widths="equal">
          {proposerTree}
          {hasSeconder(type) && seconderTree}
        </Form.Group>
        {(hasSpeakers(type)
          || hasDuration(type)
          || hasCaucusTarget(type)
          || hasResolutionTarget(type)
        ) && setters}
        {this.hasDivisiblityError() && <DivisibilityError />}
        {this.hasIdenticalProposerSeconder() && <IdenticalProposerSeconder />}
        <Button
          icon="plus"
          basic
          primary
          fluid
          disabled={!proposer
            || !implies(hasSeconder(type), !!seconder)
            || !implies(hasCaucusTarget(type), !!caucusTarget)
            || !implies(hasResolutionTarget(type), !!resolutionTarget)
            || hasError
          }
          onClick={this.handlePushMotion}
        />
      </Form>
    );
  }

  renderMotions = (motions: Record<MotionID, MotionData>) => {
    const { renderMotion } = this;
    const { committeeFref } = this.state;

    return Object.keys(motions)
      .filter(key => !motions[key].deleted)
      .sort((a, b) => {
        const ma: MotionData = motions[a];
        const mb: MotionData = motions[b];
        const ca = disruptiveness(ma.type);
        const cb = disruptiveness(mb.type);

        if (ca < cb) {
          return -1;
        } else if (ca === cb) {

          const sa = (ma.caucusDuration || 0) * (ma.caucusUnit === Unit.Minutes ? 60 : 1);
          const sb = (mb.caucusDuration || 0) * (mb.caucusUnit === Unit.Minutes ? 60 : 1);

          // FIXME: Could be replaced by some sort of comapre function that I know exists
          if (sa < sb) {
            return 1;
          } else if (sa === sb) {
            return 0;
          } else {
            return -1;
          }
        } else {
          return 1;
        }
      }).map(key => {
        return renderMotion(key, motions[key], committeeFref.child('motions').child(key));
      });
  }

  render() {
    const { renderMotions, renderAdder } = this;
    const { committee, committeeFref } = this.state;
    const { committeeID } = this.props.match.params;
    const { operative } = makeCommitteeStats(this.state.committee);
    const { motionVotes, motionsArePublic } = recoverSettings(committee);
    const votingMemberOptions = Object.entries(committee?.members || {})
      .sort(([, a], [, b]) => displayMemberName(a.name).localeCompare(displayMemberName(b.name)))
      .map(([memberID, member]) => ({
        key: memberID,
        value: memberID,
        text: displayMemberName(member.name),
        flag: <MemberFlag member={member} />,
        disabled: !member.present,
        description: member.present ? undefined : t('Absent')
      }));

    const motions = committee?.motions || {} as Record<string, MotionData>;
    const renderedMotions = committee
      ? renderMotions(motions)
      : []; // TODO: This could probably do with a nice spinner
    const pendingMotionsCount = Object.values(motions)
      .filter(motion => !motion.deleted && !motion.result)
      .length;

    return (
      <Container text style={{ padding: '1em 0em' }}>
        <Helmet>
          <title>{`${t('Motions')} - Quorum`}</title>
        </Helmet>
        {renderAdder(committee)}
        <Divider hidden />
        <Checkbox
          style={{ 'padding-right': '50px' }}
          label={t('Delegates can propose motions')}
          toggle
          checked={motionsArePublic}
          onChange={
            checkboxHandler<SettingsData>(
              committeeFref.child('settings'),
              'motionsArePublic')}
        />
        <Checkbox
          label={t('Delegates can vote on motions')}
          toggle
          checked={motionVotes}
          onChange={
            checkboxHandler<SettingsData>(
              committeeFref.child('settings'),
              'motionVotes')}
        />
        {(motionVotes || motionsArePublic)
          && <MotionsShareHint 
            committeeID={committeeID}
            canVote={motionVotes}
            canPropose={motionsArePublic} />}
        {motionVotes && (
          <Form.Dropdown
            className="motion-voter"
            label={t('Voting delegation')}
            placeholder={t('Select your delegation')}
            search
            selection
            fluid
            value={this.state.votingMemberID}
            options={votingMemberOptions}
            onChange={(_event, data) => this.setState({votingMemberID: String(data.value)})}
          />
        )}
        <Divider />
        <Icon name="sort numeric ascending" /> {t('Sorted from most to least disruptive.')} {t('{count} votes required to pass a motion', { count: operative })}
        <Button
          negative
          disabled={pendingMotionsCount <= 0}
          floated="right"
          icon="eraser"
          content={t('Clear')}
          compact
          basic
          onClick={this.handleClearMotions}
        />
        <Divider hidden />
        <Card.Group
          itemsPerRow={1}
        >
          {renderedMotions}
        </Card.Group>
      </Container>
    );
  }
}

export default function Motions(props: Props) {
  return <MotionsComponent {...props} />
}

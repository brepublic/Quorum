import * as React from 'react';
import firebase from 'firebase/compat/app';
import * as _ from 'lodash';
import {canVote, displayMemberName, isMemberPresent, localizedMemberOptions, MemberData, MemberID, nameToMemberOption, Rank} from '../modules/member';
import {
  Button,
  Card,
  Confirm,
  Container,
  Dropdown,
  Form,
  Grid,
  Header,
  Icon,
  Input,
  Label,
  Message,
  Pagination,
  PaginationProps,
  Popup,
  Segment,
  Statistic,
  Tab,
  TabProps,
  TextArea
} from 'semantic-ui-react';
import {RouteComponentProps} from 'react-router';
import {URLParameters} from '../types';
import {
  checkboxHandler,
  dropdownHandler,
  fieldHandler,
  memberDropdownHandler,
  textAreaHandler
} from '../modules/handlers';
import {
  AMENDMENT_STATUS_OPTIONS,
  AmendmentData,
  AmendmentID,
  DEFAULT_AMENDMENT, DEFAULT_RESOLUTION, Majority, MAJORITY_OPTIONS,
  recoverLinkedCaucus, RESOLUTION_STATUS_OPTIONS, ResolutionData, ResolutionID, ResolutionStatus, Vote,
  voteOnResolution
} from '../models/resolution';
import {CaucusData, CaucusID, DEFAULT_CAUCUS, putCaucus, Stance} from '../models/caucus';
import {NotFound} from '../components/NotFound';
import Files from './Files';
import {makeCommitteeStats} from '../modules/committee-stats';
import {CommitteeData, recoverAttendanceMemberOptions} from "../models/committee";
import {getThreshold, getThresholdName} from "../viewmodels/resolution";
import {getAutomaticVoteResult, nextUnvotedMemberID} from "../viewmodels/voting";
import { Helmet } from 'react-helmet';
import { localizeGeneratedName, t } from '../i18n';

const TAB_ORDER = ['feed', 'text', 'amendments', 'voting'];
export const RESOLUTION_VOTING_PAGE_SIZE = 18;

export const IdenticalProposerSeconder = () => (
  <Message
    error
    content={t("A resolution's proposer and seconder cannot be the same")}
  />
);

export const DelegatesCanAmendNotice = () => (
  <Message
    basic
    attached="bottom"
  >
    {t('Delegates can create and edit, but not delete, amendments.')}
  </Message>
);


function DeleteResolutionModal(props: { onConfirm: () => void }) {
  const [isModalOpen, setIsModalOpen] = React.useState(false);

  return (<>
      <Dropdown.Item negative fluid basic
          onClick={() => setIsModalOpen(true)}
      >
        <Icon name="delete" /> {t('Delete resolution?')}
      </Dropdown.Item>
      <Confirm
        open={isModalOpen}
        header={t('Delete resolution?')}
        content={t('Are you sure? This is irreversible and will delete all posts, text, amendments and voting history. You might want to close the resolution (top right dropdown) instead?')}
        cancelButton={t('Cancel')}
        confirmButton={t('OK')}
        onCancel={() => setIsModalOpen(false)}
        onConfirm={() => { setIsModalOpen(false); props.onConfirm() }}
      />
    </>)
}

interface Props extends RouteComponentProps<URLParameters> {
}

interface State {
  committeeFref: firebase.database.Reference;
  committee?: CommitteeData;
  authUnsubscribe?: () => void;
  user?: firebase.User | null;
  loading: boolean;
  currentVotingMemberID?: MemberID;
  votingPage: number;
  votingResolutionID: ResolutionID;
  votingHistory: Array<{
    memberID: MemberID;
    previousVote?: Vote;
    previousCurrentMemberID?: MemberID;
    previousPage: number;
  }>;
}

export default class Resolution extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    const { match } = props;

    this.state = {
      committeeFref: firebase.database().ref('committees').child(match.params.committeeID),
      loading: true,
      votingPage: 0,
      votingResolutionID: match.params.resolutionID,
      votingHistory: []
    };
  }

  authStateChangedCallback = (user: firebase.User | null) => {
    this.setState({ user: user });
  }

  firebaseCallback = (committee: firebase.database.DataSnapshot | null) => {
    if (committee) {
      const committeeData: CommitteeData = committee.val();
      this.setState(state => {
        const resolutionID = this.props.match.params.resolutionID;
        const resolutionChanged = state.votingResolutionID !== resolutionID;
        const votingMemberIDs = this.sortedVotingMemberIDs(committeeData);
        const presentVotingMemberIDs = votingMemberIDs
          .filter(memberID => committeeData.members?.[memberID]?.present);
        const resolution = committeeData.resolutions?.[resolutionID];
        const currentIsEligible = !resolutionChanged && !!state.currentVotingMemberID
          && presentVotingMemberIDs.includes(state.currentVotingMemberID);
        const currentVotingMemberID = currentIsEligible
          ? state.currentVotingMemberID
          : presentVotingMemberIDs.find(memberID => !resolution?.votes?.[memberID])
            ?? presentVotingMemberIDs[0];
        const currentIndex = currentVotingMemberID
          ? votingMemberIDs.indexOf(currentVotingMemberID)
          : -1;

        return {
          committee: committeeData,
          currentVotingMemberID,
          loading: false,
          votingHistory: resolutionChanged ? [] : state.votingHistory,
          votingPage: currentIndex >= 0
            ? Math.floor(currentIndex / RESOLUTION_VOTING_PAGE_SIZE)
            : state.votingPage,
          votingResolutionID: resolutionID
        };
      });
    }
  }

  sortedVotingMemberIDs = (committee: CommitteeData | undefined = this.state.committee): MemberID[] => {
    const members = committee?.members || {};
    return Object.keys(members)
      .filter(memberID => canVote(members[memberID]))
      .sort((first, second) => members[first].name.localeCompare(members[second].name, 'en'));
  };

  componentDidMount() {
    this.state.committeeFref.on('value', this.firebaseCallback);

    const authUnsubscribe = firebase.auth().onAuthStateChanged(
      this.authStateChangedCallback,
    );

    this.setState({ authUnsubscribe });
  }

  componentWillUnmount() {
    this.state.committeeFref.off('value', this.firebaseCallback);

    if (this.state.authUnsubscribe) {
      this.state.authUnsubscribe();
    }
  }

  recoverResolutionFref = () => {
    const resolutionID: ResolutionID = this.props.match.params.resolutionID;

    return this.state.committeeFref
      .child('resolutions')
      .child(resolutionID);
  }

  handlePushAmendment = (): void => {
    this.recoverResolutionFref().child('amendments').push().set(DEFAULT_AMENDMENT);
  }

  handleProvisionAmendment = (id: AmendmentID, amendment: AmendmentData) => {
    const { committeeID } = this.props.match.params;
    const { proposer, text } = amendment;

    if (!isMemberPresent(this.state.committee?.members, proposer)) {
      return;
    }

    const newCaucus: CaucusData = {
      ...DEFAULT_CAUCUS,
      name: `Amendment by ${amendment.proposer}`,
      topic: text,
      speaking: {
        duration: DEFAULT_CAUCUS.speakerTimer.remaining,
        who: proposer,
        stance: Stance.For,
      }
    };

    const ref = putCaucus(committeeID, newCaucus);

    this.recoverResolutionFref().child('amendments').child(id).child('caucus').set(ref.key);

    this.gotoCaucus(ref.key);
  }

  gotoCaucus = (caucusID: CaucusID | null | undefined) => {
    const { committeeID } = this.props.match.params;

    if (caucusID) {
      this.props.history
        .push(`/committees/${committeeID}/caucuses/${caucusID}`);
    }
  }

  handleProvisionResolution = (resolutionData: ResolutionData) => {
    const { committeeID } = this.props.match.params;
    const { proposer, seconder, name } = resolutionData;

    if (!isMemberPresent(this.state.committee?.members, proposer)
      || !isMemberPresent(this.state.committee?.members, seconder)) {
      return;
    }

    const newCaucus: CaucusData = {
      ...DEFAULT_CAUCUS,
      name: name,
      speaking: {
        duration: DEFAULT_CAUCUS.speakerTimer.remaining,
        who: proposer || '', // defend against undefined proposers
        stance: Stance.For,
      }
    };

    const ref = putCaucus(committeeID, newCaucus);

    ref.child('queue').push().set({
      duration: DEFAULT_CAUCUS.speakerTimer.remaining,
      who: seconder,
      stance: Stance.For,
    });

    this.recoverResolutionFref().child('caucus').set(ref.key);

    this.gotoCaucus(ref.key);
  }

  renderAmendment = (id: AmendmentID, amendment: AmendmentData, amendmentFref: firebase.database.Reference) => {
    const { handleProvisionAmendment } = this;
    const { proposer, text, status } = amendment;
    const { user, committee } = this.state;

    const textArea = (
      <TextArea
        value={text}
        label={t('Text')}
        autoHeight
        onChange={textAreaHandler<AmendmentData>(amendmentFref, 'text')}
        rows={1}
        placeholder={t('Text')}
      />
    );

    let hasAuth = false;

    if (committee && user) {
      hasAuth = committee.creatorUid === user.uid;
    }

    const statusDropdown = (
      <Dropdown
        disabled={!hasAuth}
        value={status}
        options={AMENDMENT_STATUS_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
        onChange={dropdownHandler<AmendmentData>(amendmentFref, 'status')}
      />
    );

    const memberOptions = recoverAttendanceMemberOptions(this.state.committee);
    const proposerPresent = isMemberPresent(committee?.members, proposer);

    const proposerDropdown = (
      <Form.Dropdown
        key="proposer"
        icon="search"
        value={nameToMemberOption(proposer).key}
        error={!proposer || !proposerPresent}
        search
        selection
        fluid
        label={t('Amendment proposer')}
        placeholder={t('Amendment proposer')}
        onChange={memberDropdownHandler<AmendmentData>(amendmentFref, 'proposer', memberOptions)}
        options={localizedMemberOptions(memberOptions)}
      />
    );

    const provisionTree = recoverLinkedCaucus(amendment) ? (
      <Button
        floated="right"
        onClick={() => this.gotoCaucus(amendment!.caucus)}
      >
        {t('Associated caucus')}
        <Icon name="arrow right" />
      </Button>
    ):(
      <Button
        floated="right"
        disabled={!amendment || amendment.proposer === '' || !proposerPresent || !hasAuth}
        onClick={() => handleProvisionAmendment(id, amendment!)}
      >
        {t('Provision caucus')}
      </Button>
    );

    return (
      <Card
        key={id}
      >
        <Card.Content>
          <Card.Header>
            {statusDropdown}
            <Button
              floated="right"
              icon="trash"
              negative
              disabled={!hasAuth}
              basic
              onClick={() => amendmentFref.remove()}
            />
            {provisionTree}
          </Card.Header>
          <Card.Meta>
            {proposerDropdown}
          </Card.Meta>
          <Form>
            {textArea}
          </Form>
        </Card.Content>
      </Card>
    );
  }

  setCurrentVote = (newVote: Vote) => {
    const { resolutionID, committeeID } = this.props.match.params;
    const {committee, currentVotingMemberID} = this.state;
    const member = currentVotingMemberID
      ? committee?.members?.[currentVotingMemberID]
      : undefined;

    if (!currentVotingMemberID || !member?.present || !canVote(member)) {
      return;
    }
    if (newVote === Vote.Abstaining && member.voting) {
      return;
    }

    const resolution = committee?.resolutions?.[resolutionID];
    const previousVote = resolution?.votes?.[currentVotingMemberID];
    const votingMemberIDs = this.sortedVotingMemberIDs();
    const presentVotingMemberIDs = votingMemberIDs
      .filter(memberID => committee?.members?.[memberID]?.present);
    const optimisticVotes = {...(resolution?.votes || {}), [currentVotingMemberID]: newVote};
    const nextMemberID = nextUnvotedMemberID(
      presentVotingMemberIDs,
      currentVotingMemberID,
      optimisticVotes
    )
      ?? currentVotingMemberID;
    const nextIndex = votingMemberIDs.indexOf(nextMemberID);

    voteOnResolution(committeeID, resolutionID, currentVotingMemberID, newVote);
    this.setState(state => ({
      currentVotingMemberID: nextMemberID,
      votingHistory: [...state.votingHistory, {
        memberID: currentVotingMemberID,
        previousVote,
        previousCurrentMemberID: currentVotingMemberID,
        previousPage: state.votingPage
      }],
      votingPage: nextIndex >= 0
        ? Math.floor(nextIndex / RESOLUTION_VOTING_PAGE_SIZE)
        : state.votingPage
    }));
  };

  undoVote = () => {
    const previous = this.state.votingHistory[this.state.votingHistory.length - 1];
    if (!previous) {
      return;
    }

    const {resolutionID, committeeID} = this.props.match.params;
    voteOnResolution(committeeID, resolutionID, previous.memberID, previous.previousVote);
    this.setState(state => ({
      currentVotingMemberID: previous.previousCurrentMemberID,
      votingHistory: state.votingHistory.slice(0, -1),
      votingPage: previous.previousPage
    }));
  };

  selectVotingMember = (memberID: MemberID) => {
    const member = this.state.committee?.members?.[memberID];
    if (!member?.present || !canVote(member)) {
      return;
    }

    const votingMemberIDs = this.sortedVotingMemberIDs();
    this.setState({
      currentVotingMemberID: memberID,
      votingPage: Math.floor(votingMemberIDs.indexOf(memberID) / RESOLUTION_VOTING_PAGE_SIZE)
    });
  };

  changeVotingPage = (_event: React.MouseEvent<HTMLAnchorElement>, data: PaginationProps) => {
    this.setState({votingPage: Number(data.activePage) - 1});
  };

  renderVotingMember = (memberID: MemberID, member: MemberData, vote?: Vote) => {
    const voteClass = !member.present
      ? 'vote-absent'
      : vote === Vote.For
        ? 'vote-for'
        : vote === Vote.Against
          ? 'vote-against'
          : vote === Vote.Abstaining
            ? 'vote-abstaining'
            : 'vote-unset';
    const current = memberID === this.state.currentVotingMemberID;

    return (
      <button
        aria-label={`${displayMemberName(member.name)}${member.present ? '' : `: ${t('Absent')}`}`}
        className={`resolution-voting-member ${voteClass}${current ? ' is-current' : ''}`}
        disabled={!member.present}
        key={memberID}
        onClick={() => this.selectVotingMember(memberID)}
        type="button"
      >
        <span className="resolution-voting-status-light" aria-hidden="true" />
        <span className="resolution-voting-member-name">
          {displayMemberName(member.name)}
          {member.voting && <Popup
            trigger={<Label circular size="mini" color="purple">V</Label>}
            content={t('Voting')}
          />}
          {!member.present && <Label basic size="mini">{t('Absent')}</Label>}
        </span>
      </button>
    );
  };

  renderMajoritySelector = (resolution?: ResolutionData) => {
    const resolutionFref = this.recoverResolutionFref();

    return (
      <Dropdown
        placeholder={t('Select majority type')}
        search
        options={MAJORITY_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
        onChange={dropdownHandler<ResolutionData>(resolutionFref, 'requiredMajority')}
        value={resolution ? resolution.requiredMajority : DEFAULT_RESOLUTION.requiredMajority}
      />
    )

  }

  renderVoting = (resolution?: ResolutionData) => {
    const { renderVotingMember } = this;
    const { committee } = this.state;

    const members = (committee ? committee.members : undefined) || {};
    const votes = (resolution ? resolution.votes : undefined) || {};

    const sortedCanVote = _.chain(members)
      .keys()
      .filter(key => canVote(members[key]))
      .sortBy((key: string) => [members[key].name])
      .value();

    const sortedPresentAndCanVote = sortedCanVote.filter(key => members[key].present);

    const vetoes = _.chain(sortedPresentAndCanVote)
      .filter((key: string) => members[key].rank === Rank.Veto && votes[key] === Vote.Against)
      .map(key => members[key])
      .value();

    const resolutionVetoed = !!vetoes[0];

    const votesByVoters = Object.keys(votes || {})
      .filter(k => sortedPresentAndCanVote.includes(k))
      .map(k => votes[k]);

    const fors = votesByVoters.filter(v => v === Vote.For).length;
    const abstains = votesByVoters.filter(v => v === Vote.Abstaining).length;
    const againsts = votesByVoters.filter(v => v === Vote.Against).length;
    const requiredMajority = resolution
      ? resolution.requiredMajority
      : DEFAULT_RESOLUTION.requiredMajority;

    const threshold = getThreshold(requiredMajority, committee, fors, againsts);
    const thresholdName = getThresholdName(requiredMajority);

    const automaticResult = requiredMajority === Majority.TwoThirdsNoAbstentions
      ? (() => {
          if (resolutionVetoed) {
            return undefined;
          }
          if (sortedPresentAndCanVote.length === 0) {
            return 'failed';
          }
          if (fors > 0 && fors >= threshold) {
            return 'passed';
          }
          const remaining = Math.max(0, sortedPresentAndCanVote.length - votesByVoters.length);
          const bestPossibleFor = fors + remaining;
          const bestCaseThreshold = Math.ceil((2 / 3) * (fors + againsts + remaining));
          return bestPossibleFor < bestCaseThreshold ? 'failed' : undefined;
        })()
      : getAutomaticVoteResult({
          eligibleVoters: sortedPresentAndCanVote.length,
          votesFor: fors,
          votesCast: votesByVoters.length,
          threshold,
          vetoed: resolutionVetoed
        });
    const resolutionPassed = automaticResult === 'passed';
    const resolutionFailed = automaticResult === 'failed';

    const {presentNo, simpleMajority, twoThirdsMajority} = makeCommitteeStats(committee);
    const totalPages = Math.max(1, Math.ceil(sortedCanVote.length / RESOLUTION_VOTING_PAGE_SIZE));
    const votingPage = Math.min(this.state.votingPage, totalPages - 1);
    const pageMemberIDs = sortedCanVote.slice(
      votingPage * RESOLUTION_VOTING_PAGE_SIZE,
      (votingPage + 1) * RESOLUTION_VOTING_PAGE_SIZE
    );
    const currentMemberID = this.state.currentVotingMemberID;
    const currentMember = currentMemberID ? members[currentMemberID] : undefined;

    return (
      <>
        <Segment className="resolution-voting-board" loading={!resolution}>
          <div className="resolution-voting-dashboard">
            <aside className="resolution-voting-metrics resolution-voting-thresholds">
              <div className="resolution-voting-metric metric-present">
                <span>{t('Present')}</span>
                <strong>{presentNo}</strong>
              </div>
              <div className="resolution-voting-metric metric-simple">
                <span>{t('Simple majority')}</span>
                <strong>{simpleMajority}</strong>
              </div>
              <div className="resolution-voting-metric metric-two-thirds">
                <span>{t('Two-thirds majority')}</span>
                <strong>{twoThirdsMajority}</strong>
              </div>
            </aside>

            <div className="resolution-voting-matrix-wrap">
              <div className="resolution-voting-grid">
                {pageMemberIDs.map(memberID => renderVotingMember(
                  memberID,
                  members[memberID],
                  votes[memberID]
                ))}
              </div>
              {totalPages > 1 && <Pagination
                activePage={votingPage + 1}
                boundaryRange={1}
                className="resolution-voting-pagination"
                ellipsisItem={null}
                onPageChange={this.changeVotingPage}
                siblingRange={1}
                totalPages={totalPages}
              />}
            </div>

            <aside className="resolution-voting-metrics resolution-vote-counts">
              <div className="resolution-voting-metric metric-for">
                <span>{t('yes')}</span>
                <strong>{fors}</strong>
              </div>
              <div className="resolution-voting-metric metric-against">
                <span>{t('no')}</span>
                <strong>{againsts}</strong>
              </div>
              <div className="resolution-voting-metric metric-abstaining">
                <span>{t('abstaining')}</span>
                <strong>{abstains}</strong>
              </div>
            </aside>
          </div>

          <div className="resolution-voting-current">
            <div className="resolution-voting-current-label">{t('Now voting')}</div>
            <Header as="h2">
              {currentMember ? displayMemberName(currentMember.name) : t('No eligible delegations')}
            </Header>
            <div className="resolution-voting-actions">
              <div className="resolution-voting-primary-actions">
                <Button
                  positive
                  content={t('yes')}
                  disabled={!currentMember}
                  icon="plus"
                  onClick={() => this.setCurrentVote(Vote.For)}
                />
                <Button
                  negative
                  content={t('no')}
                  disabled={!currentMember}
                  icon="remove"
                  onClick={() => this.setCurrentVote(Vote.Against)}
                />
                <Button
                  color="yellow"
                  content={t('abstaining')}
                  disabled={!currentMember || currentMember.voting}
                  icon="minus"
                  onClick={() => this.setCurrentVote(Vote.Abstaining)}
                />
              </div>
              <Button
                basic
                className="resolution-voting-undo"
                content={t('Undo')}
                disabled={this.state.votingHistory.length === 0}
                icon="undo"
                onClick={this.undoVote}
              />
            </div>
          </div>

          <div className="resolution-voting-outcome">
          {resolutionPassed && <Statistic className="resolution-result outcome-passed">
            <Statistic.Value>{t('Passed')}</Statistic.Value>
            <Statistic.Label>{t('{votes} clears the required {thresholdName} of {threshold}', { votes: fors, thresholdName: t(thresholdName), threshold })}</Statistic.Label>
            {requiredMajority === Majority.TwoThirdsNoAbstentions &&
              <Statistic.Label>{t("Further votes may change the result from 'Passed'")}</Statistic.Label>
            }
          </Statistic>}
          {resolutionFailed && <Statistic className="resolution-result outcome-failed">
            <Statistic.Value>{t('Failed')}</Statistic.Value>
            <Statistic.Label>{t('There are insufficient votes remaining to achieve a {thresholdName}', { thresholdName: t(thresholdName) })}</Statistic.Label>
          </Statistic>}
          {resolutionVetoed && <Statistic>
            <Statistic.Value>{t('Vetoed')}</Statistic.Value>
            <Statistic.Label>{t('{name} was the first to veto the resolution', { name: displayMemberName(vetoes[0].name) })}</Statistic.Label>
          </Statistic>}
          </div>
          <Segment secondary textAlign="center">
            {this.renderMajoritySelector(resolution)}
          </Segment>
        </Segment>
      </>
    );
  }

  renderMeta = (resolution?: ResolutionData) => {
    const resolutionFref = this.recoverResolutionFref();
    const { handleProvisionResolution, amendmentsArePublic } = this;

    const memberOptions = recoverAttendanceMemberOptions(this.state.committee);

    // TFW no null coalescing operator 
    const proposer = resolution
      ? resolution.proposer
      : undefined;

    const seconder = resolution
      ? resolution.seconder
      : undefined;

    const hasIdenticalProposerSeconder = proposer && seconder ? proposer === seconder : false;
    const proposerPresent = isMemberPresent(this.state.committee?.members, proposer);
    const seconderPresent = isMemberPresent(this.state.committee?.members, seconder);

    const proposerTree = (
      <Form.Dropdown
        key="proposer"
        icon="search"
        value={proposer ? nameToMemberOption(proposer).key : undefined}
        error={!proposer || !proposerPresent || hasIdenticalProposerSeconder}
        loading={!resolution}
        search
        selection
        fluid
        onChange={memberDropdownHandler<ResolutionData>(resolutionFref, 'proposer', memberOptions)}
        options={localizedMemberOptions(memberOptions)}
        label={t('Resolution proposer')}
      />
    );

    const seconderTree = (
      <Form.Dropdown
        key="seconder"
        loading={!resolution}
        icon="search"
        value={seconder ? nameToMemberOption(seconder).key : undefined}
        error={!seconder || !seconderPresent || hasIdenticalProposerSeconder}
        search
        selection
        fluid
        onChange={memberDropdownHandler<ResolutionData>(resolutionFref, 'seconder', memberOptions)}
        options={localizedMemberOptions(memberOptions)}
        label={t('Resolution seconder')}
      />
    );

    const hasError = hasIdenticalProposerSeconder || !proposerPresent || !seconderPresent;

    const provisionTree = this.hasLinkedCaucus(resolution) ? (
      <Form.Button
        loading={!resolution}
        disabled={!resolution}
        onClick={() => this.gotoCaucus(resolution!.caucus)}
      >
        {t('Associated caucus')}
        <Icon name="arrow right" />
      </Form.Button>
    ) : (
        // if there's no linked caucus
        <Form.Button
          loading={!resolution}
          disabled={!resolution || !resolution.proposer || !resolution.seconder || hasError}
          onClick={() => handleProvisionResolution(resolution!)}
        >
          {t('Provision caucus')}
        </Form.Button>
      );

    return (
      <React.Fragment>
        <Segment attached={amendmentsArePublic(resolution) ? 'top' : undefined}>
          <Form error={hasError}>
            {proposerTree}
            {seconderTree}
            <IdenticalProposerSeconder />
            {provisionTree}
            <Form.Checkbox
              label={t('Delegates can amend')}
              indeterminate={!resolution}
              toggle
              checked={amendmentsArePublic(resolution)}
              onChange={checkboxHandler<ResolutionData>(resolutionFref, 'amendmentsArePublic')}
            />
          </Form>
          {this.renderAdditionalOptions()}
        </Segment>
        {amendmentsArePublic(resolution) && <DelegatesCanAmendNotice />}
      </React.Fragment>
    );
  }

  renderText = (resolution?: ResolutionData) => {
    const resolutionFref = this.recoverResolutionFref();

    return (
      <Form>
        <TextArea
          value={resolution ? resolution.link : ''}
          autoHeight
          onChange={textAreaHandler<ResolutionData>(resolutionFref, 'link')}
          attatched="top"
          rows={3}
          placeholder={t('Resolution text')}
        />
      </Form>
    )
  }

  renderHeader = (resolution?: ResolutionData) => {
    const resolutionFref = this.recoverResolutionFref();

    const statusDropdown = (
      <Dropdown
        value={resolution ? resolution.status : ResolutionStatus.Introduced}
        options={RESOLUTION_STATUS_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
        onChange={dropdownHandler<ResolutionData>(resolutionFref, 'status')}
        loading={!resolution}
      />
    );

    return (
      <Input
        value={resolution ? localizeGeneratedName(resolution.name) : ''}
        label={statusDropdown}
        loading={!resolution}
        labelPosition="right"
        onChange={fieldHandler<ResolutionData>(resolutionFref, 'name')}
        attatched="top"
        size="massive"
        fluid
        placeholder={t('Set resolution name')}
      />
    );
  }

  renderAmendments = (amendments: Record<AmendmentID, AmendmentData>) => {
    const { renderAmendment, recoverResolutionFref } = this;

    const resolutionRef = recoverResolutionFref();

    return Object.keys(amendments).reverse().map(key => {
      return renderAmendment(key, amendments[key], resolutionRef.child('amendments').child(key));
    });
  }

  renderAdditionalOptions = () => {
    return  (
      <Dropdown
        text={t('More options')}
        className='icon'
      >
      <Dropdown.Menu>
        <DeleteResolutionModal onConfirm={() => this.recoverResolutionFref().remove()} />
      </Dropdown.Menu>
    </Dropdown>)
  }

  renderAmendmentsGroup = (resolution?: ResolutionData) => {
    const { renderAmendments, handlePushAmendment } = this;
    const amendments = resolution ? resolution.amendments : undefined;

    const adder = (
      <Card>
        {/* <Card.Content> */}
        <Button
          icon="plus"
          primary
          fluid
          basic
          onClick={handlePushAmendment}
        />
        {/* </Card.Content> */}
      </Card>
    );

    return (
      <Card.Group
        itemsPerRow={1}
      >
        {adder}
        {renderAmendments(amendments || {} as Record<string, AmendmentData>)}
      </Card.Group>
    );
  }

  hasLinkedCaucus = (resolution?: ResolutionData): boolean => {
    return resolution
      ? !!resolution.caucus
      : false;
  }

  amendmentsArePublic = (resolution?: ResolutionData): boolean => {
    return resolution ? resolution.amendmentsArePublic : false;
  }

  renderFeed = () => {
    const resolutionID: ResolutionID = this.props.match.params.resolutionID;

    return <Files {...this.props} forResolution={resolutionID} />;
  }

  onTabChange = (event: React.MouseEvent<HTMLDivElement>, data: TabProps) => {
    const { committeeID, resolutionID } = this.props.match.params;

    // @ts-ignore
    const tab = TAB_ORDER[data.activeIndex];

    if (tab) {
      this.props.history
        .push(`/committees/${committeeID}/resolutions/${resolutionID}/${tab}`);
    } else {
      this.props.history
        .push(`/committees/${committeeID}/resolutions/${resolutionID}`);
    }
  }

  renderResolution = (resolution?: ResolutionData) => {
    const { renderAmendmentsGroup, renderVoting, renderFeed, renderText } = this;
    const { tab } = this.props.match.params;
    const isVotingTab = tab === 'voting';

    let index = TAB_ORDER.findIndex(x => x === tab)
    if (index === -1) {
      index = 0
    }

    const panes = [
      {
        menuItem: t('Feed'),
        render: () => <Tab.Pane>{renderFeed()}</Tab.Pane>
      }, {
        menuItem: t('Text'),
        render: () => <Tab.Pane>{renderText(resolution)}</Tab.Pane>
      }, {
        menuItem: t('Amendments'),
        render: () => <Tab.Pane>{renderAmendmentsGroup(resolution)}</Tab.Pane>
      }, {
        menuItem: t('Voting'),
        render: () => <Tab.Pane>{renderVoting(resolution)}</Tab.Pane>
      }
    ];

    return (
      <Container
        className={isVotingTab ? 'resolution-page resolution-voting-page' : 'resolution-page'}
        fluid={isVotingTab}
        style={{ 'padding-bottom': '2em' }}
      >
        <Helmet>
          <title>{`${localizeGeneratedName(resolution?.name ?? '')} - Quorum`}</title>
        </Helmet>
        <Grid columns="equal" stackable>
          <Grid.Row>
            <Grid.Column>
              {this.renderHeader(resolution)}
            </Grid.Column>
          </Grid.Row>
          <Grid.Row>
            <Grid.Column width={isVotingTab ? 16 : 11}>
              <Tab panes={panes} onTabChange={this.onTabChange} activeIndex={index}/>
            </Grid.Column>
            {!isVotingTab && <Grid.Column width={5}>
              {this.renderMeta(resolution)}
            </Grid.Column>}
          </Grid.Row>
        </Grid >
      </Container>
    );
  }

  render() {
    const { committee, loading } = this.state;
    const resolutionID: ResolutionID = this.props.match.params.resolutionID;

    const resolutions = committee ? committee.resolutions : {};
    const resolution = (resolutions || {})[resolutionID];

    if (!loading && !resolution) {
      return (
        <Container text style={{ 'padding-bottom': '2em' }}>
          <NotFound item="resolution" id={resolutionID} />
        </Container>
      );
    } else {
      return this.renderResolution(resolution);
    }
  }
}

import * as React from 'react';
import firebase from 'firebase/compat/app';
import {RouteComponentProps} from 'react-router';
import {
  Button,
  Confirm,
  Container,
  Header,
  Icon,
  Label,
  Message,
  Pagination,
  PaginationProps,
  Segment
} from 'semantic-ui-react';
import {Helmet} from 'react-helmet';
import {CommitteeData} from '../models/committee';
import {CommitteeStatsTable, makeCommitteeStats} from '../modules/committee-stats';
import {displayMemberName, MemberData, MemberFlag, MemberID} from '../modules/member';
import {URLParameters} from '../types';
import {t} from '../i18n';

export const ROLL_CALL_PAGE_SIZE = 18;

interface Props extends RouteComponentProps<URLParameters> {
  committee: CommitteeData;
  fref: firebase.database.Reference;
}

interface RollCallSnapshot {
  called: MemberID[];
  currentMemberID?: MemberID;
  page: number;
  presence: Record<MemberID, boolean>;
}

interface State extends RollCallSnapshot {
  history: RollCallSnapshot[];
  resetConfirmationOpen: boolean;
}

function orderedMembers(committee: CommitteeData): Array<[MemberID, MemberData]> {
  return Object.entries(committee.members || {})
    .sort(([, first], [, second]) => first.name.localeCompare(second.name, 'en'));
}

export function nextUncalledMemberID(
  memberIDs: MemberID[],
  calledMemberIDs: MemberID[],
  currentMemberID: MemberID
): MemberID | undefined {
  const called = new Set(calledMemberIDs);
  const currentIndex = memberIDs.indexOf(currentMemberID);
  const afterCurrent = memberIDs.slice(currentIndex + 1).find(id => !called.has(id));

  return afterCurrent ?? memberIDs.find(id => !called.has(id));
}

export default class RollCall extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    const members = orderedMembers(props.committee);
    const memberIDs = members.map(([id]) => id);
    const called = Object.keys(props.committee.rollCall?.called || {})
      .filter(id => memberIDs.includes(id));
    const savedCurrentMemberID = props.committee.rollCall?.currentMemberID;
    const currentMemberID = savedCurrentMemberID && memberIDs.includes(savedCurrentMemberID)
      ? savedCurrentMemberID
      : memberIDs.find(id => !called.includes(id));
    this.state = {
      called,
      currentMemberID,
      history: [],
      page: currentMemberID
        ? Math.floor(memberIDs.indexOf(currentMemberID) / ROLL_CALL_PAGE_SIZE)
        : 0,
      presence: Object.fromEntries(members.map(([id, member]) => [id, member.present])),
      resetConfirmationOpen: false
    };
  }

  componentDidUpdate(previousProps: Props) {
    const previousMembers = orderedMembers(previousProps.committee);
    const members = orderedMembers(this.props.committee);
    const previousSignature = JSON.stringify({
      members: previousMembers.map(([id, member]) => [id, member.name, member.present]),
      rollCall: previousProps.committee.rollCall
    });
    const signature = JSON.stringify({
      members: members.map(([id, member]) => [id, member.name, member.present]),
      rollCall: this.props.committee.rollCall
    });

    if (previousSignature !== signature) {
      const memberIDs = members.map(([id]) => id);
      const validIDs = new Set(memberIDs);
      this.setState(state => {
        const called = Object.keys(this.props.committee.rollCall?.called || {})
          .filter(id => validIDs.has(id));
        const presence = Object.fromEntries(members.map(([id, member]) => [id, member.present]));
        const savedCurrentMemberID = this.props.committee.rollCall?.currentMemberID;
        const currentMemberID = savedCurrentMemberID && validIDs.has(savedCurrentMemberID)
          ? savedCurrentMemberID
          : memberIDs.find(id => !called.includes(id));
        const totalPages = Math.max(1, Math.ceil(memberIDs.length / ROLL_CALL_PAGE_SIZE));
        const currentIndex = currentMemberID ? memberIDs.indexOf(currentMemberID) : -1;

        return {
          called,
          currentMemberID,
          page: currentIndex >= 0
            ? Math.floor(currentIndex / ROLL_CALL_PAGE_SIZE)
            : Math.min(state.page, totalPages - 1),
          presence
        };
      });
    }
  }

  snapshot = (state: State): RollCallSnapshot => ({
    called: [...state.called],
    currentMemberID: state.currentMemberID,
    page: state.page,
    presence: {...state.presence}
  });

  writeUpdates = (updates: Record<string, boolean | string | null>) => {
    if (Object.keys(updates).length > 0) {
      this.props.fref.update(updates);
    }
  };

  markMember = (memberID: MemberID, present: boolean, advance: boolean) => {
    const memberIDs = orderedMembers(this.props.committee).map(([id]) => id);
    const called = [...new Set([...this.state.called, memberID])];
    const presence = {...this.state.presence, [memberID]: present};
    const nextMemberID = advance
      ? nextUncalledMemberID(memberIDs, called, memberID)
      : memberID;
    const nextIndex = nextMemberID ? memberIDs.indexOf(nextMemberID) : -1;

    this.setState(state => ({
      called,
      currentMemberID: nextMemberID,
      history: [...state.history, this.snapshot(state)],
      page: nextIndex >= 0 ? Math.floor(nextIndex / ROLL_CALL_PAGE_SIZE) : state.page,
      presence
    }));

    this.writeUpdates({
      [`members/${memberID}/present`]: present,
      [`rollCall/called/${memberID}`]: true,
      'rollCall/currentMemberID': nextMemberID ?? null
    });
  };

  markCurrent = (present: boolean) => {
    if (this.state.currentMemberID) {
      this.markMember(this.state.currentMemberID, present, true);
    }
  };

  toggleMember = (memberID: MemberID) => {
    const wasCalled = this.state.called.includes(memberID);
    const present = wasCalled ? !this.state.presence[memberID] : true;
    this.markMember(memberID, present, false);
  };

  undo = () => {
    const previous = this.state.history[this.state.history.length - 1];
    if (!previous) {
      return;
    }

    const updates = Object.keys(this.state.presence).reduce<Record<string, boolean | string | null>>((result, id) => {
      if (previous.presence[id] !== this.state.presence[id]) {
        result[`members/${id}/present`] = previous.presence[id];
      }
      return result;
    }, {});
    const calledIDs = new Set([...this.state.called, ...previous.called]);
    calledIDs.forEach(id => {
      const wasCalled = previous.called.includes(id);
      const isCalled = this.state.called.includes(id);
      if (wasCalled !== isCalled) {
        updates[`rollCall/called/${id}`] = wasCalled ? true : null;
      }
    });
    updates['rollCall/currentMemberID'] = previous.currentMemberID ?? null;

    this.writeUpdates(updates);
    this.setState(state => ({
      ...previous,
      history: state.history.slice(0, -1),
      resetConfirmationOpen: false
    }));
  };

  reset = () => {
    const members = orderedMembers(this.props.committee);
    const presence = Object.fromEntries(members.map(([id]) => [id, false]));
    const updates: Record<string, boolean | string | null> = Object.fromEntries(
      members.map(([id]) => [`members/${id}/present`, false])
    );
    updates['rollCall/called'] = null;
    updates['rollCall/currentMemberID'] = members[0]?.[0] ?? null;

    this.writeUpdates(updates);
    this.setState(state => ({
      called: [],
      currentMemberID: members[0]?.[0],
      history: [...state.history, this.snapshot(state)],
      page: 0,
      presence,
      resetConfirmationOpen: false
    }));
  };

  changePage = (_event: React.MouseEvent<HTMLAnchorElement>, data: PaginationProps) => {
    this.setState({page: Number(data.activePage) - 1});
  };

  gotoMotions = () => {
    const {committeeID} = this.props.match.params;
    this.props.history.push(`/committees/${committeeID}/motions`);
  };

  committeeWithRollCallPresence = (): CommitteeData => {
    const members = Object.fromEntries(
      orderedMembers(this.props.committee).map(([id, member]) => [
        id,
        {...member, present: this.state.presence[id] ?? member.present}
      ])
    );

    return {...this.props.committee, members};
  };

  renderMember = ([id, member]: [MemberID, MemberData]) => {
    const called = this.state.called.includes(id);
    const status = !called ? 'uncalled' : this.state.presence[id] ? 'present' : 'absent';
    const statusLabel = status === 'uncalled'
      ? t('Not called')
      : status === 'present'
        ? t('Present')
        : t('Absent');
    const current = id === this.state.currentMemberID;

    return (
      <button
        aria-label={`${displayMemberName(member.name)}: ${statusLabel}`}
        aria-pressed={called ? this.state.presence[id] : undefined}
        className={`roll-call-member status-${status}${current ? ' is-current' : ''}`}
        key={id}
        onClick={() => this.toggleMember(id)}
        type="button"
      >
        <span className="roll-call-status-light" aria-hidden="true" />
        <span className="roll-call-member-name">{displayMemberName(member.name)}</span>
      </button>
    );
  };

  render() {
    const members = orderedMembers(this.props.committee);
    const totalPages = Math.max(1, Math.ceil(members.length / ROLL_CALL_PAGE_SIZE));
    const page = Math.min(this.state.page, totalPages - 1);
    const pageMembers = members.slice(
      page * ROLL_CALL_PAGE_SIZE,
      (page + 1) * ROLL_CALL_PAGE_SIZE
    );
    const currentMember = members.find(([id]) => id === this.state.currentMemberID)?.[1];
    const complete = members.length > 0 && this.state.called.length === members.length;
    const summaryCommittee = this.committeeWithRollCallPresence();
    const {presentNo, simpleMajority, twoThirdsMajority} = makeCommitteeStats(summaryCommittee);

    return (
      <Container fluid className="roll-call-page">
        <Helmet>
          <title>{`${t('Roll call')} - Quorum`}</title>
        </Helmet>

        <div className="roll-call-heading">
          <Header as="h1">{t('Roll call')}</Header>
          <Label basic size="large">
            {t('{called} of {total} called', {
              called: this.state.called.length,
              total: members.length
            })}
          </Label>
        </div>

        {members.length === 0
          ? <Message warning content={t('Add at least one committee member to proceed')} />
          : <>
            <Segment className="roll-call-board">
              <div className="roll-call-legend" aria-label={t('Status legend')}>
                <span><i className="status-uncalled" />{t('Not called')}</span>
                <span><i className="status-absent" />{t('Absent')}</span>
                <span><i className="status-present" />{t('Present')}</span>
              </div>

              <div className="roll-call-grid">
                {pageMembers.map(this.renderMember)}
              </div>

              {totalPages > 1 && <Pagination
                activePage={page + 1}
                boundaryRange={1}
                className="roll-call-pagination"
                ellipsisItem={null}
                onPageChange={this.changePage}
                siblingRange={1}
                totalPages={totalPages}
              />}
            </Segment>

            <Segment className="roll-call-current" textAlign="center">
              {currentMember
                ? <>
                  <div className="roll-call-current-label">{t('Now calling')}</div>
                  <Header as="h2">
                    <MemberFlag member={currentMember} />
                    <span className="roll-call-current-name">{displayMemberName(currentMember.name)}</span>
                  </Header>
                </>
                : <Header as="h2" color="green">
                  {t('Roll call complete')}
                </Header>}

              <div className="roll-call-actions">
                <Button
                  positive
                  icon="check"
                  content={t('Present')}
                  disabled={!this.state.currentMemberID}
                  onClick={() => this.markCurrent(true)}
                />
                <Button
                  negative
                  icon="close"
                  content={t('Absent')}
                  disabled={!this.state.currentMemberID}
                  onClick={() => this.markCurrent(false)}
                />
                <Button
                  basic
                  icon="undo"
                  content={t('Undo')}
                  disabled={this.state.history.length === 0}
                  onClick={this.undo}
                />
                <Button
                  basic
                  color="orange"
                  icon="refresh"
                  content={t('Reset')}
                  onClick={() => this.setState({resetConfirmationOpen: true})}
                />
              </div>
            </Segment>

            {complete && <Segment className="roll-call-summary">
              <Header as="h2">{t('Attendance and thresholds')}</Header>
              <div className="roll-call-summary-highlights">
                <div className="roll-call-summary-highlight highlight-present">
                  <span className="roll-call-summary-label">{t('Present')}</span>
                  <strong>{presentNo}</strong>
                </div>
                <div className="roll-call-summary-highlight highlight-two-thirds">
                  <span className="roll-call-summary-label">{t('Two-thirds majority')}</span>
                  <strong>{twoThirdsMajority}</strong>
                </div>
                <div className="roll-call-summary-highlight highlight-simple-majority">
                  <span className="roll-call-summary-label">{t('Simple majority')}</span>
                  <strong>{simpleMajority}</strong>
                </div>
              </div>
              <CommitteeStatsTable
                verbose={true}
                data={summaryCommittee}
                hiddenRows={['present', 'two-thirds-majority']}
              />
              <Button primary fluid size="large" onClick={this.gotoMotions}>
                {t('Go to motions')}
                <Icon name="arrow right" />
              </Button>
            </Segment>}
          </>}

        <Confirm
          open={this.state.resetConfirmationOpen}
          header={t('Reset roll call?')}
          content={t('This will clear every roll-call status and mark all delegations absent.')}
          cancelButton={t('Cancel')}
          confirmButton={t('Reset')}
          onCancel={() => this.setState({resetConfirmationOpen: false})}
          onConfirm={this.reset}
        />
      </Container>
    );
  }
}

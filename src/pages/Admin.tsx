import * as React from 'react';
import firebase from 'firebase/compat/app';
import {
  MemberData,
  MemberID,
  Rank,
  canonicalCountryName,
  displayMemberName,
  MemberFlag,
  nameToMemberOption,
  MemberOption,
  nameToCountryOption,
  searchCountryOptions
} from '../modules/member';
import { Dropdown, Table, Button, Checkbox,
  CheckboxProps, DropdownProps, ButtonProps, Container, Message, Icon, Grid } from 'semantic-ui-react';
import { checkboxHandler, dropdownHandler } from '../modules/handlers';
import { makeDropdownOption } from '../utils';
import _ from 'lodash';
import { URLParameters } from '../types';
import { RouteComponentProps } from 'react-router';
import { CommitteeSetupStatsTable } from '../modules/committee-stats';
import {CommitteeData, CommitteeID, pushMember} from '../models/committee';
import { TemplateAdder } from '../components/template';
import {COUNTRY_OPTIONS} from "../constants";
import { Helmet } from 'react-helmet';
import { t } from '../i18n';
import {
  CountryFlag,
  CountryTemplateChoice,
  CountryTemplatePicker
} from '../components/country-template';
import {CountryData, countryDisplayName, isoCodeToEmoji} from '../models/country-template';

interface Props extends RouteComponentProps<URLParameters> {
  committee: CommitteeData;
  fref: firebase.database.Reference;
}

interface State {
  member: MemberOption;
  options: MemberOption[];
  countryTemplate?: CountryTemplateChoice;
  rank: Rank;
  voting: MemberData['voting'];
}

type CountryMemberOption = MemberOption & {memberName: string; country?: CountryData};

const customFlagSnapshot = (country?: CountryData): MemberData['flag'] => {
  if (!country?.flag?.value) return undefined;
  const builtInCountry = nameToCountryOption(country.name);
  if (country.flag.type === 'emoji' && builtInCountry
    && country.flag.value === isoCodeToEmoji(builtInCountry.value)) return undefined;
  return country.flag;
};

const RANK_OPTIONS = [
  Rank.Standard,
  Rank.Veto,
  Rank.NGO,
  Rank.Observer
].map(makeDropdownOption);

export default class Admin extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    this.state = {
      member: COUNTRY_OPTIONS[0],
      options: [],
      rank: Rank.Standard,
      voting: false
    };
  }

  renderMemberItem = (id: MemberID, member: MemberData, fref: firebase.database.Reference) => {
    return (
      <Table.Row key={id}>
        <Table.Cell>
          <MemberFlag member={member} />
          {displayMemberName(member.name)}
        </Table.Cell>
        <Table.Cell>
          <Dropdown
            search
            selection
            fluid
            options={RANK_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
            onChange={dropdownHandler<MemberData>(fref, 'rank')}
            value={member.rank}
          />
        </Table.Cell>
        <Table.Cell collapsing>
          <Checkbox 
            toggle 
            checked={member.voting} 
            onChange={checkboxHandler<MemberData>(fref, 'voting')} 
          />
        </Table.Cell>
        <Table.Cell collapsing>
          <Button
            className="members__button--remove-member"
            icon="trash"
            negative
            basic
            onClick={() => fref.remove()}
          />
        </Table.Cell>
      </Table.Row>
    );
  }

  canPushMember = (member: MemberOption) => { 
    const members = this.props.committee.members || {};
    const memberNames = Object.keys(members).map(id => 
      canonicalCountryName(members[id].name)
    );

    return !_.includes(memberNames, canonicalCountryName(member.text));
  }

  pushSelectedMember = (event: React.MouseEvent<HTMLButtonElement>, data: ButtonProps) => {
    event.preventDefault();

    const committeeID: CommitteeID = this.props.match.params.committeeID;
    const country = this.countryOptions().find(option => option.value === this.state.member.value)?.country;
    const flag = customFlagSnapshot(country);
    const member: MemberData = {
      name: this.state.member.text,
      rank: this.state.rank,
      present: false,
      voting: this.state.voting,
      ...(flag ? {flag} : {})
    };

    pushMember(committeeID, member);
  }

  setMember = (event: React.SyntheticEvent<HTMLElement>, data: DropdownProps) => {
    const { options: newOptions } = this.state;
    const availableOptions: MemberOption[] = [...newOptions, ...this.countryOptions()];
    const newMember = availableOptions.filter(c => c.value === data.value)[0];

    if (newMember) {
      this.setState({ member: newMember });
    }
  }

  setVoting = (event: React.FormEvent<HTMLInputElement>, data: CheckboxProps) => {
    this.setState({ voting: data.checked ?? false });
  }

  setRank = (event: React.SyntheticEvent<HTMLElement>, data: DropdownProps) => {
    this.setState({ rank: data.value as Rank ?? Rank.Standard });
  }

  handleAdd = (event: React.SyntheticEvent<HTMLElement>, data: DropdownProps) => {
    // FSM looks sorta like the UN flag
    const newMember = nameToMemberOption((data.value as number | string).toString());

    const newOptions = [newMember, ...this.state.options.filter(option => option.value !== newMember.value)];
    this.setState({ member: newMember, options: newOptions });
  }

  countryOptions = (): CountryMemberOption[] => Object.entries(
    this.state.countryTemplate?.template.countries || {}
  ).map(([id, country]) => ({
    key: `${this.state.countryTemplate?.key}:${id}`,
    value: `${this.state.countryTemplate?.key}:${id}`,
    flag: <CountryFlag country={country} />,
    text: country.name,
    memberName: country.name,
    country
  }));

  resolveCountryTemplate = (choice?: CountryTemplateChoice) => {
    this.setState({countryTemplate: choice});
    const entries = choice ? Object.entries(choice.template.countries || {}) : [];
    const selectedEntry = entries.find(([, country]) =>
      canonicalCountryName(country.name) === canonicalCountryName(this.state.member.text)
    ) || entries[0];
    const selectedCountry = selectedEntry?.[1];
    if (choice && selectedCountry) {
      this.setState({member: {
        key: `${choice.key}:${selectedEntry![0]}`,
        value: `${choice.key}:${selectedEntry![0]}`,
        flag: <CountryFlag country={selectedCountry} />,
        text: selectedCountry.name
      }});
    }
  }

  changeCountryTemplate = (choice: CountryTemplateChoice) => {
    this.resolveCountryTemplate(choice);
    this.props.fref.update({countryTemplateKey: choice.key, temporaryTemplate: true});
  }

  gotoRollCall = () => {
    const { committeeID } = this.props.match.params;

    this.props.history
      .push(`/committees/${committeeID}/roll-call`);
  }


  renderAdder() {
    const { handleAdd, setMember, setRank, setVoting } = this;
    const { voting: newMemberVoting, options: newOptions, member } = this.state;
    const countryOptions = this.countryOptions();
    const dropdownOptions = [...newOptions.map(option => ({...option, text: displayMemberName(option.text)})),
      ...countryOptions.map(option => ({...option, text: countryDisplayName(option.country!)}))];

    return (
      <Table.Row>
        <Table.HeaderCell>
          <Dropdown
            icon="search"
            className="adder__dropdown--select-member"
            placeholder={t('Select preset member')}
            search={searchCountryOptions}
            selection
            fluid
            allowAdditions
            error={!this.canPushMember(member)}
            options={dropdownOptions}
            onAddItem={handleAdd}
            onChange={setMember}
            value={member.key}
          />
        </Table.HeaderCell>
        <Table.HeaderCell>
          <Dropdown
            className="adder__dropdown--select-rank"
            search
            selection
            fluid
            options={RANK_OPTIONS.map(option => ({ ...option, text: t(String(option.text)) }))}
            onChange={setRank}
            value={this.state.rank}
          />
        </Table.HeaderCell>
        <Table.HeaderCell collapsing >
          <Checkbox 
            className="adder__checkbox--toggle-voting"
            toggle 
            checked={newMemberVoting} 
            onChange={setVoting} 
          />
        </Table.HeaderCell>
        <Table.HeaderCell>
          <Button
            className="adder__button--add-member"
            icon="plus"
            primary
            basic
            disabled={!this.canPushMember(member)}
            onClick={this.pushSelectedMember}
          />
        </Table.HeaderCell>
      </Table.Row>
    );
  }

  renderCommitteeMembers = (props: { data: CommitteeData, fref: firebase.database.Reference }) => {
    const members = this.props.committee.members || {};
    const memberItems = Object.keys(members).map(id =>
      this.renderMemberItem(id, members[id], props.fref.child('members').child(id))
    );

    return (
      <>
        <Table className="members-table" compact celled definition>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell />
              <Table.HeaderCell>{t('Rank')}</Table.HeaderCell>
              <Table.HeaderCell singleLine>{t('Must Vote')}</Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>

          <Table.Header fullWidth>
            {this.renderAdder()}
          </Table.Header>

          <Table.Body>
            {memberItems.reverse()}
          </Table.Body>
        </Table>
        {memberItems.length === 0
          ? <Message error>
            {t('Add at least one committee member to proceed')}
          </Message>
          : <Button
            as='a'
            onClick={this.gotoRollCall}
            primary
            fluid
          >
            {t('Roll call')}
              <Icon name="arrow right" />
          </Button>
        }
      </>
    );
  }

  render() {
    const { committee, fref } = this.props;

    return (
      <Container style={{ padding: '1em 0em 1.5em' }}>
        <Helmet>
          <title>{`${t('Setup')} - Quorum`}</title>
        </Helmet>
        <Grid columns="2" stackable>
          <Grid.Row>
            <Grid.Column width={9}>
              <CountryTemplatePicker
                required
                disabled={committee.temporaryTemplate === false}
                value={committee.countryTemplateKey}
                placeholder={t('Select the country template for manual setup')}
                onResolve={this.resolveCountryTemplate}
                onChange={this.changeCountryTemplate}
              />
              <TemplateAdder committeeID={this.props.match.params.committeeID} />
              {this.renderCommitteeMembers({ data: committee, fref })}
            </Grid.Column>
            <Grid.Column width={7}>
              <CommitteeSetupStatsTable data={committee} />
            </Grid.Column>
          </Grid.Row>
        </Grid >
      </Container>
    );
  }
}

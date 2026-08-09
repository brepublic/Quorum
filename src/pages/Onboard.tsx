import * as React from 'react';
import { RouteComponentProps } from 'react-router';
import firebase from 'firebase/compat/app';
import {
  Form, Grid, Header, InputOnChangeData,
  Message, Popup, Container, Segment, Icon, Menu,
} from 'semantic-ui-react';
import { Login } from '../components/auth';
import { URLParameters } from '../types';
import ConnectionStatus from '../components/ConnectionStatus';
import { logCreateCommittee } from '../modules/analytics';
import { meetId } from '../utils';
import {CommitteeData, DEFAULT_COMMITTEE, pushTemplateMembers, putCommittee} from '../models/committee';
import {TemplateChoice, TemplatePicker, TemplatePreview} from '../components/template';
import { Helmet } from 'react-helmet';
import { t } from '../i18n';
import { LanguageMenuItem } from '../i18n';
import {
  CountryTemplateChoice,
  CountryTemplatePicker
} from '../components/country-template';
import type {CountryTemplateKey} from '../models/country-template';

interface Props extends RouteComponentProps<URLParameters> {
}

interface State {
  name: string;
  topic: string;
  chair: string;
  conference: string;
  user: firebase.User | null;
  template?: TemplateChoice,
  countryTemplateKey?: CountryTemplateKey;
  countryTemplateResolved: boolean;
  committeesFref: firebase.database.Reference;
  unsubscribe?: () => void;
}

export default class Onboard extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    this.state = {
      name: '',
      topic: '',
      chair: '',
      conference: '',
      user: null,
      countryTemplateResolved: false,
      committeesFref: firebase.database().ref('committees')
    };
  }

  authStateChangedCallback = (user: firebase.User | null) => {
    this.setState({ user: user });
  }

  componentDidMount() {
    const unsubscribe = firebase.auth().onAuthStateChanged(
      this.authStateChangedCallback,
    );

    this.setState({ unsubscribe });
  }

  componentWillUnmount() {
    if (this.state.unsubscribe) {
      this.state.unsubscribe();
    }
  }

  handleInput = (event: React.SyntheticEvent<HTMLInputElement>, data: InputOnChangeData): void => {
    // XXX: Don't do stupid shit and choose form input names that don't
    // map to valid state properties
    // @ts-ignore
    this.setState({ [data.name]: data.value });
  }

  onChangeTemplate = (template?: TemplateChoice): void => {
    this.setState(old => ({
      template,
      countryTemplateKey: template?.countryTemplateKey,
      countryTemplateResolved: false,
      // don't clear the name if the template is deselected
      name: template?.name || old.name
    }));
  }

  onChangeCountryTemplate = (choice: CountryTemplateChoice): void => {
    this.setState({countryTemplateKey: choice.key, countryTemplateResolved: true});
  }

  onResolveCountryTemplate = (choice?: CountryTemplateChoice): void => {
    this.setState(({countryTemplateKey}) => ({
      countryTemplateResolved: !!choice && choice.key === countryTemplateKey
    }));
  }

  handleSubmit = () => {
    const { name, topic, chair, conference, template, countryTemplateKey, user } = this.state;

    if (user && countryTemplateKey && this.state.countryTemplateResolved) {
      const newCommittee: CommitteeData = {
        ...DEFAULT_COMMITTEE,
        name,
        topic,
        chair,
        conference,
        creatorUid: user.uid,
        countryTemplateKey,
        temporaryTemplate: !template
      };

      // We can't send `undefined` properties to Firebase or it will complain
      // so we only set this property if the template exists
      if (template) {
        newCommittee.template = template.name;
        newCommittee.templateKey = template.key;
      }

      const newCommitteeRef = putCommittee(meetId(), newCommittee)
      this.props.history.push(`/committees/${newCommitteeRef.key}`);
      logCreateCommittee(newCommitteeRef.key ?? undefined)

      if (template) {
        // Add countries as per selected templates
        pushTemplateMembers(newCommitteeRef.key!, template.members);
      }
    }
  }


  renderNewCommitteeForm = () => {
    const { user, template } = this.state;

    return (
      <React.Fragment>
        {!user && <Message
          error
          attached="top"
          content={t('Log in or create an account to continue')}
        />}
        <Segment attached={!user ? 'bottom' : undefined} >
          <Form onSubmit={this.handleSubmit}>
            <Form.Group unstackable className="template-picker-row">
              <TemplatePicker
                label={t('Template')}
                placeholder={t('Template to skip manual member creation (optional)')}
                value={template?.key}
                onChange={this.onChangeTemplate}
              />
              <Popup 
                basic 
                pinned 
                hoverable 
                position="bottom left"
                trigger={
                  <Form.Button 
                    type="button"
                    icon='question circle outline'
                  />}>
                <Popup.Content>
                  <TemplatePreview members={template?.members} />
                </Popup.Content>
              </Popup>
            </Form.Group>
            <CountryTemplatePicker
              required
              disabled={!!template}
              value={this.state.countryTemplateKey}
              placeholder={t('Select the country template for manual setup')}
              onResolve={this.onResolveCountryTemplate}
              onChange={this.onChangeCountryTemplate}
            />
            <Form.Input
              label={t('Name')}
              name="name"
              fluid
              value={this.state.name}
              required
              error={!this.state.name}
              placeholder={t('Committee name')}
              onChange={this.handleInput}
            />
            <Form.Input
              label={t('Topic')}
              name="topic"
              value={this.state.topic}
              fluid
              placeholder={t('Committee topic')}
              onChange={this.handleInput}
            />
            <Form.Input
              label={t('Conference')}
              name="conference"
              value={this.state.conference}
              fluid
              placeholder={t('Conference name')}
              onChange={this.handleInput}
            />
            <Form.Button
              primary
              fluid
              disabled={!this.state.user || this.state.name === '' || !this.state.countryTemplateResolved}
            >
              {t('Create committee')}
              <Icon name="arrow right" />
            </Form.Button>
          </Form>
        </Segment>
      </React.Fragment>
    );
  }

  render() {
    return (
      <Container style={{ padding: '1em 0em' }}>
        <Menu secondary>
          <Menu.Item as="a" href="/templates">
            <Icon name="file alternate outline" />{t('Manage templates')}
          </Menu.Item>
          <Menu.Item as="a" href="/countries">
            <Icon name="world" />{t('Country manager')}
          </Menu.Item>
          <LanguageMenuItem position="right" />
        </Menu>
        <Helmet>
          <title>{`${t('Create committee')} - Quorum`}</title>
          <meta name="description" content="Login, create an account, or create
                                      a committee with Quorum now!" />
        </Helmet>
        <ConnectionStatus />
        <Grid
          columns="equal"
          stackable
        >
          <Grid.Row>
            <Grid.Column>
              <Header as="h1" textAlign='center'>
                Quorum
              </Header>
              <Message>
                <Message.Header>{t('Browser compatibility notice')}</Message.Header>
                  <p>
                  {t('Quorum works best with newer versions of')} <a
                    href="https://www.google.com/chrome/">Google Chrome</a>
                  {t('. Use of other or older browsers has caused bugs and data loss.')}
                  </p>
              </Message>
            </Grid.Column>
          </Grid.Row>
          <Grid.Row>
            <Grid.Column>
              <Login allowNewCommittee={false} />
            </Grid.Column>
            <Grid.Column>
              {this.renderNewCommitteeForm()}
            </Grid.Column>
          </Grid.Row>
        </Grid>
      </Container>
    );
  }
}

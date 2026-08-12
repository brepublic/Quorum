import * as React from 'react';
import firebase from 'firebase/compat/app';
import { Card, Button, Confirm, Form, Message, Modal, Icon, List, Segment, Header } from 'semantic-ui-react';
import _ from 'lodash';
import Loading from './Loading';
import { logLogin } from '../modules/analytics';
import {CommitteeData, CommitteeID, deleteCommittee} from "../models/committee";
import { t } from '../i18n';

interface State {
  user?: firebase.User | null;
  email: string;
  password: string;
  error?: Error;
  loggingIn: boolean;
  unsubscribe?: () => void;
  committees?: Record<CommitteeID, CommitteeData>;
  committeePendingDeletion?: CommitteeID;
  deletingCommittee?: CommitteeID;
  deleteError?: Error;
  isAdmin?: boolean;
}

interface Props {
  allowNewCommittee?: boolean;
}

export class Login extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);

    this.state = {
      email: '',
      password: '',
      loggingIn: false,
    };
  }

  authStateChangedCallback = (user: firebase.User | null) => {
    this.setState({
      loggingIn: false,
      user,
      committees: user ? undefined : {},
      committeePendingDeletion: undefined,
      deletingCommittee: undefined,
      deleteError: undefined,
      isAdmin: user ? undefined : false,
    });

    if (user) {
      user.getIdTokenResult().then(token => {
        if (token.claims.managed !== true) {
          const error = Object.assign(new Error(t('This account was not issued by the administrator.')), {
            code: 'auth/unauthorized-account'
          });
          this.setState({error, isAdmin: false});
          firebase.auth().signOut().catch(() => undefined);
          return;
        }
        this.setState({isAdmin: token.claims.admin === true});
        firebase.database()
          .ref('committees')
          .orderByChild('creatorUid')
          .equalTo(user.uid)
          .once('value').then(committees => {
            // we need to || {} because this returns undefined when it can't find anything
            this.setState({ committees: committees.val() || {} });
          });
      }).catch(() => this.setState({isAdmin: false}));
    }
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

  logout = () => {
    firebase.auth().signOut().catch(err => {
      this.setState({ error: err });
    });
  }

  login = () => {
    const { email, password } = this.state;

    this.setState({ loggingIn: true });

    firebase.auth().signInWithEmailAndPassword(email, password).then(credential => {
      this.setState({ 
        loggingIn: false,
        email: '',
        password: ''
      });
      logLogin(credential.user?.uid)
    }).catch(err => {
      this.setState({ loggingIn: false, error: err });
    });
  }

  dismissError = () => {
    this.setState({ error: undefined });
  }

  setEmail = (e: React.FormEvent<HTMLInputElement>) => {
    this.setState({ email: e.currentTarget.value })
  }

  setPassword = (e: React.FormEvent<HTMLInputElement>) => {
    this.setState({ password: e.currentTarget.value })
  }

  requestCommitteeDeletion = (committeeID: CommitteeID) => {
    this.setState({committeePendingDeletion: committeeID, deleteError: undefined});
  }

  cancelCommitteeDeletion = () => {
    this.setState({committeePendingDeletion: undefined});
  }

  confirmCommitteeDeletion = async () => {
    const committeeID = this.state.committeePendingDeletion;
    if (!committeeID) {
      return;
    }

    this.setState({
      committeePendingDeletion: undefined,
      deletingCommittee: committeeID,
      deleteError: undefined
    });

    try {
      await deleteCommittee(committeeID);
      this.setState(previous => {
        const committees = {...(previous.committees || {})};
        delete committees[committeeID];
        return {committees, deletingCommittee: undefined};
      });
    } catch (error) {
      this.setState({
        deletingCommittee: undefined,
        deleteError: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  renderCommittee = (committeeID: CommitteeID, committee: CommitteeData) => {
    const deleting = this.state.deletingCommittee === committeeID;

    return (
      <List.Item key={committeeID}>
        <List.Content floated="right">
          <Button
            basic
            negative
            compact
            icon="trash"
            loading={deleting}
            disabled={!!this.state.deletingCommittee}
            aria-label={t('Delete committee {name}', {name: committee.name})}
            title={t('Delete committee')}
            onClick={() => this.requestCommitteeDeletion(committeeID)}
          />
        </List.Content>
        <List.Content>
          <List.Header as="a" href={`/committees/${committeeID}`}>
            {committee.name}
          </List.Header>
          <List.Description>
            {committee.topic}
          </List.Description>
        </List.Content>
      </List.Item>
    );
  }

  renderNewCommitteeButton = () => {
    return (
      <List.Item key={'add'}>
        <List.Content>
          <List.Header as="a" href={'/onboard'}>
            <Icon name="plus" />{t('Create new committee')}
          </List.Header>
        </List.Content>
      </List.Item>
    );
  }

  renderCommittees = () => {
    const { renderCommittee } = this;
    const { committees } = this.state;

    const defaulted = committees || {} as Record<CommitteeID, CommitteeData>;
    const owned = _.keys(defaulted);

    return (owned.length > 0) ? 
    (
      <List relaxed>
        {owned.map(k => renderCommittee(k, defaulted[k]))}
      </List>
    ) : (
      <Header as='h4'>{t('No committees created')}
        <Header.Subheader>
          {t("Create a new committee and it'll appear here!")}
        </Header.Subheader>
      </Header>
    );
  }

  renderError = () => {
    const { dismissError } = this;

    const err = this.state.error;
    const code = (err as Error & { code?: string } | undefined)?.code;
    const translatedMessage = code ? t(code) : undefined;
    const hasTranslatedMessage = !!code && translatedMessage !== code;
    
    return (
      <Message
        key="error"
        error
        onDismiss={dismissError}
      >
        <Message.Header>{hasTranslatedMessage ? t('Authentication error') : err ? err.name : ''}</Message.Header>
        <Message.Content>{hasTranslatedMessage ? translatedMessage : err ? err.message : ''}</Message.Content>
      </Message>
    );
  }

  renderLoggedIn = (u: firebase.User) => {
    const { logout, renderCommittees, renderNewCommitteeButton } = this;
    const { committees } = this.state;
    const { allowNewCommittee } = this.props;

    return (
      <>
        <Card centered fluid>
          <Card.Content key="main">
            <Card.Header>
              {u.email}
            </Card.Header>
            <Card.Meta>
              {t('Logged in')}
            </Card.Meta>
          </Card.Content>
          <Card.Content key="committees" style={{
            'maxHeight': '50vh',
            'overflow': 'auto'
          }}>
            {committees ? renderCommittees() : <Loading />}
          </Card.Content>
          {allowNewCommittee && <Card.Content key="create">
            {renderNewCommitteeButton()}
            <Button as="a" href="/templates" basic fluid style={{marginTop: '0.75em'}}>
              <Icon name="file alternate outline" />{t('Manage templates')}
            </Button>
            <Button as="a" href="/countries" basic fluid style={{marginTop: '0.75em'}}>
              <Icon name="world" />{t('Country manager')}
            </Button>
          </Card.Content>}
          <Card.Content extra key="extra">
            {this.state.deleteError && <Message
              error
              onDismiss={() => this.setState({deleteError: undefined})}
              header={t('Could not delete committee')}
              content={this.state.deleteError.message}
            />}
            {this.state.isAdmin && <Button as="a" href="/admin" basic fluid style={{marginBottom: '0.75em'}}>
              <Icon name="users" />{t('Account administration')}
            </Button>}
            <Button basic color="red" fluid onClick={logout}>{t('Logout')}</Button>
          </Card.Content>
        </Card>
        <Confirm
          open={!!this.state.committeePendingDeletion}
          header={t('Delete committee?')}
          content={t('This permanently deletes the committee and all of its records and uploaded files.')}
          cancelButton={t('Cancel')}
          confirmButton={{content: t('Delete committee'), negative: true}}
          onCancel={this.cancelCommitteeDeletion}
          onConfirm={this.confirmCommitteeDeletion}
        />
      </>
    );
  }

  renderLogin = () => {
    const { loggingIn, user, email, password } = this.state;

    const renderLogInButton = () => (
      <Button 
        primary 
        fluid
        disabled={!email || !password}
        loading={loggingIn}
        type="submit"
      >
        {t('Log in')}
      </Button>
    );

    const err = this.state.error;
    
    return (
      <React.Fragment>
        <Header as="h3" attached="top">
          {t('Login')}
          <Header.Subheader>{t('Use an account issued by the administrator.')}</Header.Subheader>
        </Header>
        <Segment attached="bottom">
          <Form error={!!err} loading={user === undefined} onSubmit={this.login}>
            <Form.Input
              key="email"
              label={t('Email')}
              required
              placeholder="joe@schmoe.com"
              value={email}
              onChange={this.setEmail}
            >
              <input autoComplete="email" />
            </Form.Input>
            <Form.Input
              key="current-password"
              label={t('Password')}
              type="password"
              placeholder="correct horse battery staple"
              value={password}
              onChange={this.setPassword}
            >
              <input autoComplete="current-password" />
            </Form.Input>
            {this.renderError()}
            {renderLogInButton()}
          </Form>
        </Segment>
      </React.Fragment>
    );
  }

  render() {
    const { user } = this.state;

    return user 
      ? this.renderLoggedIn(user)
      : this.renderLogin()
  }
}

export class LoginModal extends React.Component<{}, 
  { user?: firebase.User | null 
    unsubscribe?: () => void
  }> {
  constructor(props: {}) {
    super(props);
    this.state = {
    };
  }

  renderModalTrigger() {
    const { user } = this.state;

    const text = user ? user.email : t('Login');

    return (
      <Button loading={user === undefined} className="nav__auth-status">
        <Icon name="lock" />
        {text}
      </Button>
    );
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

  render() {
    return (
      <Modal 
        trigger={this.renderModalTrigger()}
        size="tiny"
        dimmer
        basic={true} // strip out the outer window
      >
        <Modal.Content>
          <Login allowNewCommittee={true}/>
        </Modal.Content>
      </Modal>
    );
  }
}

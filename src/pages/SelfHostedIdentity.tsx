import * as React from 'react';
import {Button, Container, Form, Header, Icon, Menu, Message, Segment, Table} from 'semantic-ui-react';
import {Link, useLocation} from 'react-router-dom';
import Loading from '../components/Loading';
import {LanguageMenuItem, t} from '../i18n';
import {
  IdentityApiError,
  selfHostedIdentityClient,
  type SelfHostedIdentityClient,
  type SelfHostedUser
} from '../services/self-hosted-identity';
import SelfHostedWorkspace, {SelfHostedCommitteeWorkspace, SelfHostedPublicCommittees} from './SelfHostedWorkspace';

type Screen = 'loading' | 'bootstrap' | 'login' | 'change-password' | 'home';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface IdentityFormProps {
  client: SelfHostedIdentityClient;
  onAuthenticated(user: SelfHostedUser): void;
}

function LoginForm({client, onAuthenticated}: IdentityFormProps) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);

  const submit = async () => {
    setWorking(true);
    setError(undefined);
    try {
      onAuthenticated(await client.login(email.trim(), password));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  };

  return <Container text style={{padding: '3em 1em'}}>
    <LanguageMenuItem position="right" />
    <Header as="h3" attached="top">{t('Login')}</Header>
    <Segment attached="bottom">
      <Form onSubmit={submit} loading={working} error={!!error}>
        <Form.Input label={t('Email')} type="email" autoComplete="username" required value={email}
          onChange={event => setEmail(event.currentTarget.value)} />
        <Form.Input label={t('Password')} type="password" autoComplete="current-password" required value={password}
          onChange={event => setPassword(event.currentTarget.value)} />
        {error && <Message error content={error} />}
        <Button primary fluid disabled={working || !email || !password}>{t('Login')}</Button>
        <Button as={Link} to="/committees" basic fluid style={{marginTop: '0.75em'}}>
          <Icon name="users" />{t('Browse public committees')}
        </Button>
      </Form>
    </Segment>
  </Container>;
}

function BootstrapForm({client, onAuthenticated}: IdentityFormProps) {
  const [secret, setSecret] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);
  const valid = secret && email && displayName && password.length >= 12 && password === confirmation;

  const submit = async () => {
    if (!valid) return;
    setWorking(true);
    setError(undefined);
    try {
      onAuthenticated(await client.bootstrap({secret, email: email.trim(), displayName: displayName.trim(), password}));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  };

  return <IdentityShell title={t('Initialize administrator')} icon="user secret">
    {error && <Message error content={error} />}
    <Form onSubmit={submit} loading={working}>
      <Form.Input label={t('Bootstrap secret')} type="password" autoComplete="off" required value={secret}
        onChange={event => setSecret(event.currentTarget.value)} />
      <Form.Input label={t('Email')} type="email" autoComplete="username" required value={email}
        onChange={event => setEmail(event.currentTarget.value)} />
      <Form.Input label={t('Display name')} required value={displayName}
        onChange={event => setDisplayName(event.currentTarget.value)} />
      <Form.Input label={t('Password')} type="password" minLength={12} autoComplete="new-password" required value={password}
        onChange={event => setPassword(event.currentTarget.value)} />
      <Form.Input label={t('Confirm password')} type="password" minLength={12} autoComplete="new-password" required
        error={!!confirmation && confirmation !== password} value={confirmation}
        onChange={event => setConfirmation(event.currentTarget.value)} />
      <Button primary fluid disabled={!valid || working}>{t('Create administrator')}</Button>
    </Form>
  </IdentityShell>;
}

function ChangePasswordForm({client, onAuthenticated}: IdentityFormProps) {
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);
  const valid = newPassword.length >= 12 && newPassword === confirmation;

  const submit = async () => {
    if (!valid) return;
    setWorking(true);
    setError(undefined);
    try {
      onAuthenticated(await client.changePassword(newPassword));
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  };

  return <IdentityShell title={t('Change temporary password')} icon="key">
    {error && <Message error content={error} />}
    <Form onSubmit={submit} loading={working}>
      <Form.Input label={t('New password')} type="password" minLength={12} autoComplete="new-password" required
        value={newPassword} onChange={event => setNewPassword(event.currentTarget.value)} />
      <Form.Input label={t('Confirm password')} type="password" minLength={12} autoComplete="new-password" required
        error={!!confirmation && confirmation !== newPassword} value={confirmation}
        onChange={event => setConfirmation(event.currentTarget.value)} />
      <Button primary fluid disabled={!valid || working}>{t('Change password')}</Button>
    </Form>
  </IdentityShell>;
}

function IdentityShell({title, icon, children}: {title: string; icon: React.ComponentProps<typeof Icon>['name']; children: React.ReactNode}) {
  return <Container text style={{padding: '3em 1em'}}>
    <LanguageMenuItem position="right" />
    <Header as="h1" icon textAlign="center"><Icon name={icon} />{title}</Header>
    <Segment>{children}</Segment>
  </Container>;
}

function AccountManager({client, currentUser, onLogout}: {
  client: SelfHostedIdentityClient;
  currentUser: SelfHostedUser;
  onLogout(): void;
}) {
  const [users, setUsers] = React.useState<SelfHostedUser[]>([]);
  const [email, setEmail] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [temporary, setTemporary] = React.useState<{email: string; password: string}>();
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setUsers(await client.listUsers());
    } catch (caught) {
      setError(message(caught));
    }
  }, [client]);
  React.useEffect(() => void refresh(), [refresh]);

  const run = async (operation: () => Promise<void>) => {
    setWorking(true);
    setError(undefined);
    try {
      await operation();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setWorking(false);
    }
  };

  const create = () => run(async () => {
    const result = await client.createUser(email.trim(), displayName.trim());
    setTemporary({email: result.user.email, password: result.temporaryPassword});
    setEmail('');
    setDisplayName('');
    await refresh();
  });

  const reset = (target: SelfHostedUser) => run(async () => {
    if (!window.confirm(t('Reset password for {email}', {email: target.email}))) return;
    const result = await client.resetPassword(target.id);
    setTemporary({email: result.user.email, password: result.temporaryPassword});
    await refresh();
  });

  const anonymize = (target: SelfHostedUser) => run(async () => {
    const recipientEmail = window.prompt(t('Enter the email of the account that will receive these resources:'))?.trim().toLowerCase();
    if (!recipientEmail) return;
    const replacement = users.find(candidate => candidate.id !== target.id && candidate.status === 'ACTIVE'
      && candidate.email.toLowerCase() === recipientEmail);
    if (!replacement) throw new Error(t('Select an active replacement account.'));
    const confirmation = window.prompt(t('This cannot be undone. Enter “{email}” to anonymize this account:',
      {email: target.email}))?.trim().toLowerCase();
    if (!confirmation) return;
    await client.anonymizeUser(target.id, replacement.id, confirmation);
    await refresh();
  });

  return <Container style={{padding: '2em 1em'}}>
    <Header as="h1"><Icon name="users" />{t('Account administration')}</Header>
    {error && <Message error content={error} onDismiss={() => setError(undefined)} />}
    {temporary && <Message positive onDismiss={() => setTemporary(undefined)}
      header={t('Temporary password for {email}', {email: temporary.email})}
      content={<code>{temporary.password}</code>} />}
    <Segment>
      <Header as="h2">{t('Create account')}</Header>
      <Form onSubmit={create} loading={working}>
        <Form.Group widths="equal">
          <Form.Input label={t('Email')} type="email" required value={email}
            onChange={event => setEmail(event.currentTarget.value)} />
          <Form.Input label={t('Display name')} required value={displayName}
            onChange={event => setDisplayName(event.currentTarget.value)} />
        </Form.Group>
        <Button primary disabled={!email || !displayName || working}>{t('Create account')}</Button>
      </Form>
    </Segment>
    <Segment loading={working}>
      <Header as="h2">{t('Accounts')}</Header>
      <Table celled stackable>
        <Table.Header><Table.Row>
          <Table.HeaderCell>{t('Email')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Display name')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Status')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Actions')}</Table.HeaderCell>
        </Table.Row></Table.Header>
        <Table.Body>{users.map(account => <Table.Row key={account.id} disabled={account.status !== 'ACTIVE'}>
          <Table.Cell>{account.email || t('Anonymous account')}</Table.Cell>
          <Table.Cell>{account.displayName}</Table.Cell>
          <Table.Cell>{t(account.status)}</Table.Cell>
          <Table.Cell>
            <Button size="small" disabled={account.status !== 'ACTIVE'}
              onClick={() => reset(account)}>{t('Reset password')}</Button>
            <Button size="small" disabled={account.status === 'ANONYMIZED'} onClick={() => run(async () => {
              if (window.confirm(t('Revoke all sessions for {email}?', {email: account.email}))) {
                await client.revokeSessions(account.id);
              }
            })}>{t('Revoke sessions')}</Button>
            <Button size="small" negative disabled={account.isSystemAdmin || account.status !== 'ACTIVE'}
              onClick={() => run(async () => {
                if (window.confirm(t('Disable account {email}?', {email: account.email}))) {
                  await client.disableUser(account.id);
                  await refresh();
                }
              })}>{t('Disable account')}</Button>
            <Button size="small" negative disabled={account.isSystemAdmin || account.status !== 'DISABLED'
              || !users.some(candidate => candidate.id !== account.id && candidate.status === 'ACTIVE')}
              onClick={() => anonymize(account)}>{t('Anonymize account')}</Button>
          </Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table>
    </Segment>
    <Button basic color="red" onClick={onLogout}>{t('Logout')}</Button>
    <span style={{marginLeft: '1em'}}>{currentUser.displayName}</span>
  </Container>;
}

export default function SelfHostedIdentity({client = selfHostedIdentityClient}: {client?: SelfHostedIdentityClient}) {
  const location = useLocation();
  const [screen, setScreen] = React.useState<Screen>('loading');
  const [user, setUser] = React.useState<SelfHostedUser>();
  const [error, setError] = React.useState<string>();

  const authenticated = React.useCallback((identity: SelfHostedUser) => {
    setUser(identity);
    setScreen(identity.mustChangePassword ? 'change-password' : 'home');
  }, []);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (!(await client.bootstrapStatus())) {
          if (active) setScreen('bootstrap');
          return;
        }
        try {
          const identity = await client.me();
          if (active) authenticated(identity);
        } catch (caught) {
          if (active && caught instanceof IdentityApiError && caught.status === 401) setScreen('login');
          else throw caught;
        }
      } catch (caught) {
        if (active) setError(message(caught));
      }
    })();
    return () => { active = false; };
  }, [authenticated, client]);

  const logout = async () => {
    try {
      await client.logout();
    } finally {
      setUser(undefined);
      setScreen('login');
    }
  };

  if (error) return <IdentityShell title={t('Authentication error')} icon="warning sign"><Message error content={error} /></IdentityShell>;
  if (screen === 'loading') return <Loading />;
  if (screen === 'bootstrap') return <BootstrapForm client={client} onAuthenticated={authenticated} />;
  if (screen === 'login' && location.pathname === '/committees') return <SelfHostedPublicCommittees />;
  if (screen === 'login' && /^\/committees\/[^/]+/.test(location.pathname)) return <>
    <Menu><Menu.Item header>Quorum</Menu.Item><Menu.Menu position="right"><Menu.Item as={Link} to="/login">{t('Login')}</Menu.Item></Menu.Menu></Menu>
    <SelfHostedCommitteeWorkspace />
  </>;
  if (screen === 'login') return <LoginForm client={client} onAuthenticated={authenticated} />;
  if (screen === 'change-password') return <ChangePasswordForm client={client} onAuthenticated={authenticated} />;
  if (!user) return <Loading />;
  return <SelfHostedWorkspace user={user} logout={logout}
    accountManager={user.isSystemAdmin ? <AccountManager client={client} currentUser={user} onLogout={logout} /> : undefined} />;
}

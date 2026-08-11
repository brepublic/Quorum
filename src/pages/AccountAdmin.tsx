import * as React from 'react';
import firebase from 'firebase/compat/app';
import {
  Button,
  Confirm,
  Container,
  Form,
  Header,
  Icon,
  Message,
  Segment,
  Table,
} from 'semantic-ui-react';
import {Helmet} from 'react-helmet';
import Loading from '../components/Loading';
import {Login} from '../components/auth';
import {LanguageMenuItem, t} from '../i18n';
import {
  bootstrapAdmin,
  createManagedAccount,
  deleteManagedAccount,
  listAccounts,
  ManagedAccount,
  resetManagedAccountPassword,
} from '../services/account-admin';

interface Props {
  initialSetup?: boolean;
  onInitialized?: () => void;
}

function errorMessage(error: unknown): string {
  const candidate = error as {code?: string; message?: string};
  if (candidate.code) {
    const translated = t(candidate.code);
    if (translated !== candidate.code) {
      return translated;
    }
  }
  return candidate.message || String(error);
}

export default function AccountAdmin({initialSetup = false, onInitialized}: Props) {
  const [user, setUser] = React.useState<firebase.User | null | undefined>(
    firebase.auth().currentUser
  );
  const [isAdmin, setIsAdmin] = React.useState<boolean | undefined>(undefined);
  const [accounts, setAccounts] = React.useState<ManagedAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [success, setSuccess] = React.useState<string>();
  const [resetAccount, setResetAccount] = React.useState<ManagedAccount>();
  const [deleteAccount, setDeleteAccount] = React.useState<ManagedAccount>();

  const refreshAccounts = React.useCallback(async () => {
    setLoadingAccounts(true);
    try {
      const firstPage = await listAccounts();
      let nextPageToken = firstPage.nextPageToken;
      const loaded = [...firstPage.accounts];
      while (nextPageToken) {
        const page = await listAccounts(nextPageToken);
        loaded.push(...page.accounts);
        nextPageToken = page.nextPageToken;
      }
      setAccounts(loaded);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  React.useEffect(() => firebase.auth().onAuthStateChanged(async nextUser => {
    setUser(nextUser);
    if (!nextUser || initialSetup) {
      setIsAdmin(false);
      return;
    }
    try {
      const token = await nextUser.getIdTokenResult(true);
      const admin = token.claims.admin === true;
      setIsAdmin(admin);
      if (admin) {
        await refreshAccounts();
      }
    } catch (caught) {
      setIsAdmin(false);
      setError(errorMessage(caught));
    }
  }), [initialSetup, refreshAccounts]);

  const passwordsMatch = password === confirmPassword;
  const validPassword = password.length >= 6 && passwordsMatch;

  const initialize = async () => {
    if (!user && (!email || !validPassword)) return;
    setWorking(true);
    setError(undefined);
    try {
      const administrator = user || (await firebase.auth()
        .createUserWithEmailAndPassword(email.trim(), password)).user;
      if (!administrator) throw new Error(t('Could not create the administrator account.'));
      await bootstrapAdmin();
      await administrator.getIdToken(true);
      setSuccess(t('Administrator account created.'));
      onInitialized?.();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  };

  const createAccount = async () => {
    if (!email || !validPassword) return;
    setWorking(true);
    setError(undefined);
    try {
      await createManagedAccount(email.trim(), password);
      setEmail('');
      setPassword('');
      setConfirmPassword('');
      setSuccess(t('Account created for {email}.', {email: email.trim()}));
      await refreshAccounts();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  };

  const resetPassword = async () => {
    if (!resetAccount || !validPassword) return;
    setWorking(true);
    setError(undefined);
    try {
      await resetManagedAccountPassword(resetAccount.uid, password);
      setSuccess(t('Password reset for {email}.', {email: resetAccount.email}));
      setResetAccount(undefined);
      setPassword('');
      setConfirmPassword('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  };

  const removeAccount = async () => {
    if (!deleteAccount) return;
    setWorking(true);
    setError(undefined);
    try {
      await deleteManagedAccount(deleteAccount.uid);
      setSuccess(t('Account deleted for {email}.', {email: deleteAccount.email}));
      setDeleteAccount(undefined);
      await refreshAccounts();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking(false);
    }
  };

  const accountForm = (submit: () => void, submitText: string) => (
    <Form onSubmit={submit} loading={working}>
      <Form.Input
        label={t('Email')}
        type="email"
        required
        value={email}
        autoComplete="email"
        onChange={event => setEmail(event.currentTarget.value)}
      />
      <Form.Input
        label={t('Password')}
        type="password"
        required
        minLength={6}
        value={password}
        autoComplete="new-password"
        onChange={event => setPassword(event.currentTarget.value)}
      />
      <Form.Input
        label={t('Confirm password')}
        type="password"
        required
        error={!!confirmPassword && !passwordsMatch}
        value={confirmPassword}
        autoComplete="new-password"
        onChange={event => setConfirmPassword(event.currentTarget.value)}
      />
      <Button primary fluid disabled={!email || !validPassword || working}>
        {submitText}
      </Button>
    </Form>
  );

  if (initialSetup) {
    return (
      <Container text style={{padding: '3em 1em'}}>
        <Helmet><title>{`${t('Initialize administrator')} - Quorum`}</title></Helmet>
        <LanguageMenuItem position="right" />
        <Header as="h1" icon textAlign="center">
          <Icon name="user secret" />
          {t('Initialize administrator')}
          <Header.Subheader>{t('Create the only account permitted to manage other accounts.')}</Header.Subheader>
        </Header>
        {error && <Message error content={error} onDismiss={() => setError(undefined)} />}
        {success && <Message success content={success} />}
        <Segment>{user ? <>
          <Message info content={t('Continue administrator initialization for {email}.', {email: user.email || ''})} />
          <Button primary fluid loading={working} onClick={initialize}>{t('Continue initialization')}</Button>
          <Button basic fluid style={{marginTop: '0.75em'}} onClick={() => firebase.auth().signOut()}>{t('Use another account')}</Button>
        </> : accountForm(initialize, t('Create administrator'))}</Segment>
      </Container>
    );
  }

  if (user === undefined || (user && isAdmin === undefined)) return <Loading />;
  if (!user) {
    return <Container text style={{padding: '2em 1em'}}><Login allowNewCommittee={false} /></Container>;
  }
  if (!isAdmin) {
    return (
      <Container text style={{padding: '3em 1em'}}>
        <Message error header={t('Access denied')} content={t('This page is available only to the administrator.')} />
        <Button onClick={() => firebase.auth().signOut()}>{t('Logout')}</Button>
      </Container>
    );
  }

  return (
    <Container style={{padding: '2em 1em'}}>
      <Helmet><title>{`${t('Account administration')} - Quorum`}</title></Helmet>
      <Header as="h1"><Icon name="users" />{t('Account administration')}</Header>
      <p>{t('Administrators can create accounts, reset passwords, and delete accounts only.')}</p>
      {error && <Message error content={error} onDismiss={() => setError(undefined)} />}
      {success && <Message success content={success} onDismiss={() => setSuccess(undefined)} />}
      <Segment>
        <Header as="h2">{t('Create account')}</Header>
        {accountForm(createAccount, t('Create account'))}
      </Segment>
      <Segment loading={loadingAccounts}>
        <Header as="h2">{t('Accounts')}</Header>
        <Table celled stackable>
          <Table.Header><Table.Row>
            <Table.HeaderCell>{t('Email')}</Table.HeaderCell>
            <Table.HeaderCell>{t('Created')}</Table.HeaderCell>
            <Table.HeaderCell>{t('Last login')}</Table.HeaderCell>
            <Table.HeaderCell>{t('Actions')}</Table.HeaderCell>
          </Table.Row></Table.Header>
          <Table.Body>{accounts.map(account => (
            <Table.Row key={account.uid}>
              <Table.Cell>{account.email}</Table.Cell>
              <Table.Cell>{account.createdAt ? new Date(account.createdAt).toLocaleString() : '—'}</Table.Cell>
              <Table.Cell>{account.lastSignInAt ? new Date(account.lastSignInAt).toLocaleString() : '—'}</Table.Cell>
              <Table.Cell>
                <Button size="small" onClick={() => {
                  setResetAccount(account);
                  setPassword('');
                  setConfirmPassword('');
                }}>{t('Reset password')}</Button>
                <Button
                  size="small"
                  negative
                  disabled={account.uid === user.uid}
                  onClick={() => setDeleteAccount(account)}
                >{t('Delete account')}</Button>
              </Table.Cell>
            </Table.Row>
          ))}</Table.Body>
        </Table>
      </Segment>
      <Button as="a" href="/onboard" basic>{t('Back to Quorum')}</Button>
      <Button basic color="red" onClick={() => firebase.auth().signOut()}>{t('Logout')}</Button>
      <Confirm
        open={!!deleteAccount}
        header={t('Delete account?')}
        content={t('This deletes the login only. Committees, templates, and uploaded files owned by the account are retained.')}
        cancelButton={t('Cancel')}
        confirmButton={{content: t('Delete account'), negative: true}}
        onCancel={() => setDeleteAccount(undefined)}
        onConfirm={removeAccount}
      />
      <Confirm
        open={!!resetAccount}
        header={t('Reset password for {email}', {email: resetAccount?.email || ''})}
        content={<Form>
          <Form.Input label={t('New password')} type="password" minLength={6} value={password}
            onChange={event => setPassword(event.currentTarget.value)} />
          <Form.Input label={t('Confirm password')} type="password" value={confirmPassword}
            error={!!confirmPassword && !passwordsMatch}
            onChange={event => setConfirmPassword(event.currentTarget.value)} />
        </Form>}
        cancelButton={t('Cancel')}
        confirmButton={{content: t('Reset password'), primary: true, disabled: !validPassword}}
        onCancel={() => setResetAccount(undefined)}
        onConfirm={resetPassword}
      />
    </Container>
  );
}

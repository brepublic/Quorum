import * as React from 'react';
import {Link, Redirect, Route, Switch, useLocation} from 'react-router-dom';
import {Container, Header, Icon, Menu} from 'semantic-ui-react';
import {t} from '../../i18n';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import type {SelfHostedIdentityClient} from '../../services/self-hosted-identity';
import DefaultCommitteeBehaviorPanel from './DefaultCommitteeBehaviorPanel';
import {DelegateFileSettingsPanel} from './DelegateFileSettingsPanel';
import OperationsPanel from './OperationsPanel';
import StorageCacheSettingsPanel from './StorageCacheSettingsPanel';
import StorageAdminPanel from './StorageAdminPanel';

export default function SystemSettings({api, client}: {api: SelfHostedApi; client: SelfHostedIdentityClient}) {
  const {pathname} = useLocation();
  const base = '/system-settings';
  return <Container className="self-hosted-admin-page self-hosted-system-settings" style={{padding: '2em 1em'}}>
    <Header as="h1"><Icon name="settings" />{t('System settings')}</Header>
    <Menu secondary pointing className="system-settings-navigation" as="nav" aria-label={t('System settings')}>
      {[
        ['operations', 'Operations status'], ['defaults', 'Committee defaults'],
        ['cache', 'Cache settings'], ['storage', 'Storage configuration']
      ].map(([path, label]) => <Menu.Item key={path} as={Link} to={`${base}/${path}`}
        active={pathname === `${base}/${path}`} aria-current={pathname === `${base}/${path}` ? 'page' : undefined}>
        {t(label)}
      </Menu.Item>)}
    </Menu>
    <Switch>
      <Route exact path={`${base}/operations`}><OperationsPanel api={api} /></Route>
      <Route exact path={`${base}/defaults`}>
        <DefaultCommitteeBehaviorPanel client={client} />
        <DelegateFileSettingsPanel api={api} />
      </Route>
      <Route exact path={`${base}/cache`}><StorageCacheSettingsPanel api={api} /></Route>
      <Route exact path={`${base}/storage`}><StorageAdminPanel api={api} /></Route>
      <Redirect to={`${base}/operations`} />
    </Switch>
  </Container>;
}

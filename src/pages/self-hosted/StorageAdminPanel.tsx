import * as React from 'react';
import type {S3ProviderConfigSummary} from '@quorum/contracts';
import {Button, Card, Form, Header, Message, Segment} from 'semantic-ui-react';
import {storageErrorText} from './FilesPanel';
import type {S3ProviderConfigInput, SelfHostedApi} from '../../services/self-hosted-api';

const EMPTY_FORM: S3ProviderConfigInput & {status: 'ACTIVE' | 'DISABLED'} = {
  displayName: '', endpoint: '', region: '', bucket: '', prefix: '', forcePathStyle: true,
  allowPrivateNetwork: false, credentials: {accessKeyId: '', secretAccessKey: ''}, status: 'ACTIVE'
};

export default function StorageAdminPanel({api}: {api: SelfHostedApi}) {
  const [configs, setConfigs] = React.useState<S3ProviderConfigSummary[]>([]);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [editing, setEditing] = React.useState<S3ProviderConfigSummary>();
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);
  const refresh = React.useCallback(async (clearError = true) => {
    try { setConfigs(await api.listS3ProviderConfigs()); if (clearError) setError(undefined); }
    catch (caught) { setError(storageErrorText(caught)); }
  }, [api]);
  React.useEffect(() => void refresh(), [refresh]);

  const run = async (operation: () => Promise<unknown>) => {
    setWorking(true); setError(undefined);
    let failed = false;
    try { await operation(); setEditing(undefined); setForm(EMPTY_FORM); }
    catch (caught) { failed = true; setError(storageErrorText(caught)); }
    finally { await refresh(!failed); setWorking(false); }
  };
  const edit = (config: S3ProviderConfigSummary) => {
    setEditing(config); setForm({displayName: config.displayName, endpoint: config.endpoint, region: config.region,
      bucket: config.bucket, prefix: config.prefix, forcePathStyle: config.forcePathStyle,
      allowPrivateNetwork: config.allowPrivateNetwork, status: config.status,
      credentials: {accessKeyId: '', secretAccessKey: ''}});
  };
  const save = () => {
    if (!editing) return run(() => api.createS3ProviderConfig(form));
    const credentials = form.credentials.accessKeyId && form.credentials.secretAccessKey ? form.credentials : undefined;
    return run(() => api.updateS3ProviderConfig(editing.id, editing.revision, {
      displayName: form.displayName, endpoint: form.endpoint, region: form.region, bucket: form.bucket,
      prefix: form.prefix, forcePathStyle: form.forcePathStyle, allowPrivateNetwork: form.allowPrivateNetwork,
      status: form.status, ...(credentials ? {credentials} : {})
    }));
  };
  const credentialStarted = Boolean(form.credentials.accessKeyId || form.credentials.secretAccessKey);
  const credentialComplete = Boolean(form.credentials.accessKeyId && form.credentials.secretAccessKey);
  const validCredentials = editing ? !credentialStarted || credentialComplete : credentialComplete;
  const valid = form.displayName.trim() && form.endpoint.trim() && form.region.trim() && form.bucket.trim() && validCredentials;

  return <div className="self-hosted-storage-admin">
    <Header as="h1">存储配置</Header>
    {error && <Message error role="alert" content={error} />}
    <Segment loading={working}><Form onSubmit={() => void save()}>
      <Form.Group widths="equal">
        <Form.Input label="配置名称" required value={form.displayName}
          onChange={event => setForm({...form, displayName: event.currentTarget.value})} />
        <Form.Input label="Endpoint" required type="url" value={form.endpoint}
          onChange={event => setForm({...form, endpoint: event.currentTarget.value})} />
      </Form.Group>
      <Form.Group widths="equal">
        <Form.Input label="Region" required value={form.region}
          onChange={event => setForm({...form, region: event.currentTarget.value})} />
        <Form.Input label="Bucket" required value={form.bucket}
          onChange={event => setForm({...form, bucket: event.currentTarget.value})} />
        <Form.Input label="Prefix" value={form.prefix}
          onChange={event => setForm({...form, prefix: event.currentTarget.value})} />
      </Form.Group>
      <Form.Group widths="equal">
        <Form.Input label="Access key" required={!editing} autoComplete="off" value={form.credentials.accessKeyId}
          onChange={event => setForm({...form, credentials: {...form.credentials, accessKeyId: event.currentTarget.value}})} />
        <Form.Input label="Secret key" required={!editing} type="password" autoComplete="new-password"
          value={form.credentials.secretAccessKey}
          onChange={event => setForm({...form, credentials: {...form.credentials, secretAccessKey: event.currentTarget.value}})} />
      </Form.Group>
      <Form.Group inline>
        <Form.Checkbox label="Path-style" checked={form.forcePathStyle}
          onChange={(_, data) => setForm({...form, forcePathStyle: Boolean(data.checked)})} />
        <Form.Checkbox label="允许私网 endpoint" checked={form.allowPrivateNetwork}
          onChange={(_, data) => setForm({...form, allowPrivateNetwork: Boolean(data.checked)})} />
        {editing && <Form.Select label="状态" value={form.status} options={[
          {key: 'active', value: 'ACTIVE', text: '启用'}, {key: 'disabled', value: 'DISABLED', text: '停用'}
        ]} onChange={(_, data) => setForm({...form, status: data.value as 'ACTIVE' | 'DISABLED'})} />}
      </Form.Group>
      <Button primary disabled={!valid}>{editing ? '保存配置' : '创建配置'}</Button>
      {editing && <Button type="button" onClick={() => {setEditing(undefined); setForm(EMPTY_FORM);}}>取消编辑</Button>}
    </Form></Segment>
    <Card.Group stackable>{configs.map(config => <Card key={config.id}><Card.Content>
      <Card.Header>{config.displayName}</Card.Header><Card.Meta>{config.status === 'ACTIVE' ? '启用' : '停用'} · {
        config.verifiedAt ? '验证通过' : '未验证'}</Card.Meta>
      <Card.Description>{config.endpoint}<br />{config.bucket}{config.prefix ? `/${config.prefix}` : ''}</Card.Description>
    </Card.Content><Card.Content extra>
      <Button size="small" onClick={() => edit(config)}>编辑配置</Button>
      <Button size="small" onClick={() => void run(() => api.verifyS3ProviderConfig(config.id))}>验证配置</Button>
    </Card.Content></Card>)}</Card.Group>
  </div>;
}

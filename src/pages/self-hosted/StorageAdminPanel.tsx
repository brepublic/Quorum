import {t, useLanguage, getLanguage} from '../../i18n';
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
  useLanguage();
  const [configs, setConfigs] = React.useState<S3ProviderConfigSummary[]>([]);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [editing, setEditing] = React.useState<S3ProviderConfigSummary>();
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? storageErrorText(failure) : undefined;
  const [working, setWorking] = React.useState(false);
  const refresh = React.useCallback(async (clearError = true) => {
    try { setConfigs(await api.listS3ProviderConfigs()); if (clearError) setError(undefined); }
    catch (caught) { setError(caught); }
  }, [api]);
  React.useEffect(() => void refresh(), [refresh]);

  const run = async (operation: () => Promise<unknown>) => {
    setWorking(true); setError(undefined);
    let failed = false;
    try { await operation(); setEditing(undefined); setForm(EMPTY_FORM); }
    catch (caught) { failed = true; setError(caught); }
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
    {error && <Message error role="alert" content={error} />}
    <Segment loading={working}>
      <Header as="h2">{editing ? t("Edit storage configuration") : t("Add storage configuration")}</Header>
      <Form onSubmit={() => void save()}>
      <Form.Group widths="equal">
        <Form.Input label={t("Configuration name")} required value={form.displayName}
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
        <Form.Checkbox label={t("Allow private network endpoint")} checked={form.allowPrivateNetwork}
          onChange={(_, data) => setForm({...form, allowPrivateNetwork: Boolean(data.checked)})} />
        {editing && <Form.Select label={t("Status")} value={form.status} options={[
          {key: 'active', value: 'ACTIVE', text: t("Enabled")}, {key: 'disabled', value: 'DISABLED', text: t("Deactivate")}
        ]} onChange={(_, data) => setForm({...form, status: data.value as 'ACTIVE' | 'DISABLED'})} />}
      </Form.Group>
      <Button primary disabled={!valid}>{editing ? t("Save configuration") : t("Create configuration")}</Button>
      {editing && <Button type="button" onClick={() => {setEditing(undefined); setForm(EMPTY_FORM);}}>{t("Cancel editing")}</Button>}
    </Form></Segment>
    <Segment>
      <Header as="h2">{t("Configured storage")}</Header>
      {!configs.length && <p>{t("No storage configurations")}</p>}
      {configs.length > 0 && <Card.Group stackable className="storage-config-cards">{configs.map(config => <Card key={config.id}><Card.Content>
      <Card.Header>{config.displayName}</Card.Header><Card.Meta>{config.status === 'ACTIVE' ? t("Enabled") : t("Deactivate")} · {
        config.verifiedAt ? t("Verified") : t("Not verified")}</Card.Meta>
      <Card.Description>{config.endpoint}<br />{config.bucket}{config.prefix ? `/${config.prefix}` : ''}</Card.Description>
    </Card.Content><Card.Content extra className="admin-actions">
      <Button size="small" onClick={() => edit(config)}>{t("Edit configuration")}</Button>
      <Button size="small" onClick={() => void run(() => api.verifyS3ProviderConfig(config.id))}>{t("Verify configuration")}</Button>
    </Card.Content></Card>)}</Card.Group>}
    </Segment>
  </div>;
}

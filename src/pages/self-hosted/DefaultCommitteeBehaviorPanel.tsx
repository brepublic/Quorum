import {useLanguage} from '../../i18n';
import {apiErrorText} from '../../i18n';
import * as React from 'react';
import {Button, Checkbox, Form, Header, Icon, Message, Segment} from 'semantic-ui-react';
import {t} from '../../i18n';
import type {DefaultCommitteeBehavior, SelfHostedIdentityClient} from '../../services/self-hosted-identity';

function message(error: unknown): string {
  return apiErrorText(error);
}

export default function DefaultCommitteeBehaviorPanel({client}: {client: SelfHostedIdentityClient}) {
  useLanguage();
  const [settings, setSettings] = React.useState<DefaultCommitteeBehavior>();
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? message(failure) : undefined;
  const [saving, setSaving] = React.useState(false);
  const load = React.useCallback(async () => {
    try { setSettings(await client.getDefaultCommitteeBehavior()); } catch (caught) { setError(caught); }
  }, [client]);
  React.useEffect(() => { void load(); }, [load]);
  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(undefined);
    try { setSettings(await client.updateDefaultCommitteeBehavior(settings)); } catch (caught) { setError(caught); }
    finally { setSaving(false); }
  };
  return <Segment loading={!settings || saving}>
    <Header as="h2">{t('Default behavior')}</Header>
    {error && <Message error content={error} />}
    {settings && <Form onSubmit={save}>
      <Form.Field><Checkbox label={t('Committee creator is automatically Chair')} checked={settings.creatorIsChair}
        onChange={(_, data) => setSettings(current => current && {...current, creatorIsChair: Boolean(data.checked)})} /></Form.Field>
      <Form.Select label={t('Default committee operation mode')} value={settings.operationMode} options={[
        {key: 'chair', value: 'CHAIR_OPERATED', text: t('Chair operated')},
        {key: 'delegate', value: 'DELEGATE_OPERATED', text: t('Delegate operated')}
      ]} onChange={(_, data) => setSettings(current => current && {...current,
        operationMode: data.value as DefaultCommitteeBehavior['operationMode']})} />
      <Button primary disabled={saving}><Icon name="save" />{t('Save changes')}</Button>
    </Form>}
  </Segment>;
}


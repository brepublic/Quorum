import {useLanguage} from '../../i18n';
import {apiErrorText} from '../../i18n';
import * as React from 'react';
import {Button, Checkbox, Form, Header, Icon, Message, Segment} from 'semantic-ui-react';
import {t} from '../../i18n';
import {getThemeSettings, updateThemeSettings, ThemeSettings} from '../../services/self-hosted-identity';
import {useThemeFeature} from '../../theme/ThemeProvider';

export default function ThemeSettingsPanel() {
  useLanguage();
  const [settings, setSettings] = React.useState<ThemeSettings>();
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? apiErrorText(failure) : undefined;
  const [saving, setSaving] = React.useState(false);
  const {setEnabled} = useThemeFeature();
  React.useEffect(() => {
    let cancelled = false;
    void getThemeSettings().then(value => { if (!cancelled) setSettings(value); })
      .catch(caught => { if (!cancelled) setError(caught); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(undefined);
    try {
      const saved = await updateThemeSettings(settings);
      setSettings(saved); setEnabled(saved.enabled);
    } catch (caught) { setError(caught); }
    finally { setSaving(false); }
  };
  return <Segment loading={(!settings && !error) || saving}>
    <Header as="h2">{t('Interface settings')}</Header>
    {error && <Message error content={t(error)} />}
    {settings && <Form onSubmit={save}>
      <Form.Field><Checkbox label={t('Enable themes (experimental)')} checked={settings.enabled} disabled={saving}
        onChange={(_, data) => setSettings({...settings, enabled: Boolean(data.checked)})} /></Form.Field>
      <Button primary disabled={saving}><Icon name="save" />{t('Save changes')}</Button>
    </Form>}
  </Segment>;
}

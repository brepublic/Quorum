import * as React from 'react';
import {Button, Checkbox, Form, Header, Message, Segment} from 'semantic-ui-react';
import {t} from '../../i18n';
import {getThemeSettings, updateThemeSettings, ThemeSettings} from '../../services/self-hosted-identity';
import {useThemeFeature} from '../../theme/ThemeProvider';

export default function ThemeSettingsPanel() {
  const [settings, setSettings] = React.useState<ThemeSettings>();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const {setEnabled} = useThemeFeature();
  React.useEffect(() => {
    let cancelled = false;
    void getThemeSettings().then(value => { if (!cancelled) setSettings(value); })
      .catch(caught => { if (!cancelled) setError(String(caught.message ?? caught)); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(undefined);
    try {
      const saved = await updateThemeSettings(settings);
      setSettings(saved); setEnabled(saved.enabled);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  return <Segment loading={(!settings && !error) || saving}>
    <Header as="h2">{t('Interface settings')}</Header>
    {error && <Message error content={t(error)} />}
    {settings && <Form onSubmit={save}>
      <Form.Field><Checkbox label={t('Enable themes (experimental)')} checked={settings.enabled} disabled={saving}
        onChange={(_, data) => setSettings({...settings, enabled: Boolean(data.checked)})} /></Form.Field>
      <Button primary disabled={saving}>{t('Save changes')}</Button>
    </Form>}
  </Segment>;
}

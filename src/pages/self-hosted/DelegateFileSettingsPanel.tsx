import {useApiFieldErrors} from '../../components/useApiFieldErrors';
import {apiErrorText} from '../../i18n';
import {delegateFileTypeName, isContentLanguage, type ContentLanguage} from '@quorum/contracts';
import {t, useLanguage} from '../../i18n';
import {getLanguage, LANGUAGE_OPTIONS} from '../../i18n';
import * as React from 'react';
import {Prompt} from 'react-router-dom';
import type {DefaultFileRejectionSettings, DelegateFileSettings, DelegateFileType} from '@quorum/contracts';
import {Button, Form, Header, Icon, Message, Modal, Segment} from 'semantic-ui-react';
import {selfHostedApi, SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';

const FILE_TYPES: Array<[DelegateFileType, string]> = [
  ['WORKING_PAPER', 'Working Paper'], ['DIRECTIVE_DRAFT', 'Draft Directive'], ['RESOLUTION_DRAFT', 'Draft Resolution']
];

export function DelegateFileSettingsPanel({committeeId, committeeLanguage, api = selfHostedApi, readOnly = false}: {
  committeeId?: string; committeeLanguage?: ContentLanguage; api?: SelfHostedApi; readOnly?: boolean;
}) {
  useLanguage();
  const [contentLanguage, setContentLanguage] = React.useState(() => committeeLanguage ?? getLanguage());
  const [settings, setSettings] = React.useState<DefaultFileRejectionSettings | DelegateFileSettings>();
  const [extensions, setExtensions] = React.useState<Record<string, string>>({});
  const [working, setWorking] = React.useState(false);
  const [failure, setError] = React.useState<unknown>();
  const field = useApiFieldErrors(failure);
  const error = failure ? apiErrorText(failure) : undefined; const [saved, setSaved] = React.useState(false);
  const [dirty, setDirty] = React.useState(false); const [reload, setReload] = React.useState(false);
  const load = React.useCallback(async () => {
    setWorking(true); setError(undefined);
    try {
      const next = committeeId ? await api.getDelegateFileSettings(committeeId) : await api.getDefaultFileRejectionTypes();
      setSettings(next); setDirty(false); setSaved(false);
      if (committeeId) setExtensions(Object.fromEntries(FILE_TYPES.map(([type]) => [type, (next as DelegateFileSettings).allowedExtensions[type].join(', ')])));
    } catch (caught) {
      if (caught instanceof SelfHostedApiError) {
        const missingLanguage = caught.localization?.fieldErrors?.[0]?.params?.language;
        if (isContentLanguage(missingLanguage)) setContentLanguage(missingLanguage);
      }
      setError(caught);
    }
    finally {setWorking(false);}
  }, [api, committeeId]);
  React.useEffect(() => {void load();}, [load]);
  React.useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {if (dirty) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const changed = () => {setDirty(true); setSaved(false);};
  const save = async () => {
    if (!settings) return;
    setWorking(true); setError(undefined); setSaved(false);
    try {
      const next = committeeId ? await api.updateDelegateFileSettings(committeeId, {...settings,
        allowedExtensions: Object.fromEntries(FILE_TYPES.map(([type]) => [type,
          [...new Set(extensions[type].split(/[,，、;；\s]+/).map(value => value.replace(/^\./, '').toLowerCase()).filter(Boolean))]])) as DelegateFileSettings['allowedExtensions']})
        : await api.updateDefaultFileRejectionTypes(settings);
      setSettings(next); setDirty(false); setSaved(true);
      if (committeeId) setExtensions(Object.fromEntries(FILE_TYPES.map(([type]) => [type, (next as DelegateFileSettings).allowedExtensions[type].join(', ')])));
    } catch (caught) {
      if (caught instanceof SelfHostedApiError) {
        const missingLanguage = caught.localization?.fieldErrors?.[0]?.params?.language;
        if (isContentLanguage(missingLanguage)) setContentLanguage(missingLanguage);
      }
      setError(caught);
    }
    finally {setWorking(false);}
  };
  return <Segment className="delegate-file-settings" loading={working}>
    <Prompt when={dirty} message={t("Discard unsaved file settings?")} />
    <Header as="h2">{committeeId ? t("Rejection types") : t("Default rejection types")}</Header>
    {!committeeId && <p>{t("Used for new committees.")}</p>}
    {error && <Message error content={error} />}
    {saved && <Message positive content={t("Saved")} />}
    {settings && <Form onSubmit={() => void save()}>
      <Form.Select label={t("Content language")} value={contentLanguage} options={LANGUAGE_OPTIONS.map(item => ({...item}))}
        onChange={(_, data) => setContentLanguage(data.value as typeof contentLanguage)} />
      {settings.rejectionTypes.map((item, index) => <Segment key={item.id}>
        <Form.Group widths="equal">
          <Form.Input {...field(`rejectionTypes.${index}.label`)} label={t("Type name")} aria-label={`${t('Type name')} ${index + 1}`} required maxLength={100} value={item.label[contentLanguage] ?? ''} disabled={readOnly}
            onChange={(_, data) => {const label = data.value; changed(); setSettings({...settings,
              rejectionTypes: settings.rejectionTypes.map(row => row.id === item.id ? {...row, label: {...row.label, [contentLanguage]: label}} : row)});}} />
          <Form.Select label={t("Message mode")} value={item.custom ? 'custom' : 'preset'} disabled={readOnly} options={[
            {key: 'preset', value: 'preset', text: t("Preset message")}, {key: 'custom', value: 'custom', text: t("Chair enters a message")}]}
            onChange={(_, data) => {changed(); setSettings({...settings, rejectionTypes: settings.rejectionTypes.map(row =>
              row.id === item.id ? {...row, custom: data.value === 'custom'} : row)});}} />
        </Form.Group>
        {!item.custom && <Form.TextArea {...field(`rejectionTypes.${index}.message`)} label={t("Message to delegate")} aria-label={`${t('Message to delegate')} ${index + 1}`} required maxLength={2000}
          value={item.message[contentLanguage] ?? ''} disabled={readOnly} onChange={(_, data) => {const message = String(data.value); changed(); setSettings({...settings,
            rejectionTypes: settings.rejectionTypes.map(row => row.id === item.id ? {...row, message: {...row.message, [contentLanguage]: message}} : row)});}} />}
        {!readOnly && <Button type="button" basic negative size="small" disabled={settings.rejectionTypes.length === 1}
          onClick={() => {changed(); setSettings({...settings, rejectionTypes: settings.rejectionTypes.filter(row => row.id !== item.id)});}}>{t("Delete type")}</Button>}
      </Segment>)}
      {!readOnly && <Button type="button" basic icon="plus" content={t("Add rejection type")} disabled={settings.rejectionTypes.length >= 30}
        onClick={() => {changed(); setSettings({...settings, rejectionTypes: [...settings.rejectionTypes,
          {id: crypto.randomUUID(), label: {}, message: {}, custom: false}]});}} />}
      {committeeId && <>
        <Header as="h2">{t("File format settings")}</Header>
        {FILE_TYPES.map(([type]) => <Form.Input key={type} {...field(`allowedExtensions.${type}`)} label={t('Allowed extensions for {type}', {type: delegateFileTypeName(type, committeeLanguage ?? contentLanguage)})} value={extensions[type] ?? ''}
          disabled={readOnly} required placeholder="docx, doc, pdf" onChange={(_, data) => {changed(); setExtensions({...extensions, [type]: data.value});}} />)}
      </>}
      <div className="delegate-file-settings-actions">
        {!readOnly && <Button primary disabled={working || !dirty}><Icon name="save" />{t("Save settings")}</Button>}
        <Button type="button" disabled={working} onClick={() => dirty ? setReload(true) : void load()}>{t("Reload")}</Button>
      </div>
    </Form>}
    {!settings && !working && <Button onClick={() => void load()}>{t("Retry")}</Button>}
    <Modal size="tiny" open={reload} onClose={() => setReload(false)}><Modal.Header>{t("Discard unsaved changes?")}</Modal.Header>
      <Modal.Actions><Button onClick={() => setReload(false)}>{t("Keep editing")}</Button><Button negative onClick={() => {setReload(false); void load();}}>{t("Discard changes")}</Button></Modal.Actions></Modal>
  </Segment>;
}

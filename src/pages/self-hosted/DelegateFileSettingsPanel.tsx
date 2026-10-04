import {useApiFieldErrors} from '../../components/useApiFieldErrors';
import {apiErrorText} from '../../i18n';
import {DELEGATE_FILE_TYPES, delegateFileTypeName, isContentLanguage, type ContentLanguage} from '@quorum/contracts';
import {t, useLanguage} from '../../i18n';
import {getLanguage, LANGUAGE_OPTIONS} from '../../i18n';
import * as React from 'react';
import {Prompt} from 'react-router-dom';
import type {DefaultFileRejectionSettings, DelegateFileSettings, DelegateFileExtensionType} from '@quorum/contracts';
import {Button, Card, Form, Header, Icon, Message, Modal, Segment} from 'semantic-ui-react';
import {selfHostedApi, SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';

const FILE_TYPES: DelegateFileExtensionType[] = [...DELEGATE_FILE_TYPES, 'OTHER'];

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
  const [autoSave, setAutoSave] = React.useState(false);
  const disabled = readOnly;
  const editVersion = React.useRef(0);
  const [dirty, setDirty] = React.useState(false); const [reload, setReload] = React.useState(false);
  const load = React.useCallback(async () => {
    setWorking(true); setError(undefined);
    try {
      const next = committeeId ? await api.getDelegateFileSettings(committeeId) : await api.getDefaultFileRejectionTypes();
      setSettings(next); setDirty(false); setSaved(false);
      if (committeeId) setExtensions(Object.fromEntries(FILE_TYPES.map(type => [type, (next as DelegateFileSettings).allowedExtensions[type].join(', ')])));
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
  const changed = () => {editVersion.current++; setDirty(true); setSaved(false);};
  const save = async () => {
    if (!settings) return;
    const submittedVersion = editVersion.current;
    setWorking(true); setError(undefined); setSaved(false);
    try {
      const next = committeeId ? await api.updateDelegateFileSettings(committeeId, {...settings,
        allowedExtensions: Object.fromEntries(FILE_TYPES.map(type => [type,
          [...new Set(extensions[type].split(/[,，、;；\s]+/).map(value => value.replace(/^\./, '').toLowerCase()).filter(Boolean))]])) as DelegateFileSettings['allowedExtensions']})
        : await api.updateDefaultFileRejectionTypes(settings);
      if (!committeeId && editVersion.current !== submittedVersion) {
        setSettings(current => current && {...current, revision: next.revision});
      } else {setSettings(next); setDirty(false); setSaved(true);}
      if (committeeId) setExtensions(Object.fromEntries(FILE_TYPES.map(type => [type, (next as DelegateFileSettings).allowedExtensions[type].join(', ')])));
    } catch (caught) {
      if (caught instanceof SelfHostedApiError) {
        const missingLanguage = caught.localization?.fieldErrors?.[0]?.params?.language;
        if (isContentLanguage(missingLanguage)) setContentLanguage(missingLanguage);
      }
      setError(caught);
    }
    finally {setWorking(false);}
  };
  React.useEffect(() => {
    if (committeeId || !autoSave || working || !settings) return;
    setAutoSave(false);
    if (!dirty || failure instanceof SelfHostedApiError && failure.code === 'REVISION_CONFLICT') return;
    // New rows remain local until they have a label and, for preset mode, a message.
    if (settings.rejectionTypes.some(item => !Object.values(item.label).some(text => text.trim())
      || !item.custom && !Object.values(item.message).some(text => text.trim()))) return;
    void save();
  }, [autoSave, dirty, working, settings, committeeId]);
  React.useEffect(() => {if (!saved || committeeId) return; const timer = setTimeout(() => setSaved(false), 3000); return () => clearTimeout(timer);}, [saved, committeeId]);
  const body = <>

    <Prompt when={dirty} message={t("Discard unsaved file settings?")} />
    <div className="settings-card-heading"><Header as="h2">{committeeId ? t("Rejection types") : t("Default rejection types")}</Header>
      {!committeeId && <span className={`settings-save-status${error ? ' is-error' : saved ? ' is-saved' : ''}`} role="status" aria-live="polite">
        {t(error ? 'Save failed' : working ? 'Saving…' : saved ? 'Saved' : dirty ? 'Not saved' : '')}
        {error && settings && <Button type="button" basic size="mini" disabled={working} onClick={() =>
          failure instanceof SelfHostedApiError && failure.code === 'REVISION_CONFLICT' ? setReload(true) : setAutoSave(true)}>
          {t(failure instanceof SelfHostedApiError && failure.code === 'REVISION_CONFLICT' ? 'Reload' : 'Retry')}</Button>}
      </span>}
    </div>
    {error && <Message error content={error} />}
    {saved && committeeId && <Message positive content={t("Saved")} />}
    {settings && <Form onSubmit={event => {event.preventDefault(); if (committeeId) void save();}}
      onBlur={() => {if (!committeeId) setAutoSave(true);}}
      onKeyDown={(event: React.KeyboardEvent) => {if (!committeeId && event.key === 'Enter' && !event.nativeEvent.isComposing
        && event.target instanceof HTMLInputElement) {event.preventDefault(); setAutoSave(true);}}}>
      <Form.Select label={t("Content language")} disabled={disabled} value={contentLanguage} options={LANGUAGE_OPTIONS.map(item => ({...item}))}
        onChange={(_, data) => setContentLanguage(data.value as typeof contentLanguage)} />
      {settings.rejectionTypes.map((item, index) => <Segment key={item.id}>
        <Form.Group widths="equal">
          <Form.Input {...field(`rejectionTypes.${index}.label`)} label={t("Type name")} aria-label={`${t('Type name')} ${index + 1}`} required maxLength={100} value={item.label[contentLanguage] ?? ''} disabled={disabled}
            onChange={(_, data) => {const label = data.value; changed(); setSettings({...settings,
              rejectionTypes: settings.rejectionTypes.map(row => row.id === item.id ? {...row, label: {...row.label, [contentLanguage]: label}} : row)});}} />
          <Form.Select label={t("Message mode")} value={item.custom ? 'custom' : 'preset'} disabled={disabled} options={[
            {key: 'preset', value: 'preset', text: t("Preset message")}, {key: 'custom', value: 'custom', text: t("Chair enters a message")}]}
            onChange={(_, data) => {changed(); if (!committeeId) setAutoSave(true); setSettings({...settings, rejectionTypes: settings.rejectionTypes.map(row =>
              row.id === item.id ? {...row, custom: data.value === 'custom'} : row)});}} />
        </Form.Group>
        {!item.custom && <Form.TextArea {...field(`rejectionTypes.${index}.message`)} label={t("Message to delegate")} aria-label={`${t('Message to delegate')} ${index + 1}`} required maxLength={2000}
          value={item.message[contentLanguage] ?? ''} disabled={disabled} onChange={(_, data) => {const message = String(data.value); changed(); setSettings({...settings,
            rejectionTypes: settings.rejectionTypes.map(row => row.id === item.id ? {...row, message: {...row.message, [contentLanguage]: message}} : row)});}} />}
        {!readOnly && <Button type="button" basic negative size="small" disabled={disabled || settings.rejectionTypes.length === 1}
          onClick={() => {changed(); if (!committeeId) setAutoSave(true); setSettings({...settings, rejectionTypes: settings.rejectionTypes.filter(row => row.id !== item.id)});}}>{t("Delete type")}</Button>}
      </Segment>)}
      {!readOnly && <Button type="button" basic icon="plus" content={t("Add rejection type")} disabled={disabled || settings.rejectionTypes.length >= 30}
        onClick={() => {changed(); setSettings({...settings, rejectionTypes: [...settings.rejectionTypes,
          {id: crypto.randomUUID(), label: {}, message: {}, custom: false}]});}} />}
      {committeeId && <>
        <Header as="h2">{t("File format settings")}</Header>
        {FILE_TYPES.map(type => <Form.Input key={type} {...field(`allowedExtensions.${type}`)} label={t('Allowed extensions for {type}', {type: type === 'OTHER' ? t('Other') : delegateFileTypeName(type, committeeLanguage ?? contentLanguage)})} value={extensions[type] ?? ''}
          disabled={disabled} required placeholder="docx, doc, pdf" onChange={(_, data) => {changed(); setExtensions({...extensions, [type]: data.value});}} />)}
      </>}
      {committeeId && <div className="delegate-file-settings-actions">
        {!readOnly && <Button primary disabled={working || !dirty}><Icon name="save" />{t("Save settings")}</Button>}
        <Button type="button" disabled={working} onClick={() => dirty ? setReload(true) : void load()}>{t("Reload")}</Button>
      </div>}
    </Form>}
    {!settings && !working && <Button onClick={() => void load()}>{t("Retry")}</Button>}
    <Modal size="tiny" open={reload} onClose={() => setReload(false)}><Modal.Header>{t("Discard unsaved changes?")}</Modal.Header>
      <Modal.Actions><Button onClick={() => setReload(false)}>{t("Keep editing")}</Button><Button negative onClick={() => {setReload(false); void load();}}>{t("Discard changes")}</Button></Modal.Actions></Modal>
  </>;
  return committeeId ? <Segment className="delegate-file-settings" loading={working}>{body}</Segment>
    : <Card fluid className="committee-setting-card delegate-file-settings"><Card.Content>{body}</Card.Content></Card>;
}

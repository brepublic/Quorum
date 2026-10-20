import * as React from 'react';
import {saveAs} from 'file-saver';
import {Button, Form, Icon, List, Message, Modal} from 'semantic-ui-react';
import {TEMPLATE_BUNDLE_MAX_BYTES, type ApiErrorReason, type CountryTemplate, type CommitteeTemplate,
  type TemplateBundle, type TemplateImportResult, type LocalizedNames} from '@quorum/contracts';
import {CountryFlagDisplay} from '../../components/CountryFlagDisplay';
import {apiErrorText, getLanguage, t, useLanguage} from '../../i18n';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';

function invalid(reason: ApiErrorReason): never {
  throw new SelfHostedApiError(400, 'VALIDATION_FAILED', 'Invalid template file.', undefined, undefined, {reason});
}

const displayName = (value: {names: LocalizedNames; defaultLanguage: string}) =>
  value.names[getLanguage()] || value.names[value.defaultLanguage] || Object.values(value.names)[0] || '';
const nameLanguage = (value: {names: LocalizedNames; defaultLanguage: string}) =>
  value.names[getLanguage()] ? getLanguage() : value.defaultLanguage;

function suggestedName(name: string, existing: Array<{names: LocalizedNames}>): string {
  const used = new Set(existing.flatMap(item => Object.values(item.names)));
  if (!used.has(name)) return name;
  let index = 1;
  let candidate: string;
  do {
    const suffix = index === 1 ? t(' (imported)') : t(' (imported {count})', {count: index});
    candidate = name.slice(0, 200 - suffix.length) + suffix;
    index++;
  } while (used.has(candidate));
  return candidate;
}

// Only server-validated inline images reach this step. Decode each unique image before accepting a file.
async function checkImages(bundle: TemplateBundle): Promise<void> {
  const entries = [...(bundle.countryTemplate?.countries ?? []),
    ...(bundle.kind === 'committee' ? bundle.committeeTemplate.members : [])];
  const images = new Set(entries.flatMap(item => item.flag.type === 'IMAGE' ? [item.flag.value] : []));
  for (const src of images) {
    const image = new Image();
    image.src = src;
    try {await image.decode();} catch {invalid('INVALID_WEBP_FLAG');}
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 256 || image.naturalHeight > 160) {
      invalid('FLAG_DIMENSIONS_INVALID');
    }
  }
}

export function useTemplateTransfer(options: {
  api: SelfHostedApi; kind: 'country' | 'committee'; selectedId?: string; dirty: boolean; busy: boolean;
  countryTemplates: CountryTemplate[]; committeeTemplates?: CommitteeTemplate[];
  protect: (action: () => void) => void; save: () => Promise<boolean | undefined>;
  imported: (result: TemplateImportResult) => Promise<void>;
}) {
  useLanguage();
  const [mode, setMode] = React.useState<'import' | 'export' | 'save'>();
  const [bundle, setBundle] = React.useState<TemplateBundle>();
  const [fileName, setFileName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>();
  const [name, setName] = React.useState('');
  const [countryName, setCountryName] = React.useState('');
  const [renameLanguage, setRenameLanguage] = React.useState('en');
  const [countryRenameLanguage, setCountryRenameLanguage] = React.useState('en');
  const [renamed, setRenamed] = React.useState(false);
  const [submitted, setSubmitted] = React.useState(false);
  const requestKey = React.useRef('');
  const working = React.useRef(false);
  const input = React.useRef<HTMLInputElement>(null);
  const locked = busy || options.busy;
  const close = () => {if (!working.current) {setMode(undefined); setBundle(undefined); setFailure(undefined);}};

  const prepareExport = async () => {
    if (!options.selectedId || working.current) return;
    working.current = true; setBusy(true); setFailure(undefined); setBundle(undefined); setMode('export');
    try {
      const next = await options.api.exportTemplate(options.kind, options.selectedId);
      setBundle(next);
    } catch (error) {setFailure(error);}
    finally {working.current = false; setBusy(false);}
  };
  const openImport = () => {
    setMode('import'); setBundle(undefined); setFailure(undefined); setFileName('');
    setSubmitted(false); setRenamed(false); requestKey.current = '';
  };
  const readFile = async (file: File) => {
    if (working.current) return;
    working.current = true; setBusy(true); setFailure(undefined); setBundle(undefined); setFileName(file.name);
    setSubmitted(false); requestKey.current = '';
    try {
      if (file.size > TEMPLATE_BUNDLE_MAX_BYTES) invalid('REQUEST_TOO_LARGE');
      let value: unknown;
      try {value = JSON.parse(await file.text());} catch {invalid('INVALID_TEMPLATE_BUNDLE');}
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('INVALID_TEMPLATE_BUNDLE');
      if ((value as {kind?: unknown}).kind !== options.kind) invalid('TEMPLATE_BUNDLE_KIND_MISMATCH');
      const next = await options.api.previewTemplateImport(value as Record<string, unknown>);
      await checkImages(next);
      const main = next.kind === 'country' ? next.countryTemplate : next.committeeTemplate;
      const originalName = displayName(main);
      const suggested = suggestedName(originalName, next.kind === 'country' ? options.countryTemplates : options.committeeTemplates ?? []);
      setName(suggested); setRenameLanguage(nameLanguage(main));
      const countryOriginal = next.kind === 'committee' && next.countryTemplate ? displayName(next.countryTemplate) : '';
      const countrySuggested = suggestedName(countryOriginal, options.countryTemplates);
      setCountryName(countrySuggested);
      if (next.countryTemplate) setCountryRenameLanguage(nameLanguage(next.countryTemplate));
      setRenamed(suggested !== originalName || countrySuggested !== countryOriginal);
      setBundle(next);
    } catch (error) {setFailure(error);}
    finally {working.current = false; setBusy(false);}
  };
  const importBundle = async () => {
    if (!bundle || working.current || !name.trim()) return;
    working.current = true; setBusy(true); setFailure(undefined); setSubmitted(true);
    const next = structuredClone(bundle);
    const main = next.kind === 'country' ? next.countryTemplate : next.committeeTemplate;
    main.names[renameLanguage] = name.trim();
    if (next.kind === 'committee' && next.countryTemplate) next.countryTemplate.names[countryRenameLanguage] = countryName.trim();
    requestKey.current ||= crypto.randomUUID();
    try {
      const result = await options.api.importTemplate(next, requestKey.current);
      await options.imported(result);
      setMode(undefined); setBundle(undefined);
    } catch (error) {setFailure(error);}
    finally {working.current = false; setBusy(false);}
  };
  const saveAndExport = async () => {
    setMode(undefined);
    if (await options.save()) await prepareExport();
  };
  const main = bundle && (bundle.kind === 'country' ? bundle.countryTemplate : bundle.committeeTemplate);
  const entries = bundle ? [...(bundle.countryTemplate?.countries ?? []),
    ...(bundle.kind === 'committee' ? bundle.committeeTemplate.members : [])] : [];
  const flags = [...new Map(entries.map(item => [JSON.stringify(item.flag), item])).values()];
  const imageCount = flags.filter(item => item.flag.type === 'IMAGE').length;
  const download = () => {
    if (!bundle || !main) return;
    const safeName = displayName(main).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'template';
    saveAs(new Blob([JSON.stringify(bundle)], {type: 'application/json;charset=utf-8'}), `${safeName}.quorum-template.json`);
    close();
  };
  return {
    importButton: <Button type="button" fluid basic disabled={locked} className="template-import-button"
      onClick={() => options.protect(openImport)}><Icon name="upload" />{t('Import template')}</Button>,
    exportButton: options.selectedId && <Button type="button" basic disabled={locked} onClick={() => {
      if (options.dirty) {setFailure(undefined); setMode('save');} else void prepareExport();
    }}><Icon name="download" />{t('Export template')}</Button>,
    dialogs: <Modal open={Boolean(mode)} size="small" className="template-transfer-modal"
      closeOnDimmerClick={!locked} closeOnEscape={!locked} onClose={close}>
      <Modal.Header>{mode === 'save' ? t('Save changes before exporting?') : mode === 'export'
        ? t(options.kind === 'country' ? 'Export country template' : 'Export committee template')
        : t(options.kind === 'country' ? 'Import country template' : 'Import committee template')}</Modal.Header>
      <Modal.Content scrolling>
        {mode === 'save' ? <p>{t('This template has unsaved changes.')}</p> : <>
          {mode === 'import' && <>
            <input ref={input} type="file" accept=".json,.quorum-template.json,application/json" hidden aria-label={t('Template file')}
              disabled={locked || submitted} onChange={event => {
                const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
                if (file) void readFile(file);
              }} />
            <Button type="button" basic disabled={locked || submitted} loading={busy} onClick={() => input.current?.click()}>
              <Icon name="file outline" />{t('Choose file')}</Button>
            {fileName && <p className="template-transfer-filename">{fileName}</p>}
            {!bundle && !busy && !failure && <p>{t('Quorum template file (.quorum-template.json), up to 20 MiB.')}</p>}
          </>}
          {bundle && main && <>
            {mode === 'import' ? <Form>
              <Form.Input label={t(options.kind === 'country' ? 'Country template name' : 'Template name')}
                value={name} maxLength={200} disabled={locked || submitted}
                onChange={event => setName(event.currentTarget.value)} />
              {bundle.kind === 'committee' && bundle.countryTemplate && <Form.Input label={t('Bundled country template name')}
                value={countryName} maxLength={200} disabled={locked || submitted}
                onChange={event => setCountryName(event.currentTarget.value)} />}
            </Form> : <strong className="template-transfer-name">{displayName(main)}</strong>}
            {mode === 'import' && renamed && <Message warning content={t('A template with this name exists. An imported suffix has been added.')} />}
            <List divided relaxed>
              {bundle.kind === 'committee' && <List.Item><Icon name="file alternate outline" /><List.Content>
                {t('{count} members', {count: bundle.committeeTemplate.members.length})}</List.Content></List.Item>}
              {bundle.countryTemplate ? <List.Item><Icon name="globe" /><List.Content>
                {mode === 'export' && bundle.kind === 'committee' && <List.Header>{displayName(bundle.countryTemplate)}</List.Header>}
                {t('{count} countries', {count: bundle.countryTemplate.countries.length})}
                {bundle.kind === 'committee' && <List.Description>{t(mode === 'import'
                  ? 'Creates a country template in your manager and links it automatically.' : 'Complete country template included automatically.')}</List.Description>}
              </List.Content></List.Item> : <List.Item>{t('Uses the built-in country template.')}</List.Item>}
              <List.Item>{t('{count} custom flag images included', {count: imageCount})}</List.Item>
            </List>
            <div className="template-transfer-flags" aria-label={t('Flag preview')}>
              {flags.map((item, index) => <span key={index} role="img" aria-label={displayName(item)}>
                <CountryFlagDisplay flag={item.flag} /></span>)}
            </div>
          </>}
          {mode === 'export' && busy && <p role="status">{t('Loading...')}</p>}
        </>}
        {failure != null && <Message error role="alert" content={apiErrorText(failure)} />}
      </Modal.Content>
      <Modal.Actions>
        <Button type="button" disabled={locked} onClick={close}>{t('Cancel')}</Button>
        {mode === 'save' ? <Button type="button" primary onClick={() => void saveAndExport()}>{t('Save and continue')}</Button>
          : mode === 'export' ? <Button type="button" primary disabled={locked || !bundle} onClick={download}>{t('Download file')}</Button>
            : <Button type="button" primary loading={busy} disabled={locked || !bundle || !name.trim()
              || Boolean(bundle.kind === 'committee' && bundle.countryTemplate && !countryName.trim())}
              onClick={() => void importBundle()}>{t('Import as new template')}</Button>}
      </Modal.Actions>
    </Modal>
  };
}

import * as React from 'react';
import {Prompt} from 'react-router-dom';
import {Button, Card, Checkbox, Form, Header, Icon, Message} from 'semantic-ui-react';
import {ViewportFormSelect} from '../../components/ViewportDropdown';
import {apiErrorText, t, useLanguage} from '../../i18n';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {IdentityApiError, type DefaultCommitteeBehavior, type SelfHostedIdentityClient} from '../../services/self-hosted-identity';
import {localizedDisplayName} from './TemplateManagers';

type Field = Exclude<keyof DefaultCommitteeBehavior, 'revision'>;
type Group = 'operation' | 'motions' | 'speaking' | 'crisis';
type Value = string | boolean;
type Edit = {value: Value; error?: unknown; conflict?: boolean; invalid?: boolean};
const groups: Record<Field, Group> = {creatorIsChair: 'operation', operationMode: 'operation', defaultRulePackageVersionId: 'operation',
  showMotionsOnDemand: 'motions', groupMotionTypes: 'motions', moveQueueUp: 'speaking', timersInSeparateColumns: 'speaking',
  generalSpeechMs: 'speaking', crisisAutoStartDelayMinutes: 'crisis'};
const labels: Record<Field, string> = {creatorIsChair: 'Committee creator is automatically Chair', operationMode: 'Operation mode',
  defaultRulePackageVersionId: 'Rule version', showMotionsOnDemand: 'Show motion types on demand', groupMotionTypes: 'Group motion types by category',
  moveQueueUp: "'Queue' should appear above 'Next speaking'", timersInSeparateColumns: "Alternate arrangement with 'Speaker timer' and 'Moderated Caucus timer' in separate columns",
  generalSpeechMs: 'General speakers list speaking time (seconds)', crisisAutoStartDelayMinutes: 'Crisis auto-start delay (minutes)'};
function invalid(field: Field, value: Value) {
  if (field === 'generalSpeechMs') {
    const ms = Number(value) * 1000;
    return !String(value).trim() || Number(value) < 1 || !Number.isSafeInteger(Math.round(ms))
      || Math.abs(ms - Math.round(ms)) > Number.EPSILON * Math.max(1, Math.abs(ms));
  }
  if (field === 'crisisAutoStartDelayMinutes') return !String(value).trim() || !Number.isSafeInteger(Number(value) * 60000)
    || !Number.isFinite(new Date(Date.now() + Number(value) * 60000).getTime());
  return field === 'defaultRulePackageVersionId' && !value;
}

export default function DefaultCommitteeBehaviorPanel({client, api}: {client: SelfHostedIdentityClient; api: SelfHostedApi}) {
  useLanguage();
  const current = React.useRef<DefaultCommitteeBehavior>();
  const edits = React.useRef<Partial<Record<Field, Edit>>>({});
  const queue = React.useRef(new Map<Field, Value>());
  const active = React.useRef<Field>();
  const alive = React.useRef(true);
  const saved = React.useRef<Partial<Record<Group, ReturnType<typeof setTimeout>>>>({});
  const [, redraw] = React.useReducer(n => n + 1, 0);
  const [error, setError] = React.useState<unknown>();
  const [rules, setRules] = React.useState<Awaited<ReturnType<SelfHostedApi['listRulePackages']>>>([]);
  const dirty = () => !!active.current || Object.keys(edits.current).length > 0;
  const paint = () => {if (alive.current) redraw();};
  const load = async () => {
    setError(undefined);
    try {const [settings, packages] = await Promise.all([client.getDefaultCommitteeBehavior(), api.listRulePackages()]);
      if (alive.current) {current.current = settings; setRules(packages); paint();}}
    catch (caught) {if (alive.current) setError(caught);}
  };
  React.useEffect(() => {
    alive.current = true; void load();
    const prevent = (event: BeforeUnloadEvent) => {if (dirty()) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', prevent);
    return () => {alive.current = false; queue.current.clear(); Object.values(saved.current).forEach(clearTimeout); window.removeEventListener('beforeunload', prevent);};
  }, [client, api]);
  const value = (field: Field): Value => edits.current[field]?.value ?? (field === 'generalSpeechMs'
    ? String(current.current!.generalSpeechMs / 1000) : typeof current.current![field] === 'boolean'
      ? current.current![field] as boolean : String(current.current![field] ?? ''));
  const change = (field: Field, next: Value) => {
    clearTimeout(saved.current[groups[field]]); delete saved.current[groups[field]];
    edits.current[field] = {value: next, conflict: edits.current[field]?.conflict, error: edits.current[field]?.conflict ? edits.current[field]?.error : undefined};
    queue.current.delete(field); paint();
  };
  const drain = async () => {
    if (active.current || !current.current) return;
    while (alive.current && queue.current.size) {
      const [field, submitted] = queue.current.entries().next().value as [Field, Value]; queue.current.delete(field);
      active.current = field; paint();
      try {
        const next = field === 'generalSpeechMs' ? Math.round(Number(submitted) * 1000) : field === 'crisisAutoStartDelayMinutes' ? Number(submitted) : submitted;
        const base = current.current!;
        const result: DefaultCommitteeBehavior = next === base[field] ? base
          : await client.updateDefaultCommitteeBehavior({...base, [field]: next});
        current.current = result;
        if (edits.current[field]?.value === submitted) delete edits.current[field];
        const group = groups[field]; clearTimeout(saved.current[group]);
        if (!Object.keys(edits.current).some(key => groups[key as Field] === group))
          saved.current[group] = setTimeout(() => {delete saved.current[group]; paint();}, 3000);
      } catch (caught) {
        const conflict = caught instanceof IdentityApiError && caught.code === 'REVISION_CONFLICT';
        if (edits.current[field]) edits.current[field] = {...edits.current[field]!, error: caught, conflict};
        if (conflict) {
          for (const key of Object.keys(edits.current) as Field[]) edits.current[key] = {...edits.current[key]!, error: caught, conflict: true};
          queue.current.clear();
        } else queue.current.delete(field);
      }
      active.current = undefined; paint();
    }
  };
  const commit = (field: Field) => {
    const edit = edits.current[field]; if (!edit || edit.conflict) return;
    edit.invalid = Boolean(invalid(field, edit.value));
    if (edit.invalid) {paint(); return;}
    edit.error = undefined; queue.current.set(field, edit.value); paint(); void drain();
  };
  const select = (field: Field, next: Value) => {change(field, next); commit(field);};
  const reload = async () => {
    try {const next = await client.getDefaultCommitteeBehavior(); if (!alive.current) return;
      current.current = next;
      // Conflicts affect this settings document's shared revision. Discard only
      // fields explicitly marked conflicted, keeping unrelated pending input.
      for (const field of Object.keys(edits.current) as Field[]) if (edits.current[field]?.conflict) delete edits.current[field];
      setError(undefined); paint();
    } catch (caught) {setError(caught);}
  };
  const heading = (group: Group, title: string) => {
    const fields = (Object.keys(edits.current) as Field[]).filter(field => groups[field] === group);
    const failed = fields.some(field => edits.current[field]?.error);
    const bad = fields.some(field => edits.current[field]?.invalid);
    const saving = active.current && groups[active.current] === group || [...queue.current.keys()].some(field => groups[field] === group);
    const status = failed ? 'Save failed' : bad ? 'Check input' : saving ? 'Saving…' : fields.length ? 'Not saved' : saved.current[group] ? 'Saved' : '';
    return <div className="settings-card-heading"><Header as="h2">{t(title)}</Header>
      <span className={`settings-save-status${failed || bad ? ' is-error' : status === 'Saved' ? ' is-saved' : ''}`} role="status" aria-live="polite">{t(status)}
        {failed && <Button basic size="mini" disabled={!!active.current} onClick={() => fields.some(field => edits.current[field]?.conflict)
          ? void reload() : fields.forEach(commit)}>{t(fields.some(field => edits.current[field]?.conflict) ? 'Reload' : 'Retry')}</Button>}
      </span></div>;
  };
  const errors = (group: Group) => (Object.keys(edits.current) as Field[]).filter(field => groups[field] === group && edits.current[field]?.error)
    .map(field => <Message key={field} negative role="alert"><strong>{t(labels[field])}</strong><p>{edits.current[field]?.conflict
      ? t('This setting changed elsewhere. Reload it before editing again.') : apiErrorText(edits.current[field]?.error)}</p></Message>);
  const toggle = (field: Field) => <Checkbox toggle label={t(labels[field])} aria-label={t(labels[field])}
    checked={Boolean(value(field))} onChange={(_, data) => select(field, !!data.checked)} />;
  const number = (field: 'generalSpeechMs' | 'crisisAutoStartDelayMinutes') => <Form onSubmit={event => event.preventDefault()}><Form.Input
    id={`default-${field}`} label={t(labels[field])} aria-label={t(labels[field])} type="number" step="any" min={field === 'generalSpeechMs' ? 1 : undefined}
    value={String(value(field))} error={edits.current[field]?.invalid ? t(field === 'generalSpeechMs'
      ? 'Enter a speaking time of at least 1 second, with millisecond precision.' : 'Enter a valid delay in minutes.') : undefined}
    onChange={(_, data) => change(field, data.value)} onBlur={() => commit(field)}
    onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {if (event.key === 'Enter' && !event.nativeEvent.isComposing) {event.preventDefault(); commit(field);}}} /></Form>;
  const options = rules.filter(pkg => pkg.scope !== 'COMMITTEE').flatMap(pkg => pkg.versions.filter(version => version.status === 'PUBLISHED'
    && (pkg.scope !== 'BUILTIN' || pkg.key !== 'builtin:beijing-academic'
      || !pkg.versions.some(next => next.status === 'PUBLISHED' && next.version > version.version)))
    .map(version => ({key: version.id, value: version.id, text: localizedDisplayName(version.names, 'en')})));
  return <>
    <Prompt when={dirty()} message={t('Discard unsaved changes?')} />
    {!!error && <Message negative role="alert">{apiErrorText(error)} <Button onClick={() => void load()}>{t('Retry')}</Button></Message>}
    {!current.current ? !error && <Icon loading name="circle notched" /> : <>
      <Card fluid className="committee-setting-card"><Card.Content>{heading('operation', 'Committee operation')}
        <div className="committee-layout-toggles">{toggle('creatorIsChair')}</div>
        <Form onSubmit={event => event.preventDefault()}><div className="settings-field-grid">
          <Form.Select label={t('Operation mode')} aria-label={t('Operation mode')} selectOnBlur={false} value={String(value('operationMode'))}
            options={['CHAIR_OPERATED', 'DELEGATE_OPERATED'].map(mode => ({key: mode, value: mode, text: t(mode)}))}
            onChange={(_, data) => select('operationMode', String(data.value))} />
          <ViewportFormSelect label={t('Rule version')} aria-label={t('Rule version')} selectOnBlur={false} value={String(value('defaultRulePackageVersionId'))}
            options={options} onChange={(_, data) => select('defaultRulePackageVersionId', String(data.value))} />
        </div></Form>{errors('operation')}
      </Card.Content></Card>
      <Card fluid className="committee-setting-card"><Card.Content>{heading('motions', 'Motion display')}
        <div className="committee-layout-toggles">{toggle('showMotionsOnDemand')}{toggle('groupMotionTypes')}</div>{errors('motions')}
      </Card.Content></Card>
      <Card fluid className="committee-setting-card"><Card.Content>{heading('speaking', 'Speaking and timers')}
        <div className="committee-layout-toggles">{toggle('moveQueueUp')}{toggle('timersInSeparateColumns')}</div>{number('generalSpeechMs')}{errors('speaking')}
      </Card.Content></Card>
      <Card fluid className="committee-setting-card"><Card.Content>{heading('crisis', 'Crisis')}{number('crisisAutoStartDelayMinutes')}
        <p className="settings-field-help">{t('0: start immediately; negative: do not start automatically.')}</p>{errors('crisis')}
      </Card.Content></Card>
    </>}
  </>;
}

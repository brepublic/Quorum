import {ViewportFormSelect} from '../../components/ViewportDropdown';
import * as React from 'react';
import type {CommitteeWorkspaceSnapshot} from '@quorum/contracts';
import {Prompt, useHistory} from 'react-router-dom';
import {Button, Card, Checkbox, Container, Form, Header, Icon, Label, List, Message, Modal} from 'semantic-ui-react';
import {apiErrorText, LANGUAGE_OPTIONS, t, useLanguage} from '../../i18n';
import {SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';
import {localizedDisplayName} from './TemplateManagers';

type Snapshot = CommitteeWorkspaceSnapshot;
function settings(snapshot: Snapshot) {
  const list = snapshot.speakerLists?.find(item => item.kind === 'GENERAL');
  return {
    name: snapshot.committee.name, topic: snapshot.committee.topic, conference: snapshot.committee.conference,
    visibility: snapshot.committee.visibility, operationMode: snapshot.committee.operationMode,
    rules: snapshot.committee.activeRulePackageVersionId,
    showMotionsOnDemand: snapshot.motionSettings.showMotionsOnDemand, groupMotionTypes: snapshot.motionSettings.groupMotionTypes,
    moveQueueUp: snapshot.layoutSettings.moveQueueUp, timersInSeparateColumns: snapshot.layoutSettings.timersInSeparateColumns,
    duration: String((list?.defaultSpeechMs ?? 120_000) / 1000), delay: String(snapshot.crisisAutoStartDelayMinutes ?? 5)
  };
}
type Field = keyof ReturnType<typeof settings>;
type Value = string | boolean;
type Group = 'profile' | 'operation' | 'motions' | 'speaking' | 'crisis';
const groups: Record<Field, Group> = {name: 'profile', topic: 'profile', conference: 'profile', visibility: 'profile',
  operationMode: 'operation', rules: 'operation', showMotionsOnDemand: 'motions', groupMotionTypes: 'motions',
  moveQueueUp: 'speaking', timersInSeparateColumns: 'speaking', duration: 'speaking', delay: 'crisis'};
const labels: Record<Field, string> = {name: 'Committee name', topic: 'Topic', conference: 'Conference', visibility: 'Visibility',
  operationMode: 'Operation mode', rules: 'Rule version', showMotionsOnDemand: 'Show motion types on demand',
  groupMotionTypes: 'Group motion types by category', moveQueueUp: "'Queue' should appear above 'Next speaking'",
  timersInSeparateColumns: "Alternate arrangement with 'Speaker timer' and 'Moderated Caucus timer' in separate columns",
  duration: 'General speakers list speaking time (seconds)', delay: 'Crisis auto-start delay (minutes)'};
type Edit = {value: Value; baseline: Value; listId?: string; error?: unknown; validation?: string; conflict?: boolean};
const normalized = (field: Field, value: Value): Value => field === 'name' ? String(value).trim()
  : field === 'duration' || field === 'delay' ? String(Number(value)) : value;
function speechMilliseconds(value: Value): number { return Math.round(Number(value) * 1000); }
function validation(field: Field, value: Value): string | undefined {
  if (field === 'name' && (!String(value).trim() || String(value).trim().length > 200)) return 'Enter a committee name of 1–200 characters.';
  if (field === 'topic' && String(value).length > 500) return 'Use no more than 500 characters.';
  if (field === 'conference' && String(value).length > 200) return 'Use no more than 200 characters.';
  const milliseconds = Number(value) * 1000;
  if (field === 'duration' && (!String(value).trim() || Number(value) < 1 || !Number.isSafeInteger(speechMilliseconds(value))
    || Math.abs(milliseconds - speechMilliseconds(value)) > Number.EPSILON * Math.max(1, Math.abs(milliseconds)))) {
    return 'Enter a speaking time of at least 1 second, with millisecond precision.';
  }
  if (field === 'delay' && (!String(value).trim() || !Number.isSafeInteger(Number(value) * 60000)
    || !Number.isFinite(new Date(Date.now() + Number(value) * 60000).getTime()))) return 'Enter a valid delay in minutes.';
}

export default function CommitteeSettingsPanel({snapshot, api, canChair, refresh}: {
  snapshot: Snapshot; api: SelfHostedApi; canChair: boolean; refresh(): Promise<Snapshot | undefined>;
}) {
  useLanguage();
  const history = useHistory();
  const latest = React.useRef(snapshot);
  const edits = React.useRef<Partial<Record<Field, Edit>>>({});
  const queue = React.useRef(new Map<Field, Value>());
  const active = React.useRef<{field: Field; value: Value}>();
  const draining = React.useRef(false);
  const mounted = React.useRef(true);
  const saved = React.useRef<Partial<Record<Group, ReturnType<typeof setTimeout>>>>({});
  const [, redraw] = React.useReducer(value => value + 1, 0);
  const [rulePackages, setRulePackages] = React.useState<Awaited<ReturnType<SelfHostedApi['listRulePackages']>>>([]);
  const [ruleError, setRuleError] = React.useState<unknown>();
  const [dialog, setDialog] = React.useState<'pause' | 'archive' | 'delete'>();
  const [dialogRevision, setDialogRevision] = React.useState<number>();
  const [pending, setPending] = React.useState(false);
  const [lifecycleError, setLifecycleError] = React.useState<unknown>();
  const [deleteName, setDeleteName] = React.useState('');
  const owner = snapshot.viewer.audience === 'OWNER';
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const available = React.useRef({owner, canChair, readOnly});
  available.current = {owner, canChair, readOnly};
  const paint = () => {if (mounted.current) redraw();};
  const dirty = () => Object.keys(edits.current).length > 0 || !!active.current || queue.current.size > 0;
  const clearSaved = (group: Group) => {clearTimeout(saved.current[group]); delete saved.current[group];};
  const acceptSnapshot = (next: Snapshot) => {
    if (next.committee.id !== latest.current.committee.id) return;
    const oldList = latest.current.speakerLists?.find(list => list.kind === 'GENERAL');
    const nextList = next.speakerLists?.find(list => list.kind === 'GENERAL');
    const speakerLists = oldList && nextList?.id === oldList.id && nextList.revision < oldList.revision
      ? latest.current.speakerLists : next.speakerLists;
    if (next.committee.revision >= latest.current.committee.revision) latest.current = {...next, speakerLists};
    else latest.current = {...latest.current, speakerLists};
    paint();
  };
  React.useEffect(() => {acceptSnapshot(snapshot);}, [snapshot]);
  React.useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {if (dirty()) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', beforeUnload);
    return () => {mounted.current = false; queue.current.clear(); Object.values(saved.current).forEach(clearTimeout);
      window.removeEventListener('beforeunload', beforeUnload);};
  }, []);
  const loadRules = async () => {
    setRuleError(undefined);
    try {const result = await api.listRulePackages(); if (mounted.current) setRulePackages(result);}
    catch (error) {if (mounted.current) setRuleError(error);}
  };
  React.useEffect(() => {if (canChair || owner && readOnly) void loadRules();}, [api, canChair, owner, readOnly]);
  const canEdit = (field: Field) => {
    const permission = available.current;
    return !permission.readOnly && (groups[field] === 'profile' ? permission.owner : permission.canChair)
      && (!['duration', 'delay'].includes(field) || latest.current.committee.status === 'ACTIVE')
      && (field !== 'duration' || !!latest.current.speakerLists?.find(list => list.kind === 'GENERAL'));
  };
  const value = (field: Field) => edits.current[field]?.value ?? settings(latest.current)[field];
  const change = (field: Field, next: Value) => {
    if (!canEdit(field)) return;
    clearSaved(groups[field]);
    const previous = edits.current[field];
    edits.current[field] = {value: next, baseline: previous?.baseline ?? settings(latest.current)[field],
      listId: previous?.listId ?? latest.current.speakerLists?.find(list => list.kind === 'GENERAL')?.id};
    queue.current.delete(field);
    paint();
  };
  const savedField = (field: Field, submitted: Value) => {
    const edit = edits.current[field];
    if (edit && normalized(field, edit.value) === normalized(field, submitted)) delete edits.current[field];
    else if (edit) edits.current[field] = {...edit, baseline: normalized(field, submitted)};
    const group = groups[field];
    if (!Object.keys(edits.current).some(key => groups[key as Field] === group)) {
      clearSaved(group);
      saved.current[group] = setTimeout(() => {delete saved.current[group]; paint();}, 3000);
    }
  };
  const saveField = async (field: Field, submitted: Value) => {
    const current = latest.current, {id, revision} = current.committee;
    const next = normalized(field, submitted);
    let changed = current;
    if (groups[field] === 'profile') {
      const committee = await api.updateCommittee(id, revision, {[field]: next});
      changed = {...current, committee};
    } else if (field === 'operationMode') {
      changed = {...current, committee: await api.setOperationMode(id, next as Snapshot['committee']['operationMode'], revision)};
    } else if (field === 'rules') {
      changed = {...current, committee: await api.activateRules(id, String(next), revision)};
    } else if (field === 'showMotionsOnDemand' || field === 'groupMotionTypes') {
      const motionSettings = await api.setMotionSettings(id, {...current.motionSettings, [field]: Boolean(next)}, revision);
      changed = {...current, motionSettings, committee: {...current.committee, revision: motionSettings.revision}};
    } else if (field === 'moveQueueUp' || field === 'timersInSeparateColumns') {
      const layoutSettings = await api.setLayoutSettings(id, {...current.layoutSettings, [field]: Boolean(next)}, revision);
      changed = {...current, layoutSettings, committee: {...current.committee, revision: layoutSettings.revision}};
    } else if (field === 'duration') {
      const list = current.speakerLists!.find(item => item.kind === 'GENERAL')!;
      const updated = await api.updateSpeakerList(list.id, list.revision, {defaultSpeechMs: speechMilliseconds(next)});
      changed = {...current, speakerLists: current.speakerLists!.map(item => item.id === list.id ? updated : item)};
    } else {
      const result = await api.setCrisisAutoStartDelay(id, revision, Number(next));
      // This existing endpoint increments the committee revision once but returns only the delay.
      changed = {...current, crisisAutoStartDelayMinutes: result.minutes, committee: {...current.committee, revision: revision + 1}};
    }
    acceptSnapshot(changed);
  };
  const drain = async () => {
    if (draining.current) return;
    draining.current = true;
    while (mounted.current && queue.current.size) {
      const [field, submitted] = queue.current.entries().next().value as [Field, Value];
      queue.current.delete(field);
      const edit = edits.current[field];
      if (!edit) continue;
      active.current = {field, value: submitted}; paint();
      try {
        if (!canEdit(field)) throw new Error('Settings are read-only.');
        const current = settings(latest.current)[field];
        if (field === 'duration' && edit.listId !== latest.current.speakerLists?.find(list => list.kind === 'GENERAL')?.id) {
          edits.current[field] = {...edit, conflict: true}; throw new Error('Settings changed elsewhere.');
        }
        if (normalized(field, current) !== normalized(field, submitted)) {
          if (normalized(field, current) !== normalized(field, edit.baseline)) {
            edits.current[field] = {...edit, conflict: true}; throw new Error('Settings changed elsewhere.');
          }
          await saveField(field, submitted);
        }
        savedField(field, submitted);
      } catch (error) {
        const remaining = edits.current[field];
        if (remaining) edits.current[field] = {...remaining, error,
          conflict: remaining.conflict || error instanceof SelfHostedApiError && error.code === 'REVISION_CONFLICT'};
        queue.current.delete(field);
      }
      const fresh = await refresh();
      if (mounted.current && fresh) acceptSnapshot(fresh);
      active.current = undefined; paint();
    }
    draining.current = false;
  };
  const commit = (field: Field) => {
    const edit = edits.current[field];
    if (!edit || !canEdit(field)) return;
    const invalid = validation(field, edit.value);
    edits.current[field] = {...edit, validation: invalid};
    if (invalid || edit.conflict || edit.error) {paint(); return;}
    if (active.current?.field === field && active.current.value === edit.value) return;
    if (active.current?.field !== field && normalized(field, edit.value) === normalized(field, settings(latest.current)[field])) {
      delete edits.current[field]; paint(); return;
    }
    queue.current.set(field, edit.value); paint(); void drain();
  };
  const select = (field: Field, next: Value) => {change(field, next); commit(field);};
  const retry = (group: Group) => {
    (Object.keys(edits.current) as Field[]).filter(field => groups[field] === group).forEach(field => {
      const edit = edits.current[field]!;
      if (edit.error && !edit.conflict) {edits.current[field] = {...edit, error: undefined}; commit(field);}
    });
  };
  const reloadField = async (field: Field) => {
    const fresh = await refresh();
    if (!fresh || !mounted.current) return;
    acceptSnapshot(fresh); delete edits.current[field]; queue.current.delete(field); paint();
  };
  const status = (group: Group) => {
    const fields = (Object.keys(edits.current) as Field[]).filter(field => groups[field] === group);
    const failed = fields.some(field => edits.current[field]?.error);
    const saving = active.current && groups[active.current.field] === group || [...queue.current.keys()].some(field => groups[field] === group);
    const invalid = fields.some(field => edits.current[field]?.validation);
    const text = failed ? 'Save failed' : invalid ? 'Check input' : saving ? 'Saving…' : fields.length ? 'Not saved' : saved.current[group] ? 'Saved' : '';
    return <span className={`settings-save-status${failed || invalid ? ' is-error' : text === 'Saved' ? ' is-saved' : ''}`} role="status" aria-live="polite">
      {text && <><Icon name={failed || invalid ? 'exclamation circle' : saving ? 'circle notched' : text === 'Saved' ? 'check' : 'pencil'} loading={!!saving && !failed && !invalid} />{t(text)}</>}
      {failed && fields.some(field => edits.current[field]?.error && !edits.current[field]?.conflict) &&
        <Button type="button" basic size="mini" disabled={!!saving} onClick={() => retry(group)}>{t('Retry')}</Button>}
    </span>;
  };
  const errors = (group: Group) => (Object.keys(edits.current) as Field[]).filter(field => groups[field] === group && edits.current[field]?.error).map(field =>
    <Message key={field} negative role="alert"><strong>{t(labels[field])}</strong><p>{edits.current[field]?.conflict
      ? t('This setting changed elsewhere. Reload it before editing again.') : apiErrorText(edits.current[field]?.error)}</p>
      {edits.current[field]?.conflict && <Button type="button" size="mini" onClick={() => void reloadField(field)}>{t('Reload')}</Button>}
    </Message>);
  const heading = (group: Group, title: string) => <div className="settings-card-heading"><Header as="h2">{t(title)}</Header>{status(group)}</div>;
  const input = (field: 'name' | 'topic' | 'conference' | 'duration' | 'delay') => <Form.Input id={`committee-setting-${field}`}
    label={t(labels[field])} aria-label={t(labels[field])} type={field === 'duration' || field === 'delay' ? 'number' : 'text'}
    min={field === 'duration' ? 1 : undefined} step={field === 'duration' || field === 'delay' ? 'any' : undefined}
    value={String(value(field))} disabled={!canEdit(field) || pending} error={edits.current[field]?.validation ? t(edits.current[field]!.validation!) : undefined}
    onChange={(_, data) => change(field, data.value)} onBlur={() => commit(field)}
    onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {if (event.key === 'Enter' && !event.nativeEvent.isComposing) {event.preventDefault(); commit(field);}}} />;
  const toggle = (field: 'showMotionsOnDemand' | 'groupMotionTypes' | 'moveQueueUp' | 'timersInSeparateColumns') =>
    <Checkbox toggle aria-label={t(labels[field])} label={t(labels[field])} checked={Boolean(value(field))}
      disabled={!canEdit(field) || pending} onChange={(_, data) => select(field, !!data.checked)} />;
  const lifecycle = async (action: 'pause' | 'resume' | 'archive' | 'delete', revision = latest.current.committee.revision) => {
    if (dirty() || pending) return;
    setPending(true); setLifecycleError(undefined);
    try {
      const id = latest.current.committee.id;
      if (action === 'delete') {await api.requestCommitteeDeletion(id, revision, deleteName); history.replace('/committees');}
      else if (action === 'archive') acceptSnapshot({...latest.current, committee: await api.archiveCommittee(id, revision)});
      else acceptSnapshot({...latest.current, committee: await api.setCommitteeStatus(id, action === 'resume' ? 'ACTIVE' : 'PAUSED', revision, action === 'pause' && dialog === 'pause')});
      setDialog(undefined);
    } catch (error) {setLifecycleError(error);}
    finally {await refresh(); if (mounted.current) setPending(false);}
  };
  const openDialog = (next: 'pause' | 'archive' | 'delete') => {
    if (dirty() || pending) return;
    setDialog(next); setDialogRevision(latest.current.committee.revision); setDeleteName(''); setLifecycleError(undefined);
  };
  const selectedRule = rulePackages.flatMap(pkg => pkg.versions).find(version => version.id === value('rules'));
  const selectedRuleNames = selectedRule?.names ?? (value('rules') === snapshot.activeRules.versionId ? snapshot.activeRules.names : undefined);
  const ruleOptions = rulePackages.flatMap(pkg => pkg.versions.filter(version => version.status === 'PUBLISHED'
    && (pkg.scope !== 'BUILTIN' || pkg.key !== 'builtin:beijing-academic'
      || !pkg.versions.some(next => next.status === 'PUBLISHED' && next.version > version.version)))
    .map(version => ({key: version.id, value: version.id, text: localizedDisplayName(version.names, 'en')})));
  const blocked = dirty() || pending;
  const ordinary = canChair || owner && readOnly;
  return <Container className="committee-settings-page">
    <Prompt when={dirty()} message={t('Discard unsaved changes?')} />
    <Header as="h1">{t('Committee settings')}</Header>
    <Card fluid className="committee-setting-card" data-settings-group="profile"><Card.Content>
      {heading('profile', 'Committee profile')}<p className="settings-language">{t('Committee language')}: {LANGUAGE_OPTIONS.find(option => option.value === snapshot.committee.committeeLanguage)?.text}</p>
      <Form onSubmit={event => event.preventDefault()}>
        {input('name')}{input('topic')}<div className="settings-field-grid">{input('conference')}
          <Form.Select label={t('Visibility')} aria-label={t('Visibility')} value={String(value('visibility'))} selectOnBlur={false}
            disabled={!canEdit('visibility') || pending} options={['PRIVATE', 'PUBLIC'].map(item => ({key: item, value: item, text: t(item)}))}
            onChange={(_, data) => select('visibility', String(data.value))} />
        </div>
      </Form>{errors('profile')}
    </Card.Content></Card>
    {ordinary && <>
      <Card fluid className="committee-setting-card" data-settings-group="operation"><Card.Content>{heading('operation', 'Committee operation')}
        <Form onSubmit={event => event.preventDefault()}><div className="settings-field-grid">
          <Form.Select label={t('Operation mode')} aria-label={t('Operation mode')} value={String(value('operationMode'))} selectOnBlur={false}
            disabled={!canEdit('operationMode') || pending} options={['DELEGATE_OPERATED', 'CHAIR_OPERATED'].map(item => ({key: item, value: item, text: t(item)}))}
            onChange={(_, data) => select('operationMode', String(data.value))} />
          <ViewportFormSelect label={t('Rule version')} aria-label={t('Rule version')} value={String(value('rules'))} selectOnBlur={false}
            text={selectedRuleNames ? localizedDisplayName(selectedRuleNames, 'en') : undefined}
            disabled={!canEdit('rules') || pending || !!ruleError} options={ruleOptions}
            onChange={(_, data) => select('rules', String(data.value))} />
        </div></Form>{errors('operation')}{Boolean(ruleError) && <Message negative role="alert">{apiErrorText(ruleError)} <Button size="mini" onClick={() => void loadRules()}>{t('Retry')}</Button></Message>}
      </Card.Content></Card>
      <Card fluid className="committee-setting-card" data-settings-group="motions"><Card.Content>{heading('motions', 'Motion display')}
        <div className="committee-layout-toggles">{toggle('showMotionsOnDemand')}{toggle('groupMotionTypes')}</div>{errors('motions')}
      </Card.Content></Card>
      <Card fluid className="committee-setting-card" data-settings-group="speaking"><Card.Content>{heading('speaking', 'Speaking and timers')}
        <div className="committee-layout-toggles">{toggle('moveQueueUp')}{toggle('timersInSeparateColumns')}</div>
        {latest.current.speakerLists?.some(list => list.kind === 'GENERAL') && <Form onSubmit={event => event.preventDefault()}>{input('duration')}
          <p className="settings-field-help">{t('Updates queued speaking times and resets the stopped speaker timer.')}</p></Form>}{errors('speaking')}
      </Card.Content></Card>
      <Card fluid className="committee-setting-card" data-settings-group="crisis"><Card.Content>{heading('crisis', 'Crisis')}
        <Form onSubmit={event => event.preventDefault()}>{input('delay')}<p className="settings-field-help">{t('0: start immediately; negative: do not start automatically.')} {t('Applies to subsequently published crises.')}</p></Form>{errors('crisis')}
      </Card.Content></Card>
    </>}
    {(canChair || owner) && <Card fluid className="committee-setting-card settings-lifecycle"><Card.Content>
      <div className="settings-card-heading"><Header as="h2">{t('Committee status')}</Header><Label>{t(snapshot.committee.status)}</Label></div>
      <div className="settings-action-row"><p>{t(readOnly ? 'The committee is read-only.' : snapshot.committee.status === 'PAUSED' ? 'Resume to continue proceedings.' : 'Pausing stops proceedings operations.')}</p>
        {canChair && <Button basic color={snapshot.committee.status === 'PAUSED' ? 'blue' : 'orange'} disabled={blocked} loading={pending && !dialog}
          onClick={() => {if (snapshot.committee.status === 'PAUSED') void lifecycle('resume');
            else if (snapshot.crises?.some(group => !group.endedAt)) openDialog('pause'); else void lifecycle('pause');}}>{t(snapshot.committee.status === 'PAUSED' ? 'Resume committee' : 'Pause committee')}</Button>}
        {owner && snapshot.committee.status === 'ARCHIVED' && <Button as="a" href={api.committeeExportUrl(snapshot.committee.id)} download>{t('Export records')}</Button>}
      </div>{blocked && !pending && <p className="settings-field-help">{t('Finish saving or correct unsaved settings before changing committee status.')}</p>}
      {Boolean(lifecycleError) && !dialog && <Message negative role="alert">{apiErrorText(lifecycleError)}</Message>}
    </Card.Content></Card>}
    {owner && snapshot.committee.status !== 'DELETING' && <Card fluid className="committee-setting-card settings-danger"><Card.Content>
      <Header as="h2"><Icon name="warning sign" />{t('Danger zone')}</Header>
      <div className="settings-action-row"><div><Header as="h3">{t(readOnly ? 'Permanently delete committee' : 'Archive committee')}</Header>
        <p>{t(readOnly ? 'Permanently deletes this committee, its records and files. This cannot be undone.' : 'Archiving makes the committee read-only. It cannot be reactivated.')}</p></div>
        <Button basic negative disabled={blocked} onClick={() => openDialog(readOnly ? 'delete' : 'archive')}>{t(readOnly ? 'Permanently delete committee' : 'Archive committee')}</Button>
      </div>
    </Card.Content></Card>}
    <Modal size="tiny" open={!!dialog} onClose={() => {if (!pending) setDialog(undefined);}} closeOnDimmerClick={!pending} closeOnEscape={!pending}>
      <Modal.Header>{t(dialog === 'pause' ? 'End all crises and pause committee?' : dialog === 'delete' ? 'Permanently delete committee?' : 'Confirm committee archive')}</Modal.Header>
      <Modal.Content>
        <p>{t(dialog === 'pause' ? 'Unfinished crises will end. Resuming the committee will not reopen them.' : dialog === 'delete'
          ? 'Permanently deletes this committee, its records and files. This cannot be undone.' : 'Archiving makes the committee read-only. It cannot be reactivated.')}</p>
        {dialog === 'pause' && <List>{snapshot.crises?.filter(group => !group.endedAt).map(group => <List.Item key={group.id}>{t('Crisis')} {group.sessionOrdinal}.{group.ordinal}</List.Item>)}</List>}
        {dialog === 'delete' && <Form onSubmit={event => event.preventDefault()}><Form.Input label={t('Enter “{name}” to confirm permanent deletion:').replace('{name}', snapshot.committee.name)}
          value={deleteName} disabled={pending} onChange={(_, data) => setDeleteName(data.value)} /></Form>}
        {Boolean(lifecycleError) && <Message negative role="alert">{apiErrorText(lifecycleError)}</Message>}
      </Modal.Content><Modal.Actions><Button disabled={pending} onClick={() => setDialog(undefined)}>{t('Cancel')}</Button>
        <Button negative loading={pending} disabled={pending || dialog === 'delete' && deleteName !== snapshot.committee.name}
          onClick={() => dialog && void lifecycle(dialog, dialogRevision)}>{t(dialog === 'pause' ? 'End crises and pause' : dialog === 'delete' ? 'Permanently delete committee' : 'Archive committee')}</Button>
      </Modal.Actions>
    </Modal>
  </Container>;
}

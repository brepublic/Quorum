import {useApiFieldErrors} from '../components/useApiFieldErrors';
import {useLanguage} from '../i18n';
import * as React from 'react';
import type {
  ContentLanguage,
  RulePackageSummary,
  CommitteeNote,
  CommitteePoint,
  AttendanceEventType,
  PointStatus,
  CommitteeTemplate,
  CommitteeTextPost,
  CommitteeWorkspaceSnapshot,
  CountryTemplate,
  Stage4CommitteeSeat
} from '@quorum/contracts';
import {formatCommitteeContent, committeeContentName, templateLanguageAvailability, intersectContentLanguages} from '@quorum/contracts';
import {Link, Redirect, Route, Switch, useHistory, useLocation, useParams} from 'react-router-dom';
import {Button, Card, Checkbox, Confirm, Container, Divider, Form, Grid, Header, Icon, Label, List, Menu, Message, Modal, Pagination, Popup, Segment, Table} from 'semantic-ui-react';
import Loading from '../components/Loading';
import {CountryFlagDisplay} from '../components/CountryFlagDisplay';
import {apiErrorText, LanguageMenuItem, LANGUAGE_OPTIONS, getLanguage, t} from '../i18n';
import {selfHostedApi, SelfHostedApiError, type SelfHostedApi} from '../services/self-hosted-api';
import {selfHostedIdentityClient, type SelfHostedIdentityClient, type SelfHostedUser} from '../services/self-hosted-identity';
import ProceedingsPanel from './self-hosted/ProceedingsPanel';
import FilesPanel from './self-hosted/FilesPanel';
import SystemSettings from './self-hosted/SystemSettings';
import {DelegateFileSettingsPanel} from './self-hosted/DelegateFileSettingsPanel';
import {DelegateFilePanels, DelegateFileUploadPanel} from './self-hosted/DelegateFileChairPanels';
import {AccountMenu, CommitteeNavigation} from './self-hosted/WorkspaceNavigation';
import {CommitteeWorkspaceProvider, useCommitteeWorkspace} from './self-hosted/CommitteeWorkspaceContext';
import {
  CommitteeTemplateManager,
  CountryTemplateManager,
  localizedDisplayName,
  TemplatePreview
} from './self-hosted/TemplateManagers';

const errorText = apiErrorText;

function Flag({seat}: {seat: Pick<Stage4CommitteeSeat, 'flag' | 'displayName'>}) {
  useLanguage();
  return <CountryFlagDisplay flag={seat.flag} />;
}

function AppMenu({user, logout}: {user: SelfHostedUser; logout(): void}) {
  useLanguage();
  return <Menu>
    <Menu.Item header as={Link} to="/committees">Quorum</Menu.Item>
    <Menu.Menu position="right"><AccountMenu user={user} logout={logout} /></Menu.Menu>
  </Menu>;
}

function CommitteeList({api, user, logout}: {api: SelfHostedApi; user: SelfHostedUser; logout(): void}) {
  useLanguage();
  const history = useHistory(); const [committees, setCommittees] = React.useState<Awaited<ReturnType<SelfHostedApi['listCommittees']>>>([]);
  const [deleteTarget, setDeleteTarget] = React.useState<Awaited<ReturnType<SelfHostedApi['listCommittees']>>[number]>();
  const [deleting, setDeleting] = React.useState(false);
  const [countryTemplates, setCountryTemplates] = React.useState<CountryTemplate[]>([]);
  const [committeeTemplates, setCommitteeTemplates] = React.useState<CommitteeTemplate[]>([]);
  const [rulePackages, setRulePackages] = React.useState<RulePackageSummary[]>([]);
  const [ruleVersionId, setRuleVersionId] = React.useState('');
  const [committeeLanguage, setCommitteeLanguage] = React.useState<ContentLanguage | ''>(getLanguage);
  const [name, setName] = React.useState(''); const [topic, setTopic] = React.useState(''); const [conference, setConference] = React.useState('');
  const [visibility, setVisibility] = React.useState<'PUBLIC' | 'PRIVATE'>('PRIVATE');
  const [templateId, setTemplateId] = React.useState(''); const [countryKey, setCountryKey] = React.useState('builtin:default');
  const [error, setError] = React.useState<unknown>(); const [working, setWorking] = React.useState(false);
  const field = useApiFieldErrors(error);
  const [loading, setLoading] = React.useState(true);
  const refresh = React.useCallback(async () => {
    try {
      const [nextCommittees, nextCountries, nextTemplates, nextRules] = await Promise.all([
        api.listCommittees(), api.listCountryTemplates(), api.listCommitteeTemplates(), api.listRulePackages()
      ]);
      setCommittees(nextCommittees); setCountryTemplates(nextCountries); setCommitteeTemplates(nextTemplates);
      setRulePackages(nextRules);
      setRuleVersionId(current => current || nextRules.find(pkg => pkg.key === 'builtin:beijing-academic')?.versions
        .filter(version => version.status === 'PUBLISHED').at(-1)?.id || '');
    } catch (caught) { setError(caught); } finally { setLoading(false); }
  }, [api]);
  React.useEffect(() => void refresh(), [refresh]);
  const selectedTemplate = committeeTemplates.find(item => item.id === templateId);
  const selectedCountries = countryTemplates.find(item => item.key === (selectedTemplate?.countryTemplateKey ?? countryKey));
  const ruleOptions = rulePackages.filter(pkg => pkg.scope !== 'COMMITTEE').flatMap(pkg => pkg.versions
    .filter(version => version.status === 'PUBLISHED').map(version => ({key: version.id, value: version.id,
      text: localizedDisplayName(version.names, 'en'), version})));
  const selectedRule = ruleOptions.find(item => item.value === ruleVersionId)?.version;
  const templateAvailability = selectedCountries ? templateLanguageAvailability(selectedCountries, selectedTemplate?.members) : undefined;
  const supportedLanguages = intersectContentLanguages(templateAvailability?.supportedLanguages ?? [],
    selectedRule?.languageAvailability.supportedLanguages ?? []);
  const selectedLanguageValid = committeeLanguage !== '' && supportedLanguages.includes(committeeLanguage);
  React.useEffect(() => {
    if (!loading && committeeLanguage && !supportedLanguages.includes(committeeLanguage)) setCommitteeLanguage('');
  }, [loading, committeeLanguage, supportedLanguages.join(',')]);
  const create = async () => {
    if (!selectedCountries || !selectedLanguageValid || !committeeLanguage || !selectedRule) return;
    setWorking(true); setError(undefined);
    try {
      const committee = await api.createCommittee({name: name.trim(), topic: topic.trim(), conference: conference.trim(), visibility,
        committeeLanguage, activeRulePackageVersionId: selectedRule.id, countryTemplateRevision: selectedCountries.revision,
        ...(selectedTemplate ? {committeeTemplateId: selectedTemplate.id, committeeTemplateRevision: selectedTemplate.revision}
          : {countryTemplateKey: countryKey})});
      history.push(`/committees/${committee.id}`);
    } catch (caught) { setError(caught); } finally { setWorking(false); }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true); setError(undefined);
    try {
      const archived = deleteTarget.status === 'ARCHIVED' ? deleteTarget
        : await api.archiveCommittee(deleteTarget.id, deleteTarget.revision);
      await api.requestCommitteeDeletion(archived.id, archived.revision, archived.name);
      setCommittees(current => current.filter(committee => committee.id !== deleteTarget.id));
      setDeleteTarget(undefined);
    } catch (caught) { setError(caught); } finally { setDeleting(false); }
  };
  const groups = [
    {role: 'OWNER', title: t('My created committees'), showOwner: false},
    {role: 'CHAIR', title: t('My managed committees'), showOwner: true},
    {role: 'MEMBER', title: t('My participating committees'), showOwner: true}
  ] as const;
  const committeeGroups = loading ? <Loading /> : groups.map(group => {
    const items = committees.filter(committee => committee.viewerRole === group.role
      || group.role === 'OWNER' && !committee.viewerRole && committee.ownerUserId === user.id);
    if (items.length === 0) return null;
    return <section key={group.role} className="committee-list-section">
      <Header as="h4" dividing>{group.title}</Header>
      <Card.Group itemsPerRow={1}>{items.map(committee => <Card fluid key={committee.id}
        className={group.role === 'OWNER' ? 'owner-committee-card' : undefined}>
        <Card.Content as={Link} to={`/committees/${committee.id}`}>
          <Card.Header>{committee.name}</Card.Header><Card.Meta>{t(committee.status)}</Card.Meta>
          {group.showOwner && <Card.Description>{t('Owner')}: {committee.ownerDisplayName}</Card.Description>}
        </Card.Content>
        {group.role === 'OWNER' && <button type="button" className="owner-committee-delete" data-theme-component="icon-action"
          onClick={() => setDeleteTarget(committee)}
          aria-label={t('Delete committee {name}').replace('{name}', committee.name)}>
          <Icon name="trash" /></button>}
      </Card>)}</Card.Group>
    </section>;
  });
  return <Container className="committee-create-page">
    <Header as="h1" textAlign="center">Quorum</Header>{error !== undefined && <Message error content={errorText(error)} />}
    <Grid stackable>
      <Grid.Column width={6}><Segment>
        <Header as="h3">{user.displayName}</Header>
        {committeeGroups}
        <Button basic negative fluid icon="sign-out" content={t('Logout')} onClick={logout} />
      </Segment></Grid.Column>
      {!user.isSystemAdmin && <Grid.Column width={10}><Segment><Form onSubmit={create} loading={working}>
      <Form.Group unstackable className="template-picker-row">
        <Form.Dropdown {...field('committeeTemplateId', 'committeeTemplateRevision', 'members')} className="template-picker-field" label={t('Template')} search clearable fluid selection
          placeholder={t('Template to skip manual member creation (optional)')} value={templateId}
          options={committeeTemplates.map(item => ({key: item.id, value: item.id,
            text: localizedDisplayName(item.names, item.defaultLanguage), description: item.builtin ? t('Built-in') : t('My template')}))}
          onChange={(_, data) => {const nextId = String(data.value ?? ''); const selected = committeeTemplates.find(item => item.id === nextId);
            setTemplateId(nextId); if (selected) {setCountryKey(selected.countryTemplateKey); setName(localizedDisplayName(selected.names, selected.defaultLanguage));}}} />
        <Popup basic pinned hoverable position="bottom left" trigger={<Form.Button type="button" icon="question circle outline" />}>
          <Popup.Content><TemplatePreview template={selectedTemplate} language={selectedLanguageValid ? committeeLanguage || undefined : undefined} /></Popup.Content>
        </Popup>
      </Form.Group>
      <Form.Select {...field('countryTemplateKey', 'countryTemplateRevision', 'countries')} className="template-picker-field" label={t('Country template')} required disabled={!!templateId} value={countryKey}
        options={countryTemplates.map(item => ({key: item.key, value: item.key, text: localizedDisplayName(item.names, item.defaultLanguage),
          description: item.builtin ? t('Built-in') : t('My template')}))}
        onChange={(_, data) => setCountryKey(String(data.value))} />
      <Form.Select {...field('activeRulePackageVersionId', 'rules')} label={t('Rules')} required value={ruleVersionId} options={ruleOptions}
        onChange={(_, data) => setRuleVersionId(String(data.value))} />
      <Form.Select {...field('committeeLanguage')} label={t('Committee language')} required value={committeeLanguage}
        options={LANGUAGE_OPTIONS.filter(option => supportedLanguages.includes(option.value))}
        onChange={(_, data) => setCommitteeLanguage(data.value as ContentLanguage)} />
      {!loading && supportedLanguages.length === 0 && <Message warning content={t('No common language for the selected content')} />}
      {!loading && ((templateAvailability?.missing.length ?? 0) > 0 || (selectedRule?.languageAvailability.missing.length ?? 0) > 0)
        && <details className="content-translation-errors"><summary>{t('Missing translations')}</summary><ul>
          {templateAvailability?.missing.map(issue => {
            const [section, index] = issue.path.split('.');
            const entry = section === 'countries' ? selectedCountries?.countries[Number(index)] : selectedTemplate?.members[Number(index)];
            return <li key={`${issue.language}:${issue.path}`}>{LANGUAGE_OPTIONS.find(item => item.value === issue.language)?.text} · {t(section === 'countries' ? 'Country template' : 'Template')} · {entry ? localizedDisplayName(entry.names, entry.defaultLanguage) : Number(index) + 1}</li>;
          })}
          {selectedRule?.languageAvailability.missing.map(issue => <li key={`${issue.language}:${issue.path}`}>
            {LANGUAGE_OPTIONS.find(item => item.value === issue.language)?.text} · {t('Rules')} · {issue.path}</li>)}
        </ul></details>}
      <Form.Input {...field('name')} label={t('Name')} required fluid value={name} placeholder={t('Committee name')}
        onChange={event => setName(event.currentTarget.value)} />
      <Form.Input {...field('topic')} label={t('Topic')} fluid value={topic} placeholder={t('Committee topic')}
        onChange={event => setTopic(event.currentTarget.value)} />
      <Form.Input {...field('conference')} label={t('Conference')} fluid value={conference} placeholder={t('Conference name')}
        onChange={event => setConference(event.currentTarget.value)} />
      <Form.Select label={t('Visibility')} value={visibility} options={[
        {key: 'private', value: 'PRIVATE', text: t('Private')}, {key: 'public', value: 'PUBLIC', text: t('Public')}
      ]} onChange={(_, data) => setVisibility(data.value as 'PUBLIC' | 'PRIVATE')} />
      <Button primary fluid disabled={!name.trim() || !selectedLanguageValid || !selectedRule || !selectedCountries}>{t('Create committee')}<Icon name="arrow right" /></Button>
    </Form></Segment></Grid.Column>}
    </Grid>
    <Confirm open={Boolean(deleteTarget)} header={t('Delete committee?')}
      content={t('This permanently deletes the committee and all of its records and uploaded files.')}
      cancelButton={t('Cancel')} confirmButton={{content: t('Delete committee'), primary: false, negative: true, loading: deleting, disabled: deleting}}
      onCancel={() => setDeleteTarget(undefined)}
      onConfirm={() => void remove()} />
  </Container>;
}

export function SelfHostedPublicCommittees({api = selfHostedApi}: {api?: SelfHostedApi}) {
  useLanguage();
  const [committees, setCommittees] = React.useState<Awaited<ReturnType<SelfHostedApi['listCommittees']>>>([]);
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? errorText(failure) : undefined; const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    void api.listCommittees().then(items => { if (active) setCommittees(items); })
      .catch(caught => { if (active) setError(caught); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api]);
  return <>
    <Menu><Menu.Item header>Quorum</Menu.Item><Menu.Menu position="right">
      <LanguageMenuItem /><Menu.Item as={Link} to="/login">{t('Login')}</Menu.Item>
    </Menu.Menu></Menu>
    <Container style={{padding: '1em'}}>
      <Header as="h1">{t('Public committees')}</Header>
      {error && <Message error content={error} />}
      {loading ? <Loading /> : !error && committees.length === 0 ? <Message content={t('No public committees')} /> : <Card.Group>
        {committees.map(committee => <Card key={committee.id} as={Link} to={`/committees/${committee.id}`}>
          <Card.Content><Card.Header>{committee.name}</Card.Header><Card.Meta>{t(committee.status)}</Card.Meta></Card.Content>
        </Card>)}
      </Card.Group>}
    </Container>
  </>;
}

function TextResources({kind, snapshot, run, api}: {kind: 'notes' | 'posts'; snapshot: CommitteeWorkspaceSnapshot;
  run(operation: () => Promise<unknown>): Promise<void>; api: SelfHostedApi}) {
  useLanguage();
  const [title, setTitle] = React.useState(''); const [content, setContent] = React.useState('');
  const [editingId, setEditingId] = React.useState<string>(); const [editTitle, setEditTitle] = React.useState('');
  const [editContent, setEditContent] = React.useState(''); const [pending, setPending] = React.useState<string>();
  const resources = kind === 'notes' ? snapshot.notes : snapshot.textPosts;
  const canWrite = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  const create = async () => { if (kind === 'notes') await run(() => api.createNote(snapshot.committee.id, {title, content}));
    else await run(() => api.createTextPost(snapshot.committee.id, {title, content})); setTitle(''); setContent(''); };
  const edit = async (resource: CommitteeNote | CommitteeTextPost) => {
    setPending(`edit:${resource.id}`);
    try {
      if (kind === 'notes') await run(() => api.updateNote(resource.id, resource.revision, {title: editTitle, content: editContent}));
      else await run(() => api.updateTextPost(resource.id, resource.revision, {title: editTitle, content: editContent}));
      setEditingId(undefined);
    } finally {setPending(undefined);}
  };
  const remove = (resource: CommitteeNote | CommitteeTextPost) => kind === 'notes'
    ? run(() => api.deleteNote(resource.id, resource.revision))
    : run(() => api.deleteTextPost(resource.id, resource.revision));
  return <>{canWrite && <Form onSubmit={create}><Form.Input label={t('Title')} value={title} onChange={e => setTitle(e.currentTarget.value)} />
    <Form.TextArea label={t('Content')} required value={content} onChange={(_, data) => setContent(String(data.value))} />
    <Button primary disabled={!content}>{kind === 'notes' ? t('Create note') : t('Create text post')}</Button></Form>}
    <List divided relaxed>{resources.map(resource => <List.Item key={resource.id}>{canWrite && editingId !== resource.id && <List.Content floated="right">
      <Button size="mini" onClick={() => {setEditingId(resource.id); setEditTitle(resource.title); setEditContent(resource.content);}}>{t('Edit')}</Button>
      <Button size="mini" negative onClick={() => void remove(resource)}>{t('Delete')}</Button></List.Content>}
      {editingId === resource.id ? <Form onSubmit={() => edit(resource)}><Form.Input label={t('Title')} value={editTitle}
        onChange={event => setEditTitle(event.currentTarget.value)} /><Form.TextArea label={t('Content')} value={editContent}
        onChange={(_, data) => setEditContent(String(data.value))} /><Button primary size="mini" loading={pending === `edit:${resource.id}`}
        disabled={!editContent.trim()}><Icon name="save" />{t('Save changes')}</Button><Button type="button" size="mini" onClick={() => setEditingId(undefined)}>
          {t('Cancel')}</Button></Form> : <><List.Header>{resource.title || t('Untitled')}</List.Header>
        <List.Description style={{whiteSpace: 'pre-wrap'}}>{resource.content}</List.Description></>}
    </List.Item>)}</List></>;
}

function NotesPanel({snapshot, run, api}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand; api: SelfHostedApi}) {
  useLanguage();
  const [selectedId, setSelectedId] = React.useState<string | undefined>(snapshot.notes[0]?.id);
  const selected = snapshot.notes.find(note => note.id === selectedId);
  const [title, setTitle] = React.useState(selected?.title ?? ''); const [content, setContent] = React.useState(selected?.content ?? '');
  const [pending, setPending] = React.useState<'save' | 'delete'>();
  const [dirty, setDirty] = React.useState(false);
  const editVersion = React.useRef(0);
  const canWrite = snapshot.viewer.audience !== 'PUBLIC'
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  React.useEffect(() => {
    if (dirty) return;
    const next = snapshot.notes.find(note => note.id === selectedId);
    setTitle(next?.title ?? ''); setContent(next?.content ?? '');
  }, [dirty, selectedId, selected?.revision, snapshot.notes]);
  const saveDraft = React.useCallback(async (selectCreated: boolean): Promise<boolean> => {
    if (!canWrite || !dirty || !content.trim()) return true;
    if (pending) return false;
    const version = editVersion.current; let saved = false; let createdId: string | undefined;
    setPending('save');
    await run(async () => {
      if (selected) await api.updateNote(selected.id, selected.revision, {title, content});
      else createdId = (await api.createNote(snapshot.committee.id, {title, content})).id;
      saved = true;
    });
    if (saved && editVersion.current === version) {
      setDirty(false);
      if (selectCreated && createdId) setSelectedId(createdId);
    }
    setPending(undefined);
    return saved;
  }, [api, canWrite, content, dirty, pending, run, selected, snapshot.committee.id, title]);
  React.useEffect(() => {
    if (!canWrite || !dirty || !content.trim() || pending) return;
    const timeout = window.setTimeout(() => {void saveDraft(true);}, 600);
    return () => window.clearTimeout(timeout);
  }, [canWrite, content, dirty, pending, saveDraft]);
  const selectNote = async (id: string | undefined) => {
    if (id === selectedId || pending) return;
    if (!await saveDraft(false)) return;
    setDirty(false); setSelectedId(id);
  };
  const remove = async () => {
    if (!selected) return;
    setPending('delete');
    try {await run(() => api.deleteNote(selected.id, selected.revision)); setSelectedId(undefined);}
    finally {setPending(undefined);}
  };
  return <Container className="notes-editor">
    <Menu vertical fluid aria-label={t('Note list')}>
      {snapshot.notes.map(note => <Menu.Item key={note.id} active={note.id === selectedId}
        onClick={() => void selectNote(note.id)}>
        {note.title || t('Untitled')}</Menu.Item>)}
      {canWrite && <Menu.Item active={!selectedId} onClick={() => void selectNote(undefined)}><Icon name="plus" />{t('New note')}</Menu.Item>}
    </Menu>
    <Form>
      <Form.Input id="note-title" label={t('Title')} value={title} readOnly={!canWrite}
        onChange={event => {editVersion.current += 1; setTitle(event.currentTarget.value); setDirty(true);}} />
      <Form.TextArea id="note-content" rows={12} label={t('Content')} value={content} readOnly={!canWrite}
        onChange={(_, data) => {editVersion.current += 1; setContent(String(data.value)); setDirty(true);}} />
      {canWrite && selected && <Button type="button" negative loading={pending === 'delete'} onClick={() => void remove()}>{t('Delete')}</Button>}
    </Form>
  </Container>;
}

function LinkResources({snapshot, run, api}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand; api: SelfHostedApi}) {
  useLanguage(); const [title, setTitle] = React.useState(''); const [url, setUrl] = React.useState(''); const canWrite = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE'; const links = snapshot.textPosts.filter(post => post.content.startsWith('link:')).map(post => ({post, url: post.content.slice(5)})).filter(({url}) => {try {return ['http:', 'https:'].includes(new URL(url).protocol);} catch {return false;}}); const create = async () => {if (url.trim()) {await run(() => api.createTextPost(snapshot.committee.id, {title, content: `link:${url.trim()}`})); setTitle(''); setUrl('');}}; return <><Form onSubmit={create}>{canWrite && <><Form.Input label={t('Title')} value={title} onChange={event => setTitle(event.currentTarget.value)} /><Form.Input label={t('URL')} type="url" required value={url} onChange={event => setUrl(event.currentTarget.value)} /><Button primary disabled={!url.trim()}>{t('Publish link')}</Button></>}</Form><List divided relaxed>{links.map(({post, url}) => <List.Item key={post.id}>{canWrite && <List.Content floated="right"><Button size="mini" negative onClick={() => void run(() => api.deleteTextPost(post.id, post.revision))}>{t('Delete')}</Button></List.Content>}<List.Header>{post.title || t('Untitled')}</List.Header><List.Description><a href={url} target="_blank" rel="noreferrer">{url}</a></List.Description><List.Description>{t('Publisher')}: {post.authorDisplayName}</List.Description></List.Item>)}</List></>; }
function PostsPanel({snapshot, api, userId, tab}: {snapshot: CommitteeWorkspaceSnapshot;
  api: SelfHostedApi; userId?: string; tab?: string}) {
  useLanguage();
  const canManageStorage = snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER';
  const canShare = canManageStorage && snapshot.committee.operationMode === 'CHAIR_OPERATED';
  const canUpload = snapshot.viewer.audience !== 'PUBLIC';
  const [storageConfigured, setStorageConfigured] = React.useState<boolean>();
  const [bindingError, setBindingError] = React.useState<string>();
  const [bindingReload, setBindingReload] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    if (!canManageStorage) return;
    void api.listStorageBindings(snapshot.committee.id).then(bindings => {
      if (active) {setStorageConfigured(bindings.some(binding => binding.status === 'ACTIVE')); setBindingError(undefined);}
    }).catch(caught => {if (active) setBindingError(errorText(caught));});
    return () => {active = false;};
  }, [api, canManageStorage, snapshot.committee.id, snapshot.sync.committeeEventSequence, bindingReload]);
  const base = `/committees/${snapshot.committee.id}/posts`;
  if (tab === undefined || tab === 'text' || tab === 'links' || tab === 'review') return <Redirect to={`${base}/attachments`} />;
  const active = tab === 'attachments' || (tab === 'storage' && canManageStorage)
    || (tab === 'file-settings' && canManageStorage) || (tab === 'share' && canShare)
    || (tab === 'upload' && canUpload) ? tab : 'attachments';
  const needsStorage = (active === 'upload' || active === 'share') && canManageStorage && storageConfigured === false;
  return <Container className="committee-files-page"><Menu pointing secondary aria-label={t('Resource sections')}>
    <Menu.Item as={Link} to={`${base}/attachments`} active={active === 'attachments'}>{t('File overview')}</Menu.Item>
    {canShare && <Menu.Item as={Link} to={`${base}/share`} active={active === 'share'}>{t('Share')}</Menu.Item>}
    {canUpload && <Menu.Item as={Link} to={`${base}/upload`} active={active === 'upload'}>{t('Upload files')}</Menu.Item>}
    {canManageStorage && <Menu.Item as={Link} to={`${base}/storage`} active={active === 'storage'}>{t('Storage settings')}</Menu.Item>}
    {canManageStorage && <Menu.Item as={Link} to={`${base}/file-settings`} active={active === 'file-settings'}>{t('File settings')}</Menu.Item>}
  </Menu>
    {bindingError && <Message error><p>{bindingError}</p><Button onClick={() => setBindingReload(value => value + 1)}>{t('Retry')}</Button></Message>}
    {needsStorage && <Message warning><Link to={`${base}/storage`}>{t('Configure storage before uploading or sharing files.')}</Link></Message>}
    {active === 'file-settings' && canManageStorage && <DelegateFileSettingsPanel committeeLanguage={snapshot.committee.committeeLanguage} key={snapshot.committee.id} committeeId={snapshot.committee.id} api={api}
      readOnly={!['ACTIVE', 'PAUSED'].includes(snapshot.committee.status)} />}
    {active === 'upload' && canUpload && !needsStorage && <DelegateFileUploadPanel snapshot={snapshot} api={api} />}
    {active === 'attachments' && !canManageStorage && <FilesPanel section="overview" snapshot={snapshot} api={api} currentUserId={userId} />}
    {canManageStorage && <DelegateFilePanels snapshot={snapshot} api={api} currentUserId={userId} tab={needsStorage ? '' : active} />}
    {active === 'storage' && canManageStorage && <FilesPanel section="storage" snapshot={snapshot} api={api} currentUserId={userId} />}
  </Container>;
}

type WorkspaceCommand = (operation: () => Promise<unknown>) => Promise<void>;
const ROLL_CALL_PAGE_SIZE = 9;
function rollCallResponseLabel(response: string) {
  return t(response === 'PRESENT_AND_VOTING' ? 'Present and voting'
    : response === 'PRESENT' ? 'Present' : response === 'ABSENT' ? 'Absent' : response);
}

function CommitteeOverviewPanel({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  useLanguage();
  const share = async () => navigator.clipboard?.writeText(`${window.location.origin}/committees/${snapshot.committee.id}`);
  return <Container className="committee-overview-page">
    <Card fluid className="committee-overview-card">
      <Card.Content>
        <Card.Header as="h1">{snapshot.committee.name}</Card.Header>
        <List relaxed>
          <List.Item><List.Icon name="conversation" /><List.Content><List.Header>{t('Topic')}</List.Header>
            <List.Description>{snapshot.committee.topic || '—'}</List.Description></List.Content></List.Item>
          <List.Item><List.Icon name="building outline" /><List.Content><List.Header>{t('Conference')}</List.Header>
            <List.Description>{snapshot.committee.conference || '—'}</List.Description></List.Content></List.Item>
          <List.Item><List.Icon name="signal" /><List.Content><List.Header>{t('Meeting status')}</List.Header>
            <List.Description>{t(snapshot.committee.status)}{snapshot.meetingEndedAt ? ` · ${t('Meeting ended')}` : ''}{snapshot.meetingSession ? ` · ${snapshot.meetingSession.name} · ${t(snapshot.meetingSession.status)}` : ''}</List.Description>
          </List.Content></List.Item>
        </List>
      </Card.Content>
      <Card.Content extra><Button icon="share alternate" content={t('Share committee')} onClick={() => void share()} /></Card.Content>
    </Card>
  </Container>;
}

function SetupPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand;
  api: SelfHostedApi; canChair: boolean}) {
  useLanguage();
  const [selectedCountryStableKey, setSelectedCountryStableKey] = React.useState('');
  const [seatRank, setSeatRank] = React.useState<'STANDARD' | 'NGO' | 'OBSERVER'>('STANDARD');
  const [seatHasVeto, setSeatHasVeto] = React.useState(false);
  const [seatCanVote, setSeatCanVote] = React.useState(true); const [seatMustVote, setSeatMustVote] = React.useState(false);
  const [chairEmail, setChairEmail] = React.useState(''); const [assignmentEmail, setAssignmentEmail] = React.useState('');
  const [assignmentSeatId, setAssignmentSeatId] = React.useState(snapshot.seats[0]?.id ?? '');
  const [invitationSeatId, setInvitationSeatId] = React.useState(snapshot.seats[0]?.id ?? '');
  const [invitationExpiresAt, setInvitationExpiresAt] = React.useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 16));
  const [invitationCode, setInvitationCode] = React.useState<string>(); const [pending, setPending] = React.useState<string>();
  const owner = snapshot.viewer.audience === 'OWNER';
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const execute = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key); try {await run(operation);} finally {setPending(undefined);}
  };
  const createInvitation = async () => {
    let created: Awaited<ReturnType<SelfHostedApi['createSeatInvitation']>> | undefined;
    await execute('invitation', async () => {created = await api.createSeatInvitation(snapshot.committee.id,
      {seatId: invitationSeatId, maxUses: 1, expiresAt: new Date(invitationExpiresAt).toISOString()});});
    if (created) setInvitationCode(created.code);
  };
  const rankOptions = (['STANDARD', 'NGO', 'OBSERVER'] as const)
    .map(value => ({key: value, value, text: t(value)}));
  const countryOptions = React.useMemo(() => {
    const seated = new Set(snapshot.seats.map(seat => seat.stableKey));
    return (snapshot.countryTemplate?.countries ?? []).filter(country => !seated.has(country.stableKey)).map(country => ({
      key: country.stableKey, value: country.stableKey,
      text: <><Flag seat={{displayName: committeeContentName(country.names, snapshot.committee.committeeLanguage), flag: country.flag}} />
        <span>{committeeContentName(country.names, snapshot.committee.committeeLanguage)}</span></>,
      country
    }));
  }, [snapshot.countryTemplate, snapshot.seats, snapshot.committee.committeeLanguage]);
  React.useEffect(() => {
    setSelectedCountryStableKey(current => countryOptions.some(option => option.value === current)
      ? current : String(countryOptions[0]?.value ?? ''));
  }, [countryOptions]);
  const selectedCountry = countryOptions.find(option => option.value === selectedCountryStableKey)?.country;
  type VotingPatch = Partial<Pick<Stage4CommitteeSeat, 'canVote' | 'hasVeto' | 'mustVote'>>;
  const [queuedVoting, setQueuedVoting] = React.useState<Record<string, VotingPatch>>();
  const displayedSeats = snapshot.seats.map(seat => {
    const patch = queuedVoting?.[seat.id];
    const canVote = patch?.canVote ?? seat.canVote;
    return {...seat, ...patch,
      canVote, mustVote: canVote && (patch?.mustVote ?? seat.mustVote)};
  });
  const allRank = snapshot.seats.every(seat => seat.rank === snapshot.seats[0]?.rank) ? snapshot.seats[0]?.rank : '';
  const allCanVote = displayedSeats.every(seat => seat.canVote);
  const allHasVeto = displayedSeats.every(seat => seat.hasVeto);
  const allMustVote = displayedSeats.every(seat => seat.mustVote);
  // Remember the last uniform state; arriving with mixed values starts from off.
  const lastUniformVoting = React.useRef({canVote: snapshot.seats.every(seat => seat.canVote),
    hasVeto: snapshot.seats.every(seat => seat.hasVeto), mustVote: snapshot.seats.every(seat => seat.mustVote)});
  React.useEffect(() => {
    if (pending || !displayedSeats.length) return;
    for (const field of ['canVote', 'hasVeto', 'mustVote'] as const) {
      if (displayedSeats.every(seat => seat[field])) lastUniformVoting.current[field] = true;
      else if (displayedSeats.every(seat => !seat[field])) lastUniformVoting.current[field] = false;
    }
  }, [displayedSeats, pending]);
  const queueAllVoting = (field: 'canVote' | 'hasVeto' | 'mustVote') => {
    const value = !lastUniformVoting.current[field];
    lastUniformVoting.current[field] = value;
    setQueuedVoting(current => Object.fromEntries(snapshot.seats.map(seat => {
      const next = {...seat, ...current?.[seat.id], [field]: value};
      if (field === 'hasVeto' && value) next.canVote = true;
      if (!next.canVote) {next.hasVeto = false; next.mustVote = false;}
      return [seat.id, {canVote: next.canVote, hasVeto: next.hasVeto, mustVote: next.mustVote}];
    })));
  };
  const commitQueuedVoting = React.useRef<() => void>(() => undefined);
  commitQueuedVoting.current = () => {
    if (!queuedVoting) return;
    void execute('all-voting', async () => {
      for (const seat of snapshot.seats) {
        const queued = queuedVoting[seat.id];
        if (!queued) continue;
        const canVote = queued.canVote ?? seat.canVote;
        const patch = {canVote, hasVeto: canVote && (queued.hasVeto ?? seat.hasVeto),
          mustVote: canVote && (queued.mustVote ?? seat.mustVote)};
        if (Object.entries(patch).some(([field, value]) => seat[field as keyof Stage4CommitteeSeat] !== value)) {
          await api.updateSeat(snapshot.committee.id, seat.id, seat.revision, patch);
        }
      }
    }).finally(() => setQueuedVoting(undefined));
  };
  React.useEffect(() => {
    if (!canChair || readOnly) {setQueuedVoting(undefined); return;}
    if (!queuedVoting || pending) return;
    const timer = window.setTimeout(() => commitQueuedVoting.current(), 1500);
    return () => window.clearTimeout(timer);
  }, [queuedVoting, pending, canChair, readOnly, snapshot.committee.id]);
  const updateAllSeats = (key: string, patchFor: (seat: Stage4CommitteeSeat) => Record<string, unknown>) =>
    execute(key, async () => {
      for (const seat of snapshot.seats) {
        const patch = patchFor(seat);
        if (Object.entries(patch).some(([field, value]) => seat[field as keyof Stage4CommitteeSeat] !== value)) {
          await api.updateSeat(snapshot.committee.id, seat.id, seat.revision, patch);
        }
      }
    });
  return <Container className="committee-setup-page"><Grid columns={2} stackable><Grid.Row>
    <Grid.Column width={11}><Header as="h2">{t('Seats')}</Header>
    {canChair && !readOnly && countryOptions.length > 0 && <Table className="members-table seat-create-table" compact celled definition stackable><Table.Header fullWidth><Table.Row>
      <Table.HeaderCell>{t('Seat')}</Table.HeaderCell><Table.HeaderCell>{t('Rank')}</Table.HeaderCell>
      <Table.HeaderCell>{t('Voting rights')}</Table.HeaderCell><Table.HeaderCell>{t('Veto power')}</Table.HeaderCell><Table.HeaderCell>{t('No abstention')}</Table.HeaderCell>
      {canChair && !readOnly && <Table.HeaderCell />}</Table.Row>
      {canChair && !readOnly && <Table.Row className="add-seat-row"><Table.HeaderCell><Form.Select aria-label={t('Seat')} selection
        value={selectedCountryStableKey} options={countryOptions} onChange={(_, data) => setSelectedCountryStableKey(String(data.value ?? ''))} /></Table.HeaderCell>
        <Table.HeaderCell><Form.Select aria-label={t('Rank')} search selection fluid value={seatRank} options={rankOptions}
          onChange={(_, data) => setSeatRank(data.value as typeof seatRank)} /></Table.HeaderCell>
        <Table.HeaderCell collapsing data-label={t('Voting rights')}><Form.Checkbox aria-label={t('Voting rights')} toggle checked={seatCanVote}
          onChange={(_, data) => {const canVote = data.checked ?? false;
            setSeatCanVote(canVote); if (!canVote) {setSeatMustVote(false); setSeatHasVeto(false);}}} /></Table.HeaderCell>
        <Table.HeaderCell collapsing data-label={t('Veto power')}><Form.Checkbox aria-label={t('Veto power')} toggle checked={seatHasVeto}
          onChange={(_, data) => {setSeatHasVeto(data.checked ?? false); if (data.checked) setSeatCanVote(true);}} /></Table.HeaderCell>
        <Table.HeaderCell collapsing data-label={t('No abstention')}><Form.Checkbox aria-label={t('No abstention')} toggle checked={seatMustVote}
          disabled={!seatCanVote} onChange={(_, data) => setSeatMustVote(data.checked ?? false)} /></Table.HeaderCell>
        <Table.HeaderCell collapsing><Button icon="plus" primary basic aria-label={t('Create seat')}
          loading={pending === 'create-seat'} disabled={Boolean(pending) || !selectedCountry} onClick={() => void (async () => {
            if (!selectedCountry) return;
            await execute('create-seat', () => api.createSeat(snapshot.committee.id, {
              stableKey: selectedCountry.stableKey, rank: seatRank, canVote: seatCanVote, hasVeto: seatHasVeto,
              mustVote: seatMustVote, sortOrder: snapshot.seats.length}));
            setSeatRank('STANDARD'); setSeatCanVote(true); setSeatHasVeto(false); setSeatMustVote(false);
          })()} /></Table.HeaderCell></Table.Row>}
      </Table.Header></Table>}
      <Table className="members-table seat-list-table" compact celled definition stackable>
      <Table.Header fullWidth><Table.Row><Table.HeaderCell>{t('Seat')}</Table.HeaderCell><Table.HeaderCell>{t('Rank')}</Table.HeaderCell>
        <Table.HeaderCell>{t('Voting rights')}</Table.HeaderCell><Table.HeaderCell>{t('Veto power')}</Table.HeaderCell><Table.HeaderCell>{t('No abstention')}</Table.HeaderCell>
        {canChair && !readOnly && <Table.HeaderCell />}</Table.Row></Table.Header>
      <Table.Body>
      {canChair && !readOnly && snapshot.seats.length > 0 && <Table.Row className="all-seats-row">
        <Table.Cell>{t('All seats')}{pending?.startsWith('all-') && <Icon name="spinner" loading style={{marginLeft: '0.5em'}} />}</Table.Cell>
        <Table.Cell><Form.Select aria-label={`${t('Rank')} · ${t('All seats')}`} search selection fluid
          value={allRank ?? ''} placeholder={t('Mixed seat ranks')} options={rankOptions} disabled={Boolean(pending)}
          onChange={(_, data) => {const rank = data.value as typeof seatRank;
            void updateAllSeats('all-rank', () => ({rank}));}} /></Table.Cell>
        <Table.Cell collapsing data-label={t('Voting rights')}><Form.Checkbox aria-label={`${t('Voting rights')} · ${t('All seats')}`}
          toggle checked={allCanVote} indeterminate={!allCanVote && displayedSeats.some(seat => seat.canVote)}
          disabled={Boolean(pending)}
          onChange={() => queueAllVoting('canVote')} /></Table.Cell>
        <Table.Cell collapsing data-label={t('Veto power')}><Form.Checkbox aria-label={`${t('Veto power')} · ${t('All seats')}`}
          toggle checked={allHasVeto} indeterminate={!allHasVeto && displayedSeats.some(seat => seat.hasVeto)}
          disabled={Boolean(pending)} onChange={() => queueAllVoting('hasVeto')} /></Table.Cell>
        <Table.Cell collapsing data-label={t('No abstention')}><Form.Checkbox aria-label={`${t('No abstention')} · ${t('All seats')}`}
          toggle checked={allMustVote} indeterminate={!allMustVote && displayedSeats.some(seat => seat.mustVote)}
          disabled={Boolean(pending) || !allCanVote}
          onChange={() => queueAllVoting('mustVote')} /></Table.Cell>
        <Table.Cell />
      </Table.Row>}
      {displayedSeats.map(seat => <Table.Row key={seat.id}><Table.Cell>
        <span className="committee-seat-identity"><Flag seat={seat} /><span>{seat.displayName}</span></span></Table.Cell>
        <Table.Cell>{canChair && !readOnly ? <Form.Select aria-label={`${t('Rank')} · ${seat.displayName}`}
          search selection fluid disabled={Boolean(pending)} value={seat.rank} options={rankOptions} onChange={(_, data) => {
            const rank = data.value as typeof seatRank; void execute(`rank-${seat.id}`, () => api.updateSeat(snapshot.committee.id,
              seat.id, seat.revision, {rank}));
          }} /> : t(seat.rank)}</Table.Cell>
        <Table.Cell collapsing data-label={t('Voting rights')}>{canChair && !readOnly ? <Form.Checkbox aria-label={`${t('Voting rights')} · ${seat.displayName}`}
          toggle checked={seat.canVote} disabled={Boolean(pending)} onChange={(_, data) => {
            const canVote = data.checked ?? false;
            if (queuedVoting) {
              setQueuedVoting(current => ({...current, [seat.id]: {...current?.[seat.id], canVote, hasVeto: canVote && seat.hasVeto, mustVote: canVote && seat.mustVote}}));
              return;
            }
            void execute(`voting-${seat.id}`, () => api.updateSeat(snapshot.committee.id,
              seat.id, seat.revision, {canVote, hasVeto: canVote && seat.hasVeto, mustVote: canVote && seat.mustVote}));
          }} /> : seat.canVote ? t('Voting rights') : t('Non-voting')}</Table.Cell>
        <Table.Cell collapsing data-label={t('Veto power')}>{canChair && !readOnly ? <Form.Checkbox aria-label={`${t('Veto power')} · ${seat.displayName}`}
          toggle checked={seat.hasVeto} disabled={Boolean(pending)} onChange={(_, data) => {
            const hasVeto = data.checked ?? false; const patch = {hasVeto, canVote: hasVeto || seat.canVote, mustVote: seat.mustVote};
            if (queuedVoting) {setQueuedVoting(current => ({...current, [seat.id]: {...current?.[seat.id], ...patch}})); return;}
            void execute(`veto-${seat.id}`, () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, patch));
          }} /> : seat.hasVeto ? t('Yes') : t('No')}</Table.Cell>
        <Table.Cell collapsing data-label={t('No abstention')}>{canChair && !readOnly ? <Form.Checkbox aria-label={`${t('No abstention')} · ${seat.displayName}`}
          toggle checked={seat.mustVote} disabled={Boolean(pending) || !seat.canVote} onChange={(_, data) => {
            const mustVote = data.checked ?? false;
            if (queuedVoting) {
              setQueuedVoting(current => ({...current, [seat.id]: {...current?.[seat.id], mustVote}}));
              return;
            }
            void execute(`must-vote-${seat.id}`,
              () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {mustVote}));
          }} />
          : seat.mustVote ? t('Yes') : t('No')}</Table.Cell>
        {canChair && !readOnly && <Table.Cell collapsing><Button icon="trash" basic negative disabled={Boolean(pending)}
          aria-label={`${t('Deactivate')} · ${seat.displayName}`} loading={pending === `deactivate-${seat.id}`} onClick={() => {
            if (window.confirm(t('Deactivate seat?'))) void execute(`deactivate-${seat.id}`,
              () => api.updateSeat(snapshot.committee.id, seat.id, seat.revision, {active: false}));}} /></Table.Cell>}
      </Table.Row>)}</Table.Body></Table>
      {snapshot.seats.length > 0 && <Button as={Link} to={`/committees/${snapshot.committee.id}/roll-call`} primary fluid>
        {t('Roll call')}<Icon name="arrow right" /></Button>}
    </Grid.Column><Grid.Column width={5}>
    {owner && !readOnly && <Card fluid><Card.Content><Header as="h2">{t('Chairs')}</Header>
      <Form onSubmit={async () => {await execute('grant-chair', () => api.grantChair(snapshot.committee.id,
        chairEmail.trim(), snapshot.committee.revision)); setChairEmail('');}}>
        <Form.Input label={t('Email')} required type="email" value={chairEmail} onChange={(_, data) => setChairEmail(String(data.value ?? ""))} />
        <Button primary loading={pending === 'grant-chair'} disabled={!chairEmail.trim()}>{t('Grant Chair')}</Button>
      </Form>
      <Table compact celled stackable className="committee-chairs-table">
        <Table.Header fullWidth><Table.Row><Table.HeaderCell>{t('Email')}</Table.HeaderCell>
          <Table.HeaderCell collapsing>{t('Actions')}</Table.HeaderCell></Table.Row></Table.Header>
        <Table.Body>{(snapshot.chairs ?? []).map(chair => <Table.Row key={chair.userEmail}>
          <Table.Cell>{chair.userEmail}</Table.Cell>
          <Table.Cell collapsing><Button negative loading={pending === `chair-${chair.userEmail}`}
            onClick={() => void execute(`chair-${chair.userEmail}`, () => api.revokeChair(snapshot.committee.id,
              chair.userEmail, snapshot.committee.revision))}>{t('Revoke')}</Button></Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table>
    </Card.Content></Card>}
    {canChair && !readOnly && snapshot.seats.length > 0 && <>
      <Card fluid><Card.Content><Header as="h2">{t('Seat assignments')}</Header>
      <Form onSubmit={async () => {await execute('assign-seat', () => api.assignSeat(snapshot.committee.id,
        assignmentSeatId, assignmentEmail.trim())); setAssignmentEmail('');}}>
        <Form.Select label={t('Seat')} value={assignmentSeatId} options={displayedSeats.map(seat =>
          ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setAssignmentSeatId(String(data.value))} />
        <Form.Input label={t('Email')} required type="email" value={assignmentEmail} onChange={(_, data) => setAssignmentEmail(String(data.value ?? ""))} />
        <Button primary loading={pending === 'assign-seat'} disabled={!assignmentSeatId || !assignmentEmail.trim()}>{t('Assign seat')}</Button>
      </Form>
      <List divided>{(snapshot.assignments ?? []).map(assignment => <List.Item key={assignment.id}>
        <List.Content floated="right"><Button size="mini" negative loading={pending === `assignment-${assignment.id}`}
          onClick={() => void execute(`assignment-${assignment.id}`,
            () => api.endSeatAssignment(snapshot.committee.id, assignment.id))}>{t('End assignment')}</Button></List.Content>
        <List.Header>{displayedSeats.find(seat => seat.id === assignment.seatId)?.displayName ?? assignment.seatId}</List.Header>
        <List.Description>{assignment.userEmail}</List.Description>
      </List.Item>)}</List>
      </Card.Content></Card>
      <Card fluid><Card.Content><Header as="h2">{t('One-time seat invitation')}</Header>
      <Form onSubmit={createInvitation}>
        <Form.Select label={t('Seat')} value={invitationSeatId} options={displayedSeats.map(seat =>
          ({key: seat.id, value: seat.id, text: seat.displayName}))} onChange={(_, data) => setInvitationSeatId(String(data.value))} />
        <Form.Input label={t('Expires at')} type="datetime-local" required value={invitationExpiresAt}
          onChange={event => setInvitationExpiresAt(event.currentTarget.value)} />
        <Button primary loading={pending === 'invitation'} disabled={!invitationSeatId || !invitationExpiresAt}>{t('Create invitation')}</Button>
      </Form>
      {invitationCode && <Message positive header={t('Invitation created')} content={<code>{invitationCode}</code>} />}
      </Card.Content></Card>
    </>}
    </Grid.Column></Grid.Row></Grid></Container>;
}

function SettingsPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand;
  api: SelfHostedApi; canChair: boolean}) {
  useLanguage();
  const history = useHistory();
  const [name, setName] = React.useState(snapshot.committee.name); const [topic, setTopic] = React.useState(snapshot.committee.topic);
  const [conference, setConference] = React.useState(snapshot.committee.conference);
  const [visibility, setVisibility] = React.useState(snapshot.committee.visibility); const [pending, setPending] = React.useState<string>();
  const [operationMode, setOperationMode] = React.useState(snapshot.committee.operationMode);
  const [rulePackages, setRulePackages] = React.useState<Awaited<ReturnType<SelfHostedApi['listRulePackages']>>>([]);
  const [ruleVersionId, setRuleVersionId] = React.useState(snapshot.committee.activeRulePackageVersionId);
  const [deleteName, setDeleteName] = React.useState('');
  const generalSpeakerList = (snapshot.speakerLists ?? []).find(list => list.kind === 'GENERAL');
  const [generalSpeakerSeconds, setGeneralSpeakerSeconds] = React.useState((generalSpeakerList?.defaultSpeechMs ?? 120_000) / 1000);
  const owner = snapshot.viewer.audience === 'OWNER';
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const execute = async (key: string, operation: () => Promise<unknown>) => {setPending(key); try {await run(operation);} finally {setPending(undefined);}};
  React.useEffect(() => {if (canChair) void api.listRulePackages().then(setRulePackages);}, [api, canChair]);
  const ruleOptions = rulePackages.flatMap(rulePackage => rulePackage.versions.filter(version => version.status === 'PUBLISHED')
    .map(version => ({key: version.id, value: version.id, text: localizedDisplayName(version.names, 'en')})));
  const setLayoutSetting = (patch: Partial<CommitteeWorkspaceSnapshot['layoutSettings']>) => execute('layout', () =>
    api.setLayoutSettings(snapshot.committee.id, {...snapshot.layoutSettings, ...patch}, snapshot.committee.revision));
  return <Container text className="committee-settings-page">{canChair && <><Header as="h3" attached="top">{t('Settings')}</Header><Segment attached="bottom" loading={pending === 'layout'}>
    <div className="committee-layout-toggles"><Checkbox toggle aria-label={t("'Queue' should appear above 'Next speaking'")} checked={snapshot.layoutSettings.moveQueueUp} disabled={readOnly}
      onChange={(_, data) => void setLayoutSetting({moveQueueUp: Boolean(data.checked)})}
      label={t("'Queue' should appear above 'Next speaking'")} />
    <Checkbox toggle aria-label={t("Alternate arrangement with 'Speaker timer' and 'Caucus timer' in separate columns")} checked={snapshot.layoutSettings.timersInSeparateColumns} disabled={readOnly}
      onChange={(_, data) => void setLayoutSetting({timersInSeparateColumns: Boolean(data.checked)})}
      label={t("Alternate arrangement with 'Speaker timer' and 'Caucus timer' in separate columns")} /></div>
    {generalSpeakerList && <Form onSubmit={() => execute('general-speaker-duration', () => api.updateSpeakerList(
      generalSpeakerList.id, generalSpeakerList.revision, {defaultSpeechMs: generalSpeakerSeconds * 1000}))}>
      <Form.Input type="number" min={1} label={t('Speaker time in seconds')} value={generalSpeakerSeconds} disabled={readOnly}
        onChange={event => setGeneralSpeakerSeconds(Number(event.currentTarget.value))} />
      <Button primary loading={pending === 'general-speaker-duration'} disabled={readOnly || generalSpeakerSeconds < 1}><Icon name="save" />{t('Save changes')}</Button>
    </Form>}
  </Segment></>}
    <Header as="h2">{t('Committee profile')}</Header>
    <p>{t('Committee language')}: {LANGUAGE_OPTIONS.find(option => option.value === snapshot.committee.committeeLanguage)?.text}</p>{owner && !readOnly ? <Form onSubmit={() => execute('profile',
    () => api.updateCommittee(snapshot.committee.id, snapshot.committee.revision, {name, topic, conference, visibility}))}>
      <Form.Input label={t('Committee name')} value={name} onChange={event => setName(event.currentTarget.value)} />
      <Form.Input label={t('Topic')} value={topic} onChange={event => setTopic(event.currentTarget.value)} />
      <Form.Input label={t('Conference')} value={conference} onChange={event => setConference(event.currentTarget.value)} />
      <Form.Select label={t('Visibility')} value={visibility} options={['PRIVATE', 'PUBLIC'].map(value => ({key: value, value, text: t(value)}))}
        onChange={(_, data) => setVisibility(data.value as 'PRIVATE' | 'PUBLIC')} />
      <Button primary loading={pending === 'profile'}><Icon name="save" />{t('Save changes')}</Button>
    </Form> : <List><List.Item>{snapshot.committee.name}</List.Item><List.Item>{snapshot.committee.topic}</List.Item>
      <List.Item>{snapshot.committee.conference}</List.Item></List>}
    {canChair && <><Header as="h2">{t('Committee operation')}</Header>
      <Form onSubmit={() => execute('operation-mode', () => api.setOperationMode(snapshot.committee.id, operationMode,
        snapshot.committee.revision))}><Form.Select label={t('Operation mode')} value={operationMode}
        options={(['DELEGATE_OPERATED', 'CHAIR_OPERATED'] as const).map(value => ({key: value, value, text: t(value)}))}
        onChange={(_, data) => setOperationMode(data.value as typeof operationMode)} />
        <Button primary loading={pending === 'operation-mode'}><Icon name="save" />{t('Save operation mode')}</Button></Form>
      <Form onSubmit={() => execute('rules', () => api.activateRules(snapshot.committee.id, ruleVersionId,
        snapshot.committee.revision))}><Form.Select label={t('Rule version')} value={ruleVersionId} options={ruleOptions}
        onChange={(_, data) => setRuleVersionId(String(data.value))} />
        <Button primary loading={pending === 'rules'} disabled={!ruleVersionId}>{t('Activate rule version')}</Button></Form>
      </>}
    {(canChair || owner) && <section className="committee-lifecycle-actions"><Header as="h2">{t('Committee status')}</Header>
      {canChair && <Button loading={pending === 'status'} onClick={() => void execute('status', () => api.setCommitteeStatus(snapshot.committee.id,
        snapshot.committee.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED', snapshot.committee.revision))}>
        {t(snapshot.committee.status === 'PAUSED' ? 'Resume committee' : 'Pause committee')}</Button>}
    {owner && snapshot.committee.status === 'ARCHIVED' && <><Button as="a" href={api.committeeExportUrl(snapshot.committee.id)} download>{t('Export records')}</Button>
      <Form onSubmit={() => run(async () => {await api.requestCommitteeDeletion(snapshot.committee.id,
        snapshot.committee.revision, deleteName); history.replace('/committees');})}>
        <Form.Input label={t('Enter “{name}” to confirm permanent deletion:').replace('{name}', snapshot.committee.name)}
          value={deleteName} onChange={event => setDeleteName(event.currentTarget.value)} />
        <Button negative disabled={deleteName !== snapshot.committee.name}>{t('Permanently delete committee')}</Button>
      </Form></>}
    {owner && !readOnly && <Button negative loading={pending === 'archive'} onClick={() => {if (window.confirm(t('Archive committee?'))) {
      void execute('archive', () => api.archiveCommittee(snapshot.committee.id, snapshot.committee.revision));
    }}}>{t('Archive committee')}</Button>}
    </section>}
  </Container>;
}

function RollCallPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  useLanguage();
  const chair = canChair; const session = snapshot.meetingSession; const rollCall = snapshot.rollCall;
  const nextOrdinal = session?.status === 'PENDING' ? session.ordinal : snapshot.nextMeetingSessionOrdinal;
  const sessionName = nextOrdinal ? formatCommitteeContent({kind: 'SESSION', ordinal: nextOrdinal}, snapshot.committee.committeeLanguage) : '';
  const [pending, setPending] = React.useState<string>();
  const [missingGeneralListConfirm, setMissingGeneralListConfirm] = React.useState(false);
  const [page, setPage] = React.useState(0); const [resetOpen, setResetOpen] = React.useState(false);
  const autoStartedSessionId = React.useRef<string>();
  const execute = React.useCallback(async (key: string, operation: () => Promise<unknown>) => {
    setPending(key); try {await run(operation);} finally {setPending(undefined);}
  }, [run]);
  const seats = rollCall?.seats ?? snapshot.seats;
  const entryBySeat = React.useMemo(() => new Map(rollCall?.entries.map(entry => [entry.seatId, entry]) ?? []), [rollCall?.entries]);
  const currentSeat = seats.find(seat => seat.id === rollCall?.currentSeatId);
  React.useEffect(() => {
    const index = seats.findIndex(seat => seat.id === rollCall?.currentSeatId);
    if (index >= 0) setPage(Math.floor(index / ROLL_CALL_PAGE_SIZE));
  }, [rollCall?.currentSeatId, seats]);
  React.useEffect(() => {
    if (rollCall) autoStartedSessionId.current = undefined;
  }, [rollCall?.id]);
  React.useEffect(() => {
    if (!chair || rollCall || seats.length === 0 || session?.status !== 'OPEN' || autoStartedSessionId.current === session.id) return;
    autoStartedSessionId.current = session.id;
    void execute('roll-call', () => api.startRollCall(snapshot.committee.id, session.id));
  }, [api, chair, execute, rollCall, seats.length, session?.id, session?.status, snapshot.committee.id]);
  const startMeeting = (replacement = false) => execute('meeting', async () => {
    try {
      const meeting = replacement
        ? await api.startMeetingSession(snapshot.committee.id, undefined, 'CREATE_REPLACEMENT')
        : await api.startMeetingSession(snapshot.committee.id);
      await api.startRollCall(snapshot.committee.id, meeting.id);
    } catch (caught) {
      if (!replacement && caught instanceof SelfHostedApiError && caught.code === 'RESOURCE_CONFLICT'
        && (caught.details as {reason?: unknown} | undefined)?.reason === 'GENERAL_SPEAKER_LIST_MISSING') {
        setMissingGeneralListConfirm(true);
        return;
      }
      throw caught;
    }
  });
  if (!rollCall) return <>{snapshot.meetingEndedAt && <Message content={t('Meeting ended')} />}
    {session?.status === 'OPEN' && seats.length === 0 && <Message warning content={t('Add at least one committee member to proceed')} />}
    {chair && (!session || session.status === 'PENDING') && <Segment className="roll-call-start-card">
      <Label attached="top left" size="large">{t('Set meeting session')}</Label>
      <Form onSubmit={() => startMeeting()}>
        <Form.Input value={sessionName ?? ''} readOnly fluid />
        <Button primary fluid loading={pending === 'meeting'}>{t('Start meeting')}</Button>
      </Form>
    </Segment>}<Confirm open={missingGeneralListConfirm} header={t('General speakers list missing')}
      content={t('The previous session’s general speakers list could not be restored. Create a new list and continue?')}
      cancelButton={t('Cancel')} confirmButton={t('Create and continue')}
      onCancel={() => setMissingGeneralListConfirm(false)}
      onConfirm={() => {setMissingGeneralListConfirm(false); void startMeeting(true);}} />
  </>;

  const totalPages = Math.max(1, Math.ceil(seats.length / ROLL_CALL_PAGE_SIZE));
  const activePage = Math.min(page, totalPages - 1);
  const visibleSeats = seats.slice(activePage * ROLL_CALL_PAGE_SIZE, (activePage + 1) * ROLL_CALL_PAGE_SIZE);
  const setSeat = (seatId: string) => {
    const existing = entryBySeat.get(seatId);
    const next = existing?.response === 'ABSENT' ? 'PRESENT' : existing ? 'ABSENT' : 'PRESENT';
    if (!rollCall.allowedResponses.includes(next)) return;
    return execute(`seat:${seatId}`, () => api.setRollCallResponse(rollCall.id, rollCall.revision, seatId, next));
  };
  const presentSeatIds = new Set(seats.filter(seat => {
    const attendance = rollCall.status === 'IN_PROGRESS' ? undefined
      : snapshot.attendance.find(item => item.seatId === seat.id)?.state;
    if (attendance) return attendance === 'PRESENT';
    return entryBySeat.get(seat.id)?.response !== 'ABSENT' && entryBySeat.has(seat.id);
  }).map(seat => seat.id));
  const votingSeats = seats.filter(seat => seat.canVote);
  const votingPresent = votingSeats.filter(seat => presentSeatIds.has(seat.id)).length;
  const quorum = Math.ceil(votingSeats.length / 4);
  const absentVoting = votingSeats.filter(seat => entryBySeat.get(seat.id)?.response === 'ABSENT').length;
  const simpleMajority = votingPresent > 0 ? Math.floor(votingPresent / 2) + 1 : 0;
  const twoThirdsMajority = votingPresent > 0 ? Math.ceil(votingPresent * 2 / 3) : 0;
  const quorumNotMet = votingPresent < quorum;
  const quorumImpossible = rollCall.status === 'IN_PROGRESS' && votingSeats.length - absentVoting < quorum;
  const rollCallFailed = quorumNotMet && (rollCall.status === 'COMPLETED' || quorumImpossible);
  const rollCallCompletedWithQuorum = rollCall.status === 'COMPLETED' && !quorumNotMet;
  return <Container fluid className="roll-call-page">
    <div className="roll-call-heading"><Header as="h1">{t('Roll call')}</Header><div className="roll-call-heading-actions">
      {chair && rollCall.status === 'COMPLETED' && <Button basic color="orange" icon="refresh" content={t('Restart roll call')}
        loading={pending === 'reset'} disabled={!!pending} onClick={() => setResetOpen(true)} />}
      <Label basic size="large">{t('{called} of {total} called', {called: rollCall.entries.length, total: seats.length})}</Label>
    </div></div>
    {seats.length === 0 ? <Message warning content={t('Add at least one committee member to proceed')} /> : <>
      <Segment className="roll-call-board">
        <div className="roll-call-legend" aria-label={t('Status legend')}>
          <span><i className="status-uncalled" />{t('Not called')}</span>
          <span><i className="status-absent" />{t('Absent')}</span>
          <span><i className="status-present" />{t('Present')}</span>
        </div>
        <div className="roll-call-grid">{visibleSeats.map(seat => {
          const entry = entryBySeat.get(seat.id); const status = !entry ? 'uncalled' : entry.response === 'ABSENT' ? 'absent' : 'present';
          const label = !entry ? t('Not called') : rollCallResponseLabel(entry.response);
          return <button type="button" key={seat.id} data-roll-call-seat={seat.id}
            className={`roll-call-member status-${status}${seat.id === rollCall.currentSeatId ? ' is-current' : ''}`}
            aria-label={`${seat.displayName}: ${label}`} aria-pressed={entry ? entry.response !== 'ABSENT' : undefined}
            disabled={!chair || !!pending} onClick={() => void setSeat(seat.id)}>
            <span className="roll-call-status-light" aria-hidden="true" /><span className="roll-call-member-name">{seat.displayName}</span>
          </button>;
        })}</div>
        {totalPages > 1 && <Pagination className="roll-call-pagination" activePage={activePage + 1} totalPages={totalPages}
          boundaryRange={1} siblingRange={1} ellipsisItem={null} onPageChange={(_, data) => setPage(Number(data.activePage) - 1)} />}
      </Segment>
      <Segment className="roll-call-current" textAlign="center">
        <div className="roll-call-current-status">
        {rollCallFailed ? <Header as="h2" color="red">{t('Quorum not reached')}</Header>
          : currentSeat ? <div className="roll-call-current-seat"><div className="roll-call-current-label">{t('Now calling')}</div>
            <div className="roll-call-flag-stage"><Flag seat={currentSeat} /></div>
            <Header as="h2" className="roll-call-current-name"><span>{currentSeat.displayName}</span></Header>
          </div>
          : rollCallCompletedWithQuorum ? <Header as="h2" color="green">{t('Roll call complete')}</Header>
          : <Header as="h2">{t('Roll call')}</Header>}</div>
        {chair && <div className="roll-call-actions">
          {currentSeat && rollCall.allowedResponses.map(response => <Button key={response}
            positive={response !== 'ABSENT'} negative={response === 'ABSENT'}
            icon={response === 'ABSENT' ? 'close' : 'check'} content={rollCallResponseLabel(response)}
            loading={pending === `response:${response}`} disabled={!!pending}
            onClick={() => void execute(`response:${response}`,
              () => api.recordRollCallResponse(rollCall.id, rollCall.revision, currentSeat.id, response))} />)}
          {rollCall.status === 'IN_PROGRESS' && <><Button basic icon="undo" content={t('Undo')}
            loading={pending === 'undo'} disabled={rollCall.entries.length === 0 || !!pending}
            onClick={() => void execute('undo', () => api.undoRollCall(rollCall.id, rollCall.revision))} />
            <Button basic color="orange" icon="refresh" content={t('Reset')} loading={pending === 'reset'}
              disabled={!!pending} onClick={() => setResetOpen(true)} /></>}
        </div>}
      </Segment>
      {(rollCallFailed || rollCallCompletedWithQuorum) && <Segment className="roll-call-summary">
        <div className="roll-call-summary-highlights">
          <div className="roll-call-summary-highlight highlight-present"><span className="roll-call-summary-label">{t('Present')}</span>
            <strong>{presentSeatIds.size}</strong></div>
          {rollCallFailed ? <><div className="roll-call-summary-highlight highlight-quorum"><span className="roll-call-summary-label">{t('Quorum')}</span>
            <strong>{quorum}</strong></div>
            <div className="roll-call-summary-highlight highlight-total-seats"><span className="roll-call-summary-label">{t('Total seats')}</span>
              <strong>{votingSeats.length}</strong></div></> : <><div className="roll-call-summary-highlight highlight-two-thirds"><span className="roll-call-summary-label">{t('Two-thirds majority')}</span>
              <strong>{twoThirdsMajority}</strong></div>
            <div className="roll-call-summary-highlight highlight-simple-majority"><span className="roll-call-summary-label">{t('Simple majority')}</span>
              <strong>{simpleMajority}</strong></div></>}
        </div>{rollCallCompletedWithQuorum && <Button as={Link} to={`/committees/${snapshot.committee.id}/motions`} primary fluid size="large">
          {t('Go to motions')}<Icon name="arrow right" /></Button>}</Segment>}
    </>}
    <Confirm open={resetOpen} header={t(rollCall.status === 'COMPLETED' ? 'Restart roll call?' : 'Reset roll call?')}
      content={t('This will start a new roll call for this meeting session.')}
      cancelButton={t('Cancel')} confirmButton={t(rollCall.status === 'COMPLETED' ? 'Restart roll call' : 'Reset')} onCancel={() => setResetOpen(false)}
      onConfirm={() => {setResetOpen(false); void execute('reset', () => api.resetRollCall(rollCall.id, rollCall.revision));}} />
  </Container>;
}

function PointResolutionForm({point, run, api}: {point: CommitteePoint; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi}) {
  useLanguage();
  const [status, setStatus] = React.useState<Exclude<PointStatus, 'PENDING'>>('ANSWERED');
  const [response, setResponse] = React.useState(''); const [attendance, setAttendance] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const personalPrivilege = point.pointTypeId === 'point-of-personal-privilege';
  const submit = async () => {
    setPending(true); await run(() => api.resolvePoint(point.id, {baseRevision: point.revision, status,
      ...(response.trim() ? {chairResponse: response.trim()} : {}),
      ...(personalPrivilege && attendance ? {attendanceChange: {type: attendance as AttendanceEventType}} : {})}));
    setPending(false);
  };
  return <Form onSubmit={submit} size="small">
    <Form.Select label={t('Ruling')} value={status} options={(['ANSWERED', 'UPHELD', 'OVERRULED', 'RESOLVED', 'REJECTED'] as const)
      .map(value => ({key: value, value, text: t(value)}))} onChange={(_, data) => setStatus(data.value as Exclude<PointStatus, 'PENDING'>)} />
    <Form.TextArea label={t('Chair response')} value={response} onChange={(_, data) => setResponse(String(data.value))} />
    {personalPrivilege && <Form.Select label={t('Attendance change')} value={attendance} options={[
      {key: 'none', value: '', text: t('No attendance change')},
      ...(['PRESENT', 'TEMPORARILY_LEFT', 'RETURNED', 'ABSENT'] as const).map(value => ({key: value, value, text: t(value)}))
    ]} onChange={(_, data) => setAttendance(String(data.value))} />}
    <Button primary size="mini" loading={pending}>{t('Save ruling')}</Button>
  </Form>;
}

function PointsPanel({snapshot, run, api, canChair}: {snapshot: CommitteeWorkspaceSnapshot; run(operation: () => Promise<unknown>): Promise<void>;
  api: SelfHostedApi; canChair: boolean}) {
  useLanguage();
  const types = snapshot.activeRules.pointTypes;
  const [type, setType] = React.useState(types[0]?.id ?? '');
  const [content, setContent] = React.useState('');
  const [seatId, setSeatId] = React.useState(snapshot.viewer.seatId ?? '');
  const chairOperated = snapshot.committee.operationMode === 'CHAIR_OPERATED';
  const session = snapshot.meetingSession;
  const create = async () => {if (!session) return; await run(() => api.createPoint(snapshot.committee.id,
    {meetingSessionId: session.id, pointTypeId: type, content: content.trim(),
      ...(canChair && seatId ? {onBehalfOfSeatId: seatId} : {})})); setContent('');};
  const resolve = (point: CommitteePoint, status: Exclude<PointStatus, 'PENDING'>) =>
    void run(() => api.resolvePoint(point.id, {baseRevision: point.revision, status}));
  const label = (point: CommitteePoint) => point.status === 'PENDING' ? t('PENDING')
    : point.pointTypeId === 'point-of-order' && ['UPHELD', 'OVERRULED'].includes(point.status) ? t(point.status === 'UPHELD' ? 'Point upheld' : 'Point overruled')
    : point.pointTypeId === 'point-of-information' ? t('Handled point')
    : point.pointTypeId === 'point-of-personal-privilege' && ['UPHELD', 'REJECTED'].includes(point.status) ? t(point.status === 'UPHELD' ? 'Approved point' : 'Denied point')
    : t(point.status);
  const actions = (point: CommitteePoint) => point.pointTypeId === 'point-of-order' ? <Button.Group fluid>
    <Button positive onClick={() => resolve(point, 'UPHELD')}>{t('Uphold point')}</Button>
    <Button negative onClick={() => resolve(point, 'OVERRULED')}>{t('Overrule point')}</Button></Button.Group>
    : point.pointTypeId === 'point-of-information' ? <Button primary fluid
      onClick={() => resolve(point, 'ANSWERED')}>{t('Handle point')}</Button>
    : point.pointTypeId === 'point-of-personal-privilege' ? <Button.Group fluid>
      <Button positive onClick={() => resolve(point, 'UPHELD')}>{t('Approve point')}</Button>
      <Button negative onClick={() => resolve(point, 'REJECTED')}>{t('Deny point')}</Button></Button.Group>
    : <PointResolutionForm point={point} run={run} api={api} />;
  const points = [...snapshot.points].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const sessionNames = new Map((snapshot.meetingSessions ?? []).map(item => [item.id, item.name]));
  if (snapshot.meetingSession) sessionNames.set(snapshot.meetingSession.id, snapshot.meetingSession.name);
  const pointGroups = points.reduce<Array<{meetingSessionId: string; points: typeof points}>>((groups, point) => {
    const group = groups.at(-1);
    if (group?.meetingSessionId === point.meetingSessionId) group.points.push(point);
    else groups.push({meetingSessionId: point.meetingSessionId, points: [point]});
    return groups;
  }, []);
  const canRaise = snapshot.viewer.audience !== 'PUBLIC' && snapshot.committee.status === 'ACTIVE';
  return <Container text className="points-page">
    {canRaise && session?.status === 'OPEN' && types.length === 0 && <Message content={t('The current rules do not enable points.')} />}
    {canRaise && session?.status === 'OPEN' && types.length > 0 && <Form className="point-proposal-form" onSubmit={create}>
      <Form.Select label={t('Point type')} placeholder={t('Select type')} search selection fluid icon="search"
        value={type} options={types.map(item => ({key: item.id, value: item.id,
          text: item.names ? committeeContentName(item.names, snapshot.committee.committeeLanguage) : t(item.id)}))}
        onChange={(_, data) => setType(String(data.value))} />
      {canChair && <Form.Select label={t('Point proposer')} placeholder={t('Select point proposer')} search selection
        fluid icon="search" value={seatId || false} options={snapshot.seats.map(seat => ({key: seat.id,
          value: seat.id, text: seat.displayName}))} onChange={(_, data) => setSeatId(String(data.value))} />}
      <Form.TextArea label={chairOperated ? t('Reason (optional)') : t('Reason')} required={!chairOperated}
        value={content} onChange={(_, data) => setContent(String(data.value))} />
      <Button type="submit" icon="plus" basic primary fluid aria-label={t('Raise point')}
        disabled={!type || canChair && !seatId || !chairOperated && !content.trim()} />
    </Form>}<Divider hidden />
    {snapshot.meetingSession && <Divider horizontal className="history-session-divider current-session-divider">{snapshot.meetingSession.name}</Divider>}
    {pointGroups.map(group => <React.Fragment key={group.meetingSessionId}>
      {group.meetingSessionId !== snapshot.meetingSession?.id && <Divider horizontal className="history-session-divider">{sessionNames.get(group.meetingSessionId) ?? t('Meeting session')}</Divider>}
      <Card.Group itemsPerRow={1} className="point-list">{group.points.map(item => {
      const point = 'content' in item ? item as CommitteePoint : undefined;
      return <Card className="point-card" key={item.id}><Card.Content>
        <div className="motion-heading"><Card.Header>{committeeContentName(item.typeNames, snapshot.committee.committeeLanguage)}</Card.Header>
          <Label basic color={item.status === 'PENDING' ? 'blue' : ['OVERRULED', 'REJECTED'].includes(item.status) ? 'red' : 'green'}
            icon={item.status === 'PENDING' ? 'clock outline' : ['OVERRULED', 'REJECTED'].includes(item.status) ? 'times circle' : 'check circle'}
            content={point ? label(point) : t(item.status)} /></div>
        <Table compact celled unstackable className="motion-metadata-table">
          <Table.Body><Table.Row><Table.Cell className="motion-metadata-key">{t('Point proposer')}</Table.Cell>
            <Table.Cell>{item.raisedBySeatDisplayName}</Table.Cell></Table.Row>
          {point?.content && <Table.Row><Table.Cell className="motion-metadata-key">{t('Reason')}</Table.Cell>
            <Table.Cell>{point.content}</Table.Cell></Table.Row>}</Table.Body>
        </Table>
      </Card.Content>
      {canChair && item.status === 'PENDING' && point && <Card.Content extra>
        {chairOperated ? actions(point) : <PointResolutionForm point={point} run={run} api={api} />}
      </Card.Content>}</Card>;
      })}</Card.Group>
    </React.Fragment>)}
  </Container>;
}

function StatisticsPanel({snapshot}: {snapshot: CommitteeWorkspaceSnapshot}) {
  useLanguage();
  const speechDuration = (seatId: string) => (snapshot.speakerLists ?? []).reduce((total, list) => total
    + (list.speeches ?? []).filter(speech => speech.seatId === seatId && speech.status === 'COMPLETED')
      .reduce((listTotal, speech) => {
        const queueEntry = list.queue.find(entry => entry.id === speech.queueEntryId);
        const allotted = speech.kind === 'INHERITED' ? speech.inheritedTimeMs ?? queueEntry?.speechDurationMs ?? 0
          : queueEntry?.speechDurationMs ?? 0;
        const remaining = speech.actions.at(-1)?.remainingMs ?? allotted;
        return listTotal + Math.max(0, allotted - remaining);
      }, 0), 0);
  const formatDuration = (milliseconds: number) => {
    const seconds = Math.floor(milliseconds / 1000); const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60); const remainder = seconds % 60;
    return [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':');
  };
  const rows = snapshot.seats.map(seat => ({seat,
    speeches: (snapshot.speakerLists ?? []).flatMap(list => list.speeches ?? [])
      .filter(speech => speech.seatId === seat.id && speech.status === 'COMPLETED').length,
    duration: speechDuration(seat.id),
    motions: (snapshot.motions ?? []).filter(motion => motion.proposedBySeatId === seat.id).length,
    amendments: (snapshot.documents ?? []).filter(document => document.kind === 'AMENDMENT'
      && document.proposers.some(country => country.seatId === seat.id)).length,
    points: snapshot.points.filter(point => point.raisedBySeatId === seat.id).length,
    documentEntries: (snapshot.documents ?? []).flatMap(document => document.discussion).filter(entry => entry.seatId === seat.id).length
  })).sort((first, second) => second.speeches - first.speeches || first.seat.sortOrder - second.seat.sortOrder);
  return <Container className="statistics-page"><div className="statistics-table-scroll"><Table compact celled definition unstackable><Table.Header><Table.Row>
    <Table.HeaderCell /><Table.HeaderCell textAlign="right">{t('Times spoken')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Total speaking time')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Motion proposals')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Amendment proposals')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Points')}</Table.HeaderCell>
    <Table.HeaderCell textAlign="right">{t('Document discussion entries')}</Table.HeaderCell></Table.Row></Table.Header>
    <Table.Body>{rows.map(row => <Table.Row key={row.seat.id}><Table.Cell><span className="statistics-seat"><Flag seat={row.seat} /><span>{row.seat.displayName}</span></span></Table.Cell>
      <Table.Cell textAlign="right">{row.speeches}</Table.Cell><Table.Cell textAlign="right">{formatDuration(row.duration)}</Table.Cell>
      <Table.Cell textAlign="right">{row.motions}</Table.Cell><Table.Cell textAlign="right">{row.amendments}</Table.Cell>
      <Table.Cell textAlign="right">{row.points}</Table.Cell><Table.Cell textAlign="right">{row.documentEntries}</Table.Cell>
    </Table.Row>)}</Table.Body></Table></div></Container>;
}

function HelpPanel({snapshot, api}: {snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi}) {
  useLanguage();
  const [rulePackages, setRulePackages] = React.useState<RulePackageSummary[]>([]);
  React.useEffect(() => {let active = true;
    void api.listRulePackages().then(packages => {if (active) setRulePackages(packages);}).catch(() => undefined);
    return () => {active = false;};
  }, [api]);
  const ruleVersion = rulePackages.flatMap(pkg => pkg.versions).find(version => version.id === snapshot.activeRules.versionId);
  const role = {PUBLIC: 'Public visitor', MEMBER: 'Member', CHAIR: 'Chair', OWNER: 'Owner'}[snapshot.viewer.audience];
  const shortcut = (key: string, label: string) => <List.Item><Button size="mini">Alt</Button>
    <Button size="mini">{key}</Button>{t(label)}</List.Item>;
  return <Container text className="help-page">
    <Header as="h3" attached="top">{t('Keyboard shortcuts')}</Header><Segment attached="bottom"><List>
      {shortcut('N', 'Next speaker')}{shortcut('S', 'Toggle speaker timer')}{shortcut('C', 'Toggle caucus timer')}
    </List></Segment>
    <Header as="h3" attached="top">{t('Permissions')}</Header><Segment attached="bottom"><List>
      <List.Item><List.Header>{t('Current role')}</List.Header>{t(role)}</List.Item>
      <List.Item><List.Header>{t('Rule version')}</List.Header>{ruleVersion ? localizedDisplayName(ruleVersion.names, 'en') : '—'}</List.Item>
    </List></Segment>
    <Header as="h3" attached="top">{t('Bug reporting & help requests')}</Header><Segment attached="bottom">
      <List ordered><List.Item><a href="https://github.com/brepublic/Quorum/issues">{t('Quorum issue tracking page')}</a></List.Item>
        <List.Item>{t('Describe what you intended to do')}</List.Item><List.Item>{t('Describe what happened instead')}</List.Item>
        <List.Item>{t('List the time, date, and browser that you were using when this occurred')}</List.Item></List>
    </Segment>
    <Header as="h3" attached="top">{t('Version')}</Header><Segment attached="bottom"><List>
      <List.Item>Quorum self-hosted</List.Item><List.Item>Theme API 2</List.Item></List></Segment>
    <Header as="h3" attached="top">{t('License')}</Header><Segment attached="bottom">
      {t('Quorum is licensed under')} <a href="https://github.com/brepublic/Quorum/blob/master/LICENSE">GNU GPLv3</a>
    </Segment>
    <Header as="h3" attached="top">{t('Community')}</Header><Segment attached="bottom">
      <a href="https://github.com/brepublic/Quorum/discussions">{t('Visit the Quorum discussion space')}</a>
    </Segment>
    <Header as="h3" attached="top">{t('Acknowledgements')}</Header><Segment attached="bottom">
      {t('Quorum is based on')} <a href="https://github.com/MaxwellBo/Muncoordinated-2">Muncoordinated</a>{getLanguage() === 'zh-CN' ? '。' : '. '}
      {t('Thanks to its original authors and contributors.')}
    </Segment>
  </Container>;
}

function ModeratedCaucusCreateModal({open, snapshot, run, api, canChair, onClose, onCreated}: {
  open: boolean; snapshot: CommitteeWorkspaceSnapshot; run: WorkspaceCommand; api: SelfHostedApi; canChair: boolean;
  onClose(): void; onCreated(id: string): void;
}) {
  useLanguage();
  const fixedHundredths = (value: string) => {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!match) return undefined;
    return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  };
  const durationMs = (value: string) => {
    const hundredths = fixedHundredths(value);
    if (hundredths === undefined || hundredths <= 0) return undefined;
    return hundredths * 10;
  };
  const session = snapshot.meetingSession?.status === 'OPEN' ? snapshot.meetingSession : undefined;
  const [topic, setTopic] = React.useState('');
  const [unitDuration, setUnitDuration] = React.useState('60');
  const [totalDuration, setTotalDuration] = React.useState('600');
  const [submitting, setSubmitting] = React.useState(false);
  const [closeHint, setCloseHint] = React.useState(false);
  const [topicTouched, setTopicTouched] = React.useState(false);
  const [unitDurationTouched, setUnitDurationTouched] = React.useState(false);
  const [totalDurationTouched, setTotalDurationTouched] = React.useState(false);
  React.useEffect(() => {
    if (!open) return;
    setTopic(''); setUnitDuration('60'); setTotalDuration('600'); setSubmitting(false); setCloseHint(false);
    setTopicTouched(false); setUnitDurationTouched(false); setTotalDurationTouched(false);
  }, [open]);
  const unitDurationMs = durationMs(unitDuration);
  const totalDurationMs = durationMs(totalDuration);
  const durationMultiple = unitDurationMs !== undefined && totalDurationMs !== undefined
    && totalDurationMs % unitDurationMs === 0;
  const valid = Boolean(topic.trim()) && durationMultiple;
  const topicInvalid = topicTouched && !topic.trim();
  const unitDurationInvalid = unitDurationTouched && unitDurationMs === undefined;
  const totalDurationInvalid = totalDurationTouched && (totalDurationMs === undefined || !durationMultiple);
  const validationMessages = [
    topicInvalid ? t('Topic is required.') : null,
    unitDurationInvalid ? t('Speaking time must be a number greater than zero.') : null,
    totalDurationInvalid ? t('Total duration must be greater than zero and a multiple of the speaking time.') : null,
  ].filter(Boolean) as string[];
  const submit = async () => {
    if (!canChair || !session || !valid || submitting || unitDurationMs === undefined || totalDurationMs === undefined) return;
    setSubmitting(true);
    let created: Awaited<ReturnType<SelfHostedApi['createSpeakerList']>> | undefined;
    try {
      await run(async () => {created = await api.createSpeakerList(snapshot.committee.id, {meetingSessionId: session.id,
        kind: 'MODERATED_CAUCUS', customTitle: null, topic: topic.trim(), defaultSpeechMs: unitDurationMs,
        totalDurationMs});});
    } finally {
      setSubmitting(false);
    }
    if (created) onCreated(created.id);
  };
  return <Modal className="moderated-caucus-create-modal" closeOnDimmerClick={false}
    dimmer={{onClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) setCloseHint(true);
    }}} mountNode={document.body} onClose={onClose} open={open} size="small">
    <Modal.Header className="moderated-caucus-create-header">{t('New caucus')}
      <Button className="moderated-caucus-create-close" basic circular icon aria-label={t('Close dialog')} onClick={onClose}>
        <Icon name="close" />
      </Button>
    </Modal.Header>
    <Modal.Content>
      {canChair && session ? <Form error={validationMessages.length > 0} onSubmit={() => void submit()}>
        <Form.Input required error={topicInvalid} label={t('Topic')} value={topic}
          onBlur={() => setTopicTouched(true)} onChange={event => {setTopic(event.currentTarget.value); setCloseHint(false);}} />
        <Form.Group className="moderated-caucus-duration-row"><Form.Input className="moderated-caucus-duration-value"
          required type="text" inputMode="decimal" pattern="\d+(\.\d{1,2})?"
          id="moderated-caucus-unit-duration"
          label={t('Unit duration')} value={unitDuration}
          onBlur={() => setUnitDurationTouched(true)} error={unitDurationInvalid}
          onChange={event => {setUnitDuration(event.currentTarget.value); setCloseHint(false);}} />
        <Form.Field className="moderated-caucus-duration-unit"><div className="moderated-caucus-duration-unit-text">{t('sec')}</div></Form.Field></Form.Group>
        <Form.Group className="moderated-caucus-duration-row"><Form.Input className="moderated-caucus-duration-value"
          required type="text" inputMode="decimal" pattern="\d+(\.\d{1,2})?"
          id="moderated-caucus-total-duration"
          label={t('Total duration')} value={totalDuration}
          onBlur={() => setTotalDurationTouched(true)} error={totalDurationInvalid}
          onChange={event => {setTotalDuration(event.currentTarget.value); setCloseHint(false);}} />
        <Form.Field className="moderated-caucus-duration-unit"><div className="moderated-caucus-duration-unit-text">{t('sec')}</div></Form.Field></Form.Group>
        {validationMessages.length > 0 && <Message error content={validationMessages.join(getLanguage() === 'zh-CN' ? '，' : ' ')} />}
        {closeHint && <Message info content={t('To close the dialog, click "X".')} />}
        <Button primary fluid loading={submitting} disabled={!valid || submitting}>
          {t('Create caucus')}<Icon name="arrow right" />
        </Button>
      </Form> : <Message content={session ? t('Chair capability is required.') : t('Start a meeting first.')} />}
    </Modal.Content>
  </Modal>;
}

export function SelfHostedCommitteeWorkspace({api = selfHostedApi, user, logout = () => undefined}: {
  api?: SelfHostedApi; user?: SelfHostedUser; logout?(): void;
}) {
  useLanguage();
  const {id} = useParams<{id: string}>();
  return <CommitteeWorkspaceProvider committeeId={id} api={api}>
    <CommitteeWorkspaceContent id={id} api={api} user={user} logout={logout} />
  </CommitteeWorkspaceProvider>;
}

function CommitteeWorkspaceContent({id, api, user, logout}: {
  id: string; api: SelfHostedApi; user?: SelfHostedUser; logout(): void;
}) {
  useLanguage();
  const {snapshot, error, realtimeStatus, refresh, run} = useCommitteeWorkspace();
  const location = useLocation(); const history = useHistory();
  const newCaucusPath = `/committees/${id}/caucuses/new`;
  const [createCaucusOpen, setCreateCaucusOpen] = React.useState(location.pathname === newCaucusPath);
  React.useEffect(() => {if (location.pathname === newCaucusPath) setCreateCaucusOpen(true);}, [location.pathname, newCaucusPath]);
  if (!snapshot && !error) return <Loading />;
  if (!snapshot) return <Container text><Message error content={error} /><Button onClick={() => void refresh()}>{t('Retry')}</Button></Container>;
  const interactionSnapshot: CommitteeWorkspaceSnapshot = realtimeStatus === 'OFFLINE_READONLY'
    ? {...snapshot, viewer: {audience: 'PUBLIC', seatId: null}} : snapshot;
  const canChair = (interactionSnapshot.viewer.audience === 'CHAIR' || interactionSnapshot.viewer.audience === 'OWNER')
    && snapshot.committee.status !== 'ARCHIVED' && snapshot.committee.status !== 'DELETING';
  const base = `/committees/${id}`;
  return <CommitteeNavigation snapshot={snapshot} user={user} logout={logout} realtimeStatus={realtimeStatus}
    onCreateCaucus={() => setCreateCaucusOpen(true)}>
    <Container fluid className="committee-workspace-page">{error && <Message error content={error} />}
        <Switch>
          <Route exact path={base}><Redirect to={base + '/roll-call'} /></Route>
          <Route exact path={base + '/info'}><CommitteeOverviewPanel snapshot={snapshot} /></Route>
          <Route exact path={`${base}/setup`}><SetupPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={`${base}/roll-call`}><RollCallPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={`${base}/points`}><PointsPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={`${base}/notes`}><NotesPanel snapshot={interactionSnapshot} run={run} api={api} /></Route>
          <Route path={`${base}/posts/:tab?`} render={({match}) => <PostsPanel key={`${interactionSnapshot.committee.id}:${user?.id}:${interactionSnapshot.viewer.audience}:${interactionSnapshot.committee.operationMode}`} snapshot={interactionSnapshot} api={api}
            userId={user?.id} tab={match.params.tab} />} />
          <Route exact path={`${base}/files`}><Redirect to={`${base}/posts/attachments`} /></Route>
          <Route path={`${base}/motions`}><ProceedingsPanel view="motions" snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route path={`${base}/unmod`}><ProceedingsPanel view="unmod" snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route exact path={newCaucusPath}><Redirect to={`${base}/motions`} /></Route>
          <Route path={`${base}/caucuses/:listId`} render={({match}) => <ProceedingsPanel view="caucus" resourceId={match.params.listId}
            snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} />} />
          <Route path={`${base}/resolutions/:documentId/:tab?`} render={({match}) => <ProceedingsPanel view="resolution"
            resourceId={match.params.documentId} tab={match.params.tab} snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} />} />
          <Route path={`${base}/strawpolls/:pollId`} render={({match}) => <ProceedingsPanel view="strawpoll" resourceId={match.params.pollId}
            snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} />} />
          <Route path={`${base}/stats`}><StatisticsPanel snapshot={snapshot} /></Route>
          <Route path={`${base}/settings`}><SettingsPanel snapshot={interactionSnapshot} run={run} api={api} canChair={canChair} /></Route>
          <Route path={`${base}/help`}><HelpPanel snapshot={snapshot} api={api} /></Route>
          <Redirect to={base} />
        </Switch>
    </Container>
    <ModeratedCaucusCreateModal open={createCaucusOpen} snapshot={interactionSnapshot} run={run} api={api}
      canChair={canChair} onClose={() => setCreateCaucusOpen(false)} onCreated={listId => {
        setCreateCaucusOpen(false); history.push(`${base}/caucuses/${listId}`);
      }} />
  </CommitteeNavigation>;
}

export default function SelfHostedWorkspace({user, logout, accountManager, api = selfHostedApi, identityClient = selfHostedIdentityClient}: {
  user: SelfHostedUser; logout(): void; accountManager?: React.ReactNode; api?: SelfHostedApi; identityClient?: SelfHostedIdentityClient;
}) {
  useLanguage();
  const location = useLocation();
  const committeeRoute = /^\/committees\/[^/]+/.test(location.pathname);
  return <>{!committeeRoute && <AppMenu user={user} logout={logout} />}<Switch>
    <Route exact path="/committees"><CommitteeList api={api} user={user} logout={logout} /></Route>
    <Route exact path="/countries"><CountryTemplateManager api={api} /></Route>
    <Route exact path="/templates"><CommitteeTemplateManager api={api} /></Route>
    {user.isSystemAdmin && <Route exact path="/storage"><Redirect to="/system-settings/storage" /></Route>}
    {user.isSystemAdmin && <Route exact path="/operations"><Redirect to="/system-settings/operations" /></Route>}
    {user.isSystemAdmin && <Route path="/system-settings"><SystemSettings api={api} client={identityClient} /></Route>}
    <Route path="/committees/:id"><SelfHostedCommitteeWorkspace api={api} user={user} logout={logout} /></Route>
    {user.isSystemAdmin && <Route exact path="/admin">{accountManager}</Route>}
    <Route exact path="/"><Redirect to={user.isSystemAdmin ? '/admin' : '/committees'} /></Route>
    <Redirect to="/committees" />
  </Switch></>;
}

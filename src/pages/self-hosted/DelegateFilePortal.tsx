import {apiErrorText} from '../../i18n';
import {t, useLanguage, getLanguage} from '../../i18n';
import * as React from 'react';
import {customDelegateFileType, DELEGATE_FILE_TYPES, delegateFileTypeName, isCustomDelegateFileType, type ContentLanguage, isAllowedDelegateFile} from '@quorum/contracts';
import type {DelegateFileAvailableEvent, DelegateFileCategory, DelegateFileType, StandardDelegateFileType, DelegatePortalBootstrap,
  DelegatePublishedFile} from '@quorum/contracts';
import {Button, Card, Container, Divider, Form, Icon, Menu, Message, Modal, Progress, Sidebar, Table} from 'semantic-ui-react';
import {SelfHostedApiError, selfHostedApi, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';
import {CountryFlagDisplay} from '../../components/CountryFlagDisplay';
import {searchOptions} from '@quorum/contracts';

const FILE_TYPES = DELEGATE_FILE_TYPES;
const CATEGORIES: DelegateFileCategory[] = [...FILE_TYPES, 'OTHER'];

function categoryHasNewFile(portal: DelegatePortalBootstrap, category: DelegateFileCategory,
  localOpenedAt: Partial<Record<DelegateFileCategory, string>>): boolean {
  const confirmed = portal.categoryOpenedAt?.[category];
  const local = localOpenedAt[category];
  const openedAt = local && (!confirmed || local > confirmed) ? local : confirmed;
  return portal.files.some(file => (category === 'OTHER'
    ? Boolean(file.fileType && isCustomDelegateFileType(file.fileType)) : file.fileType === category)
    && (!openedAt || Date.parse(file.publishedAt) > Date.parse(openedAt)));
}

function dateTime(value: string | null): string { return value ? new Date(value).toLocaleString(getLanguage()) : '—'; }
function portalError(error: unknown): string {
  if (!(error instanceof SelfHostedApiError)) return apiErrorText(error);
  if (error.localization?.reason && error.localization.reason !== error.code) return apiErrorText(error);
  if (error.localization?.reason) return apiErrorText(error);
  return ({LINK_EXPIRED: t("The sharing link has expired."),
    AUTHENTICATION_REQUIRED: t("Your delegate session has expired. Reopen the sharing link."), FORBIDDEN: t("This delegation cannot upload files."),
    PAYLOAD_TOO_LARGE: t("The file is too large. Choose a smaller file."), SERVICE_NOT_READY: t("File storage unavailable"),
    VALIDATION_FAILED: t("Invalid file information.")} as Record<string, string>)[error.code] ?? apiErrorText(error);
}
function fileSizeMiB(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const limit = value / 1024 / 1024;
  return Number.isInteger(limit) ? `${limit}` : limit.toFixed(1);
}

function PublishedCard({file, committeeLanguage, preparing, onDownload}: {
  file: DelegatePublishedFile; committeeLanguage: ContentLanguage; preparing: boolean; onDownload(id: string): void;
}) {
  useLanguage();
  return <Card fluid className="delegate-file-card motion-card"><Card.Content>
    <div className="motion-heading delegate-file-heading"><Card.Header>{file.logicalName}</Card.Header>
      <span className="motion-decision motion-decision-passed">{t("Approved point")}</span></div>
    <Card.Meta><Table compact celled className="motion-metadata-table delegate-file-metadata"><Table.Body>
      <Table.Row><Table.Cell className="motion-metadata-key">{t("File source")}</Table.Cell><Table.Cell>{file.submissionSource === 'CHAIR' ? t('Chair') : file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">{t("File type")}</Table.Cell><Table.Cell>{file.fileType ? delegateFileTypeName(file.fileType, committeeLanguage) : '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">{t("Submitted at")}</Table.Cell><Table.Cell>{dateTime(file.submittedAt)}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">{t("Reviewed at")}</Table.Cell><Table.Cell>{dateTime(file.publishedAt)}</Table.Cell></Table.Row>
    </Table.Body></Table></Card.Meta>
  </Card.Content><Card.Content extra><Button as="a" primary fluid download
    href={`/api/v1/delegate-files/files/${encodeURIComponent(file.id)}/download`}
    loading={preparing} disabled={preparing}
    onClick={(event: React.MouseEvent) => {event.preventDefault(); onDownload(file.id);}}>
    {preparing ? t("Preparing the file from the chair computer") : <>{t("Download")} <Icon name="arrow down" /></>}
  </Button></Card.Content></Card>;
}

export default function DelegateFilePortal({api = selfHostedApi}: {api?: SelfHostedApi}) {
  const language = useLanguage();
  const capability = window.location.hash.replace(/^#/, '');
  const [portal, setPortal] = React.useState<DelegatePortalBootstrap>();
  const [active, setActive] = React.useState<'files' | 'upload'>('files');
  const [seatId, setSeatId] = React.useState(''); const [confirming, setConfirming] = React.useState(false);
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? portalError(failure) : undefined; const [working, setWorking] = React.useState(false);
  const [connection, setConnection] = React.useState<'LIVE' | 'OFFLINE'>('OFFLINE');
  const [notices, setNotices] = React.useState<Array<DelegateFileAvailableEvent & {expiresAt: number}>>([]);
  const [file, setFile] = React.useState<File>(); const [fileType, setFileType] = React.useState<StandardDelegateFileType | 'OTHER'>('WORKING_PAPER');
  const [customType, setCustomType] = React.useState('');
  const [publishedCategory, setPublishedCategory] = React.useState<DelegateFileCategory | 'ALL'>('ALL');
  const [localOpenedAt, setLocalOpenedAt] = React.useState<Partial<Record<DelegateFileCategory, string>>>({});
  const [progress, setProgress] = React.useState<number>(); const [submitted, setSubmitted] = React.useState(false);
  const [awaitingSave, setAwaitingSave] = React.useState(false);
  const [preparingDownload, setPreparingDownload] = React.useState<string>();
  const [navigationLevel, setNavigationLevel] = React.useState(0);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const navigationMeasurementRef = React.useRef<HTMLDivElement | null>(null);
  const knownPublications = React.useRef<Map<string, string> | null>(null);

  const load = React.useCallback(async () => {
    if (!capability) { setError({code: 'LINK_EXPIRED'}); return; }
    try { const next = await api.bootstrapDelegatePortal(capability);
      knownPublications.current = new Map(next.files.map(file => [file.id, file.publishedAt]));
      setPortal(next); setError(undefined); }
    catch (caught) { setError(caught); }
  }, [api, capability]);
  React.useEffect(() => { void load(); }, [load]);

  const refreshFiles = React.useCallback(async () => {
    try { const next = await api.bootstrapDelegatePortal(capability);
      const known = knownPublications.current;
      if (known) {
        const newlyPublished = next.files.filter(file => {
          const previous = known.get(file.id);
          return (!previous || file.publishedAt > previous) &&
            (file.submissionSource === 'CHAIR' || file.submissionSource === 'DELEGATE_PORTAL');
        });
        if (newlyPublished.length) setNotices(current => {
          const others = current.filter(item => !newlyPublished.some(file => file.id === item.fileId));
          return [...others, ...newlyPublished.map(file => ({id: 0, fileId: file.id,
            submissionSource: file.submissionSource as 'CHAIR' | 'DELEGATE_PORTAL',
            submitterDisplayName: file.submitterDisplayName, logicalName: file.logicalName,
            publishedAt: file.publishedAt, expiresAt: Date.now() + 60_000}))];
        });
      }
      knownPublications.current = new Map(next.files.map(file => [file.id, file.publishedAt]));
      setPortal(current => {
        if (!current) return current;
        const categoryOpenedAt = {...next.categoryOpenedAt};
        for (const category of CATEGORIES) {
          const local = current.categoryOpenedAt?.[category];
          const remote = categoryOpenedAt[category];
          if (local && (!remote || local > remote)) categoryOpenedAt[category] = local;
        }
        return {...next, categoryOpenedAt, eventSequence: current.eventSequence};
      }); }
    catch { /* The stream state communicates loss of service. */ }
  }, [api, capability]);

  React.useEffect(() => {
    if (!portal?.claimedSeat) return;
    const stream = new EventSource(`/api/v1/delegate-files/events?after=${portal.eventSequence}`);
    stream.onopen = () => setConnection('LIVE'); stream.onerror = () => setConnection('OFFLINE');
    const available = (event: MessageEvent<string>) => {
      const item = JSON.parse(event.data) as DelegateFileAvailableEvent;
      setNotices(current => [...current.filter(existing => existing.fileId !== item.fileId),
        {...item, expiresAt: Date.now() + 60_000}]); void refreshFiles();
    };
    const status = (event: MessageEvent<string>) => {
      const value = JSON.parse(event.data) as {storageAvailable: boolean};
      setPortal(current => current ? {...current, storageAvailable: value.storageAvailable} : current);
    };
    stream.addEventListener('file.available', available as EventListener);
    stream.addEventListener('file.rejected', available as EventListener);
    stream.addEventListener('portal.status', status as EventListener);
    const refresh = window.setInterval(() => void refreshFiles(), 15_000);
    return () => {window.clearInterval(refresh); stream.close();};
  }, [portal?.claimedSeat?.id, portal?.eventSequence, refreshFiles]);
  React.useEffect(() => {
    const timers = notices.map(item => window.setTimeout(() => setNotices(current => current.filter(
      candidate => candidate.fileId !== item.fileId)), Math.max(0, item.expiresAt - Date.now())));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [notices]);

  const claim = async () => {
    setWorking(true); setError(undefined);
    try { const next = await api.claimDelegatePortal(capability, seatId);
      knownPublications.current = new Map(next.files.map(file => [file.id, file.publishedAt]));
      setPortal(next); setConfirming(false); }
    catch (caught) { setError(caught); }
    finally { setWorking(false); }
  };
  const uploadSizeError = file && portal && Number.isFinite(portal.maxUploadSizeBytes)
    && portal.maxUploadSizeBytes > 0 && file.size > portal.maxUploadSizeBytes
    ? t('Choose a file no larger than {size} MiB.', {size: fileSizeMiB(portal.maxUploadSizeBytes)}) : undefined;
  const upload = async () => {
    if (!file || uploadSizeError || working) return;
    const type = fileType === 'OTHER' ? customDelegateFileType(customType) : fileType;
    if (fileType === 'OTHER' && (!customType.trim() || Array.from(customType).length > 100)) return;
    const extensions = portal?.allowedExtensions?.[fileType];
    if (extensions && !isAllowedDelegateFile(file.name, extensions)) {setError({code: 'INVALID_FILE_EXTENSION', params: {formats: extensions.map(ext => '.' + ext).join(', ')}}); return;}
    setWorking(true); setSubmitted(false); setError(undefined); setProgress(0);
    try {
      const sha256 = await sha256File(file, {onProgress: (done, total) => setProgress(total ? done / total * 20 : 0)});
      const created = await api.createDelegateFileUpload({logicalName: file.name, originalName: file.name,
        mediaType: file.type || 'application/octet-stream', expectedSizeBytes: file.size, sha256, fileType: type});
      await api.uploadDelegateFileContent(created.id, file, (done, total) => setProgress(20 + (total ? done / total * 75 : 0)));
      setProgress(98); const result = await api.commitDelegateFileUpload(created.id); setAwaitingSave('kind' in result); setProgress(100); setSubmitted(true); setFile(undefined); await refreshFiles();
    } catch (caught) { setProgress(undefined); setError(caught); }
    finally { setWorking(false); }
  };
  const download = async (id: string) => {
    setPreparingDownload(id); setNotices(current => current.filter(item => item.fileId !== id)); setError(undefined);
    try {
      let readiness = await api.prepareDelegateFileDownload(id);
      while (readiness.status === 'PREPARING') {
        await new Promise(resolve => window.setTimeout(resolve, (readiness.retryAfterSeconds ?? 2) * 1000));
        readiness = await api.delegateFileDownloadReadiness(id);
      }
      if (readiness.status !== 'READY') throw Object.assign(new Error(), {code: readiness.code ?? 'FILE_CONTENT_UNAVAILABLE'});
      window.location.assign(api.delegateFileDownloadUrl(id));
    } catch (caught) { setError(caught); }
    finally { setPreparingDownload(undefined); }
  };
  const openCategory = (category: DelegateFileCategory | 'ALL') => {
    setPublishedCategory(category);
    if (category === 'ALL') return;
    const latest = portal?.files.filter(file => category === 'OTHER'
      ? Boolean(file.fileType && isCustomDelegateFileType(file.fileType)) : file.fileType === category)
      .reduce<DelegatePublishedFile | undefined>((newest, file) => !newest || file.publishedAt > newest.publishedAt ? file : newest, undefined);
    if (!latest) return;
    setLocalOpenedAt(current => ({...current, [category]: current[category] && current[category]! > latest.publishedAt
      ? current[category] : latest.publishedAt}));
    void (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 10_000);
        try {
          const opened = await api.openDelegatePublishedCategory(category, latest.id, controller.signal);
          setPortal(current => {
            if (!current) return current;
            const previous = current.categoryOpenedAt[category];
            return {...current, categoryOpenedAt: {...current.categoryOpenedAt,
              [category]: previous && previous > opened.openedAt ? previous : opened.openedAt}};
          });
          return;
        } catch { /* Keep the local read state while retrying silently. */ }
        finally {window.clearTimeout(timeout);}
        if (attempt < 4) await new Promise(resolve => window.setTimeout(resolve, 1000 * 2 ** attempt));
      }
    })();
  };

  React.useLayoutEffect(() => {
    const container = navigationMeasurementRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const menu = container.querySelector<HTMLElement>('.delegate-file-menu')!;
    const measure = () => {
      const available = container.getBoundingClientRect().width;
      if (!available) return;
      const width = (selector: string) => menu.querySelector(selector)?.getBoundingClientRect().width ?? 0;
      const full = menu.getBoundingClientRect().width;
      const required = [full, full - width('.delegate-file-status-label')];
      if (portal?.claimedSeat?.flag) required.push(required[1] - width('.delegate-file-seat-name'));
      setNavigationLevel(previous => {
        const next = required.findIndex((needed, index) => needed + (index < previous ? 4 : 0) <= available);
        return next < 0 ? 3 : next;
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(menu);
    menu.querySelectorAll('.delegate-file-status-label, .delegate-file-seat-name').forEach(element => observer.observe(element));
    measure();
    return () => observer.disconnect();
  }, [portal?.committeeName, portal?.claimedSeat?.displayName, portal?.claimedSeat?.flag,
    portal?.storageAvailable, connection, language]);
  React.useEffect(() => {setSidebarOpen(false);}, [navigationLevel]);

  if (!portal) return <Container className="delegate-file-portal">{error
    ? <Message error content={error} /> : <Message content={t("Loading…")} />}</Container>;
  if (!portal.claimedSeat) return <Container className="delegate-file-claim-page">
    {error && <Message error content={error} />}
    <Card centered className="delegate-file-claim-card"><Card.Content><Card.Header>{t("Select a delegation")}</Card.Header>
      <Form><Form.Select fluid selection search={searchOptions} placeholder={t("Select a delegation")} value={seatId}
        options={portal.eligibleSeats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName,
          searchTerms: seat.searchTerms,
          content: <span className="motion-seat-option"><CountryFlagDisplay flag={seat.flag} /><span>{seat.displayName}</span></span>}))}
        onChange={(_, data) => setSeatId(String(data.value))} /></Form>
    </Card.Content><Card.Content extra><Button primary fluid disabled={!seatId} onClick={() => setConfirming(true)}>{t("Confirm")}</Button></Card.Content></Card>
    <Modal size="tiny" open={confirming} onClose={() => setConfirming(false)}><Modal.Header>{t("Confirm delegation")}</Modal.Header>
      <Modal.Content>{t("Your delegation cannot be changed after confirmation.")}</Modal.Content><Modal.Actions>
        <Button onClick={() => setConfirming(false)}>{t("Cancel")}</Button><Button primary loading={working} onClick={() => void claim()}>{t("Confirm")}</Button>
      </Modal.Actions></Modal>
  </Container>;

  const isLive = portal.storageAvailable && connection === 'LIVE';
  const claimedSeat = portal.claimedSeat;
  const publishedFiles = portal.files.filter(item => publishedCategory === 'ALL' ||
    (publishedCategory === 'OTHER' ? Boolean(item.fileType && isCustomDelegateFileType(item.fileType)) : item.fileType === publishedCategory));
  const status = isLive ? t("Live") : !portal.storageAvailable ? t("File storage unavailable") : t("Offline");
  const maxUploadSizeMiB = fileSizeMiB(portal.maxUploadSizeBytes);
  const statusItem = (compact: boolean) => <Menu.Item className={isLive ? 'realtime-status-live' : undefined}
    title={status} aria-label={status}>
    <Icon name={isLive ? 'check circle' : 'warning sign'} aria-hidden="true" />
    {!compact && <span className="delegate-file-status-label">{status}</span>}
  </Menu.Item>;
  const seatItem = (compact: boolean) => <Menu.Item className="delegate-file-seat" title={claimedSeat.displayName}
    aria-label={claimedSeat.displayName}>
    {claimedSeat.flag && <CountryFlagDisplay flag={claimedSeat.flag} />}
    {!compact && <span className="delegate-file-seat-name">{claimedSeat.displayName}</span>}
  </Menu.Item>;
  const navigationItems = (close = false) => <>
    <Menu.Item active={active === 'files'} onClick={() => {setActive('files'); if (close) setSidebarOpen(false);}}>{t("Published files")}</Menu.Item>
    <Menu.Item active={active === 'upload'} onClick={() => {setActive('upload'); if (close) setSidebarOpen(false);}}>{t("Upload files")}</Menu.Item>
  </>;
  return <div className="delegate-file-portal">
    <nav className="delegate-file-navigation-desktop" data-navigation-mode={navigationLevel === 3 ? 'sidebar' : 'desktop'}>
      <Menu className="delegate-file-menu"><Menu.Item header className="delegate-file-committee-name">{portal.committeeName}</Menu.Item>
        {navigationItems()}<Menu.Menu position="right">{statusItem(navigationLevel >= 1)}{seatItem(navigationLevel >= 2 && Boolean(claimedSeat.flag))}</Menu.Menu>
      </Menu>
    </nav>
    <div className="delegate-file-navigation-measurement" aria-hidden="true" ref={element => {
      navigationMeasurementRef.current = element;
      element?.setAttribute('inert', '');
    }}><Menu className="delegate-file-menu"><Menu.Item header className="delegate-file-committee-name">{portal.committeeName}</Menu.Item>
      {navigationItems()}<Menu.Menu position="right">{statusItem(false)}{seatItem(false)}</Menu.Menu>
    </Menu></div>
    <Sidebar.Pushable className="delegate-file-navigation-pushable" data-navigation-mode={navigationLevel === 3 ? 'sidebar' : 'desktop'}>
      <Sidebar className="delegate-file-mobile-sidebar" as={Menu} animation="uncover" vertical visible={sidebarOpen}
        onHide={() => setSidebarOpen(false)}>
        {statusItem(false)}{seatItem(false)}{navigationItems(true)}
      </Sidebar>
      <Sidebar.Pusher dimmed={sidebarOpen} onClick={() => sidebarOpen && setSidebarOpen(false)}>
        <nav className="delegate-file-navigation-mobile"><Menu className="delegate-file-mobile-menu">
          <Menu.Item as="button" type="button" aria-expanded={sidebarOpen} aria-label={t('Open committee navigation')}
            onClick={() => setSidebarOpen(open => !open)}><Icon name="sidebar" /></Menu.Item>
          <Menu.Item header className="delegate-file-committee-name">{portal.committeeName}</Menu.Item>
        </Menu></nav>
    <Container>
      {notices.map(item => <Message info={item.kind !== 'rejected'} negative={item.kind === 'rejected'} key={item.fileId} onDismiss={() => setNotices(current =>
        current.filter(candidate => candidate.fileId !== item.fileId))}
        content={<>{t(item.kind === 'rejected' ? '{seat} submitted {file}, which was rejected by the chair.' : '{seat} submitted {file}, which is now available.',
          {}).split(/(\{seat\}|\{file\})/).map((part, index) => part === '{seat}'
            ? <strong key={index}>{item.submissionSource === 'CHAIR' ? t('Chair') : item.submitterDisplayName}</strong> : part === '{file}'
              ? <strong key={index}>{item.logicalName}</strong> : part)}{item.rejectionReason && <div>{item.rejectionReason}</div>}</>} />)}
      {error && <Message error content={error} />}
      {active === 'files' && <><Menu pointing secondary className="delegate-file-category-menu" aria-label={t('Published file categories')}>
        <Menu.Item active={publishedCategory === 'ALL'} onClick={() => void openCategory('ALL')}>{t('All files')}</Menu.Item>
        {FILE_TYPES.map(type => <Menu.Item key={type} active={publishedCategory === type} onClick={() => void openCategory(type)}>
          {delegateFileTypeName(type, portal.committeeLanguage)}{categoryHasNewFile(portal, type, localOpenedAt) &&
            <span className="delegate-file-category-dot" role="img" aria-label={t('New files')} />}
        </Menu.Item>)}
        <Menu.Item active={publishedCategory === 'OTHER'} onClick={() => void openCategory('OTHER')}>{t('Other')}
          {categoryHasNewFile(portal, 'OTHER', localOpenedAt) && <span className="delegate-file-category-dot" role="img" aria-label={t('New files')} />}
        </Menu.Item>
      </Menu><div className="delegate-file-card-list">{publishedFiles.length
        ? publishedFiles.map(item => <PublishedCard committeeLanguage={portal.committeeLanguage} key={item.id} file={item} preparing={preparingDownload === item.id}
          onDownload={id => void download(id)} />)
        : <Message content={t(publishedCategory === 'ALL' ? 'No published files' : 'No files in this category')} />}</div></>}
        {active === 'upload' && <><Card centered fluid className="delegate-file-upload-card"><Card.Content>
        <Form onSubmit={() => void upload()}>
        <Form.Select label={t("File type")} options={[...FILE_TYPES.filter(type=>type!=='CRISIS_NOTICE').map(type => ({key: type, value: type, text: delegateFileTypeName(type, portal.committeeLanguage)})),
          {key: 'OTHER', value: 'OTHER', text: t('Other')}]} value={fileType} disabled={working}
          onChange={(_, data) => {setFileType(data.value as StandardDelegateFileType | 'OTHER'); setError(undefined);}} />
        {fileType === 'OTHER' && <Form.Input label={t('Custom file type')} value={customType} required maxLength={100} disabled={working}
          onChange={(_, data) => setCustomType(String(data.value))} />}
        <Form.Field>
          <label>{t("Choose file")}</label>
          {maxUploadSizeMiB === '—'
            ? null
            : <small className="ui tiny text delegate-file-upload-limit-note">{t('Maximum file size: {size} MiB', {size: maxUploadSizeMiB})}</small>}
          <input type="file" disabled={working} accept={portal.allowedExtensions?.[fileType]?.map(ext => `.${ext}`).join(',')} onChange={(event: React.ChangeEvent<HTMLInputElement>) => {setFile(event.currentTarget.files?.[0]);
            setSubmitted(false); setProgress(undefined);}} aria-label={t("Choose file")} />
        </Form.Field>
        {uploadSizeError && <Message negative role="alert" content={uploadSizeError} />}
        {portal.allowedExtensions && <p className="delegate-file-allowed-formats">{t("Allowed formats:")}{portal.allowedExtensions[fileType]?.join('、')}</p>}
        {!submitted && progress === undefined && <Button primary fluid disabled={!file || working || !portal.mayUpload || Boolean(uploadSizeError) || (fileType === 'OTHER' && !customType.trim())}>

          {t("Submit")} <Icon name="arrow up" /></Button>}
        {progress !== undefined && !submitted && <Progress percent={Math.round(progress)} progress color="blue">{progress >= 98 ? t("Saving files") : t("Uploading")}</Progress>}
        {submitted && !awaitingSave && <div className="delegate-file-upload-success">{t("✔ Submitted, awaiting review")}</div>}
        </Form>
      </Card.Content></Card>
      {portal.pendingUploads?.map(item => <Message key={item.id} warning={item.status === 'FAILED'} info={item.status === 'SAVING'}
        header={item.logicalName} content={item.status === 'FAILED' ? t('Save failed. Upload the file again.') : t('Saving files')} />)}
      <Divider className="delegate-file-review-divider" />
      <div className="delegate-file-card-list">{portal.submissions?.length ? portal.submissions.map(item =>
        <Card fluid key={item.id} className="delegate-file-card motion-card"><Card.Content>
          <div className="motion-heading delegate-file-heading"><Card.Header>{item.logicalName}</Card.Header>
            <span className={`motion-decision ${item.status === 'PUBLISHED' ? 'motion-decision-passed' : item.status === 'REJECTED' ? 'motion-decision-failed' : ''}`}>
              {({UPLOAD_COMPLETE:t("Upload complete"),PENDING_REVIEW:t("Pending review"),PUBLISHED:t("Approved point"),REJECTED:t("File status: Rejected"),DELETED:t("Deleted")})[item.status]}</span></div>
          <Card.Meta><Table compact celled className="motion-metadata-table delegate-file-metadata"><Table.Body>
            <Table.Row><Table.Cell className="motion-metadata-key">{t("File source")}</Table.Cell><Table.Cell>{item.submissionSource === 'CHAIR' ? t('Chair') : item.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">{t("File type")}</Table.Cell><Table.Cell>{item.fileType ? delegateFileTypeName(item.fileType, portal.committeeLanguage) : '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">{t("Submitted at")}</Table.Cell><Table.Cell>{dateTime(item.submittedAt)}</Table.Cell></Table.Row>
            {item.reviewedAt && <Table.Row><Table.Cell className="motion-metadata-key">{t("Reviewed at")}</Table.Cell><Table.Cell>{dateTime(item.reviewedAt)}</Table.Cell></Table.Row>}
            <Table.Row><Table.Cell className="motion-metadata-key">{t("Original file")}</Table.Cell><Table.Cell>{item.originalName}</Table.Cell></Table.Row>
            {item.rejectionReason && <Table.Row><Table.Cell className="motion-metadata-key">{t("Rejection reason")}</Table.Cell><Table.Cell>{item.rejectionReason}</Table.Cell></Table.Row>}
          </Table.Body></Table></Card.Meta>
        </Card.Content></Card>) : <Message content={t("No uploads")} />}</div></>}
    </Container>
      </Sidebar.Pusher>
    </Sidebar.Pushable>
  </div>;
}

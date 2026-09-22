import {apiErrorText} from '../../i18n';
import {t, useLanguage, getLanguage} from '../../i18n';
import * as React from 'react';
import {delegateFileTypeName, type ContentLanguage, isAllowedDelegateFile} from '@quorum/contracts';
import type {DelegateFileAvailableEvent, DelegateFileType, DelegatePortalBootstrap,
  DelegatePublishedFile} from '@quorum/contracts';
import {Button, Card, Container, Divider, Form, Icon, Menu, Message, Modal, Progress, Table} from 'semantic-ui-react';
import {SelfHostedApiError, selfHostedApi, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';
import {CountryFlagDisplay} from '../../components/CountryFlagDisplay';

const FILE_TYPES: Array<{key: DelegateFileType; value: DelegateFileType; text: string}> = [
  {key: 'WORKING_PAPER', value: 'WORKING_PAPER', text: "Working paper"},
  {key: 'DIRECTIVE_DRAFT', value: 'DIRECTIVE_DRAFT', text: "Draft directive"},
  {key: 'RESOLUTION_DRAFT', value: 'RESOLUTION_DRAFT', text: "resolution"}
];

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
  useLanguage();
  const capability = window.location.hash.replace(/^#/, '');
  const [portal, setPortal] = React.useState<DelegatePortalBootstrap>();
  const [active, setActive] = React.useState<'files' | 'upload'>('files');
  const [seatId, setSeatId] = React.useState(''); const [confirming, setConfirming] = React.useState(false);
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? portalError(failure) : undefined; const [working, setWorking] = React.useState(false);
  const [connection, setConnection] = React.useState<'LIVE' | 'OFFLINE'>('OFFLINE');
  const [notices, setNotices] = React.useState<Array<DelegateFileAvailableEvent & {expiresAt: number}>>([]);
  const [file, setFile] = React.useState<File>(); const [fileType, setFileType] = React.useState<DelegateFileType>('WORKING_PAPER');
  const [progress, setProgress] = React.useState<number>(); const [submitted, setSubmitted] = React.useState(false);
  const [awaitingSave, setAwaitingSave] = React.useState(false);
  const [preparingDownload, setPreparingDownload] = React.useState<string>();

  const load = React.useCallback(async () => {
    if (!capability) { setError({code: 'LINK_EXPIRED'}); return; }
    try { setPortal(await api.bootstrapDelegatePortal(capability)); setError(undefined); }
    catch (caught) { setError(caught); }
  }, [api, capability]);
  React.useEffect(() => { void load(); }, [load]);

  const refreshFiles = React.useCallback(async () => {
    try { const next = await api.bootstrapDelegatePortal(capability); setPortal(current => current ? {...next, eventSequence: current.eventSequence} : current); }
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
    try { setPortal(await api.claimDelegatePortal(capability, seatId)); setConfirming(false); }
    catch (caught) { setError(caught); }
    finally { setWorking(false); }
  };
  const uploadSizeError = file && portal && Number.isFinite(portal.maxUploadSizeBytes)
    && portal.maxUploadSizeBytes > 0 && file.size > portal.maxUploadSizeBytes
    ? t('Choose a file no larger than {size} MiB.', {size: fileSizeMiB(portal.maxUploadSizeBytes)}) : undefined;
  const upload = async () => {
    if (!file || uploadSizeError || working) return;
    const extensions = portal?.allowedExtensions?.[fileType];
    if (extensions && !isAllowedDelegateFile(file.name, extensions)) {setError({code: 'INVALID_FILE_EXTENSION', params: {formats: extensions.map(ext => '.' + ext).join(', ')}}); return;}
    setWorking(true); setSubmitted(false); setError(undefined); setProgress(0);
    try {
      const sha256 = await sha256File(file, {onProgress: (done, total) => setProgress(total ? done / total * 20 : 0)});
      const created = await api.createDelegateFileUpload({logicalName: file.name, originalName: file.name,
        mediaType: file.type || 'application/octet-stream', expectedSizeBytes: file.size, sha256, fileType});
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

  if (!portal) return <Container className="delegate-file-portal">{error
    ? <Message error content={error} /> : <Message content={t("Loading…")} />}</Container>;
  if (!portal.claimedSeat) return <Container className="delegate-file-claim-page">
    {error && <Message error content={error} />}
    <Card centered className="delegate-file-claim-card"><Card.Content><Card.Header>{t("Select a delegation")}</Card.Header>
      <Form><Form.Select fluid selection search placeholder={t("Select a delegation")} value={seatId}
        options={portal.eligibleSeats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName,
          content: <span className="motion-seat-option"><CountryFlagDisplay flag={seat.flag} /><span>{seat.displayName}</span></span>}))}
        onChange={(_, data) => setSeatId(String(data.value))} /></Form>
    </Card.Content><Card.Content extra><Button primary fluid disabled={!seatId} onClick={() => setConfirming(true)}>{t("Confirm")}</Button></Card.Content></Card>
    <Modal size="tiny" open={confirming} onClose={() => setConfirming(false)}><Modal.Header>{t("Confirm delegation")}</Modal.Header>
      <Modal.Content>{t("Your delegation cannot be changed after confirmation.")}</Modal.Content><Modal.Actions>
        <Button onClick={() => setConfirming(false)}>{t("Cancel")}</Button><Button primary loading={working} onClick={() => void claim()}>{t("Confirm")}</Button>
      </Modal.Actions></Modal>
  </Container>;

  const isLive = portal.storageAvailable && connection === 'LIVE';
  const status = isLive ? t("Live") : !portal.storageAvailable ? t("File storage unavailable") : t("Offline");
  const maxUploadSizeMiB = fileSizeMiB(portal.maxUploadSizeBytes);
  return <div className="delegate-file-portal">
    <Menu className="delegate-file-menu"><Menu.Item header className="delegate-file-committee-name">{portal.committeeName}</Menu.Item>
      <Menu.Item active={active === 'files'} onClick={() => setActive('files')}>{t("Published files")}</Menu.Item>
      <Menu.Item active={active === 'upload'} onClick={() => setActive('upload')}>{t("Upload files")}</Menu.Item>
      <Menu.Menu position="right"><Menu.Item className={isLive ? 'realtime-status-live' : undefined}>
        {isLive && <Icon name="check circle" />} {status}
      </Menu.Item><Menu.Item className="delegate-file-seat">{portal.claimedSeat.flag && <CountryFlagDisplay flag={portal.claimedSeat.flag} />}<span>{portal.claimedSeat.displayName}</span></Menu.Item></Menu.Menu>
    </Menu>
    <Container>
      {notices.map(item => <Message info={item.kind !== 'rejected'} negative={item.kind === 'rejected'} key={item.fileId} onDismiss={() => setNotices(current =>
        current.filter(candidate => candidate.fileId !== item.fileId))}
        content={<>{t(item.kind === 'rejected' ? '{seat} submitted {file}, which was rejected by the chair.' : '{seat} submitted {file}, which is now available.',
          {}).split(/(\{seat\}|\{file\})/).map((part, index) => part === '{seat}'
            ? <strong key={index}>{item.submitterDisplayName}</strong> : part === '{file}'
              ? <strong key={index}>{item.logicalName}</strong> : part)}{item.rejectionReason && <div>{item.rejectionReason}</div>}</>} />)}
      {error && <Message error content={error} />}
      {active === 'files' && <div className="delegate-file-card-list">{portal.files.length
        ? portal.files.map(item => <PublishedCard committeeLanguage={portal.committeeLanguage} key={item.id} file={item} preparing={preparingDownload === item.id}
          onDownload={id => void download(id)} />)
        : <Message content={t("No published files")} />}</div>}
        {active === 'upload' && <><Card centered fluid className="delegate-file-upload-card"><Card.Content>
        <Form onSubmit={() => void upload()}>
        <Form.Select label={t("File type")} options={FILE_TYPES.map(item => ({...item, text: delegateFileTypeName(item.value, portal.committeeLanguage)}))} value={fileType} disabled={working}
          onChange={(_, data) => {setFileType(data.value as DelegateFileType); setError(undefined);}} />
        <Form.Field>
          <label>{t("Choose file")}</label>
          {maxUploadSizeMiB === '—'
            ? null
            : <small className="ui tiny text delegate-file-upload-limit-note">{t('Maximum file size: {size} MiB', {size: maxUploadSizeMiB})}</small>}
          <input type="file" disabled={working} accept={portal.allowedExtensions?.[fileType].map(ext => `.${ext}`).join(',')} onChange={(event: React.ChangeEvent<HTMLInputElement>) => {setFile(event.currentTarget.files?.[0]);
            setSubmitted(false); setProgress(undefined);}} aria-label={t("Choose file")} />
        </Form.Field>
        {uploadSizeError && <Message negative role="alert" content={uploadSizeError} />}
        {portal.allowedExtensions && <p className="delegate-file-allowed-formats">{t("Allowed formats:")}{portal.allowedExtensions[fileType].join('、')}</p>}
        {!submitted && progress === undefined && <Button primary fluid disabled={!file || working || !portal.mayUpload || Boolean(uploadSizeError)}>

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
  </div>;
}

import {t, useLanguage, getLanguage} from '../../i18n';
import {delegateFileTypeName, committeeContentName, formatCommitteeContent} from '@quorum/contracts';
import * as React from 'react';
import type {CommitteeWorkspaceSnapshot, DelegateFileType, DelegateReviewFile, DelegateFileSettings} from '@quorum/contracts';
import QRCode from 'qrcode';
import {Button, Card, Form, Header, Icon, Image, Label, Message, Modal, Progress, Segment, Table} from 'semantic-ui-react';
import {newIdempotencyKey, SelfHostedApiError, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';
import FilesPanel, {storageErrorText} from './FilesPanel';
import {Link} from 'react-router-dom';

const FILE_TYPES: Array<{key: DelegateFileType; value: DelegateFileType; text: string}> = [
  {key: 'WORKING_PAPER', value: 'WORKING_PAPER', text: 'Working Paper'},
  {key: 'DIRECTIVE_DRAFT', value: 'DIRECTIVE_DRAFT', text: 'Draft Directive'},
  {key: 'RESOLUTION_DRAFT', value: 'RESOLUTION_DRAFT', text: 'Draft Resolution'}
];

function dateTime(value: string | null): string { return value ? new Date(value).toLocaleString(getLanguage()) : '—'; }
const toSubmissionTime = (value: string | null): number => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

type Share = Awaited<ReturnType<SelfHostedApi['getDelegateFileShare']>>;

// This parent stays mounted across file tabs; only server data is retained.
export function DelegateFilePanels({snapshot, api, tab, currentUserId}: {
  snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi; tab: string; currentUserId?: string;
}) {
  useLanguage();
  const [share, setShare] = React.useState<Share>();
  const [qr, setQr] = React.useState('');
  React.useEffect(() => {
    let active = true;
    setQr('');
    if (share?.url) void QRCode.toDataURL(share.url, {width: 260, margin: 1})
      .then(value => {if (active) setQr(value);}).catch(() => undefined);
    return () => {active = false;};
  }, [share?.url]);

  const [files, setFiles] = React.useState<DelegateReviewFile[]>();
  const [shareError, setShareError] = React.useState<string>();
  const [filesError, setFilesError] = React.useState<string>();
  const shareRequest = React.useRef(0); const filesRequest = React.useRef(0);
  const previousTab = React.useRef(tab);
  const refreshShare = React.useCallback(async () => {
    const request = ++shareRequest.current;
    setShareError(undefined);
    try {
      const next = await api.getDelegateFileShare(snapshot.committee.id);
      if (request === shareRequest.current) setShare(next);
    } catch (caught) {
      if (request !== shareRequest.current) return;
      if (caught instanceof SelfHostedApiError && [401, 403, 404].includes(caught.status)) setShare(undefined);
      setShareError(storageErrorText(caught));
    }
  }, [api, snapshot.committee.id]);
  const refreshFiles = React.useCallback(async () => {
    const request = ++filesRequest.current;
    setFilesError(undefined);
    try {
      const next = await api.listDelegateReviewFiles(snapshot.committee.id);
      if (request === filesRequest.current) setFiles(next);
    } catch (caught) {
      if (request !== filesRequest.current) return;
      if (caught instanceof SelfHostedApiError && [401, 403, 404].includes(caught.status)) setFiles(undefined);
      setFilesError(storageErrorText(caught));
    }
  }, [api, snapshot.committee.id]);
  React.useEffect(() => {
    void refreshShare(); void refreshFiles();
    return () => {++shareRequest.current; ++filesRequest.current;};
  }, [refreshShare, refreshFiles, snapshot.sync.committeeEventSequence]);
  React.useEffect(() => {
    if (previousTab.current !== tab) {
      if (tab === 'share') void refreshShare();
      if (tab === 'review' || tab === 'attachments') void refreshFiles();
    }
    previousTab.current = tab;
  }, [tab, refreshShare, refreshFiles]);
  const updateShare = (next: Share) => {
    ++shareRequest.current; setShare(next); setShareError(undefined);
  };
  if (tab !== 'share' && tab !== 'review' && tab !== 'attachments') return null;
  const error = tab === 'share' ? shareError : filesError;
  const refresh = tab === 'share' ? refreshShare : refreshFiles;
  const loaded = tab === 'share' ? share !== undefined : files !== undefined;
  return <>
    {error && <Message error><p>{error}</p><Button onClick={() => void refresh()}>{t("Retry")}</Button></Message>}
    {!loaded ? !error && <Segment basic loading style={{minHeight: 120}} role="status" aria-label={t("Loading")} /> : tab === 'share'
      ? <DelegateFileSharePanel snapshot={snapshot} api={api} share={share!} setShare={updateShare} qr={qr} />
      : tab === 'attachments' ? <FilesPanel section="overview" snapshot={snapshot} api={api} currentUserId={currentUserId}
        reviewFiles={files!} reviewPanel={<DelegateFileReviewPanel snapshot={snapshot} api={api} files={files!} refresh={refreshFiles} />} />
        : <DelegateFileReviewPanel snapshot={snapshot} api={api} files={files!} refresh={refreshFiles} />}
  </>;
}

function DelegateFileSharePanel({snapshot, api, share, setShare, qr}: {
  snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi; share: Share; setShare(share: Share): void; qr: string;
}) {
  useLanguage();
  const [working, setWorking] = React.useState(false);
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? storageErrorText(failure) : undefined;
  const start = async () => {setWorking(true); try {setShare(await api.startDelegateFileShare(snapshot.committee.id,
    snapshot.committee.revision)); setError(undefined);} catch (caught) {setError(caught);} finally {setWorking(false);}};
  const end = async () => {if (!share) return; setWorking(true); try {await api.endDelegateFileShare(snapshot.committee.id,
    share.revision); setShare(null); setError(undefined);} catch (caught) {setError(caught);} finally {setWorking(false);}};
  return <Segment className="delegate-file-share-panel">
    {error && <Message error content={error} />}
    {!share ? <Button primary fluid loading={working} onClick={() => void start()}><Icon name="share alternate" />{t("Start sharing")}</Button> : <>
      <Form><Form.Input readOnly label={t("Delegate link")} value={share.url} action={{basic: true, icon: 'copy', content: t("Copy"),
        onClick: () => void navigator.clipboard?.writeText(share.url)}} /></Form>
      {qr && <Image centered src={qr} alt={t("Delegate link QR code")} className="delegate-file-qr" />}
      <Button negative fluid loading={working} onClick={() => void end()}><Icon name="stop circle outline" />{t("End sharing")}</Button>
    </>}
  </Segment>;
}

export function DelegateFileUploadPanel({snapshot, api}: {snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi}) {
  useLanguage();
  const [selected, setSelected] = React.useState<File>();
  const [pending, setPending] = React.useState<Awaited<ReturnType<SelfHostedApi['listPendingHostCommits']>>>([]);
  const [saved, setSaved] = React.useState<string>();
  const [trackedUpload, setTrackedUpload] = React.useState<{id: string; name: string}>();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const refreshPending = React.useCallback(async () => {
    try {setPending(await api.listPendingHostCommits(snapshot.committee.id));} catch (caught) {setError(caught);}
  }, [api, snapshot.committee.id]);
  React.useEffect(() => {void refreshPending();}, [refreshPending, snapshot.sync.committeeEventSequence]);
  React.useEffect(() => {
    if (!trackedUpload) return;
    let active = true;
    let loading = false;
    const check = async () => {
      if (loading) return;
      loading = true;
      try {
        const current = await api.getFileUpload(trackedUpload.id);
        if (!active) return;
        setError(undefined);
        if (current.status === 'COMMITTED' && current.committedFileEntryId) {
          setSaved(trackedUpload.name); setTrackedUpload(undefined); void refreshPending();
        } else if (current.status === 'FAILED' || current.status === 'CANCELLED' || current.agentCommitState === 'CONFLICT') {
          setError(new SelfHostedApiError(503, 'SERVICE_NOT_READY', 'Storage commit failed.')); setTrackedUpload(undefined);
        }
      } catch (caught) {if (active) setError(caught);} finally {loading = false;}
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => {active = false; window.clearInterval(timer);};
  }, [api, trackedUpload, refreshPending, snapshot.sync.committeeEventSequence]);
  const [progress, setProgress] = React.useState<number>(); const [working, setWorking] = React.useState(false);
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? storageErrorText(failure) : undefined;
  const upload = async () => {
    if (snapshot.committee.status !== 'ACTIVE') return;
    if (!selected || working) return; setWorking(true); setSaved(undefined); setTrackedUpload(undefined); setProgress(0); setError(undefined);
    try {
      const sha256 = await sha256File(selected, {onProgress: (done, total) => setProgress(total ? done / total * 20 : 0)});
      const created = await api.createFileUpload(snapshot.committee.id, {logicalName: selected.name,
        originalName: selected.name, mediaType: selected.type || 'application/octet-stream', expectedSizeBytes: selected.size, sha256});
      await api.uploadFileContent(created.id, selected, newIdempotencyKey(), {onProgress: (done, total) => setProgress(20 + (total ? done / total * 75 : 0))});
      setProgress(98); const result = await api.commitFileUpload(created.id);
      if ('kind' in result) setTrackedUpload({id: created.id, name: selected.name}); else setSaved(selected.name);
      await refreshPending(); setProgress(undefined); setSelected(undefined);
      if (fileInput.current) fileInput.current.value = '';
    } catch (caught) {setProgress(undefined); setError(caught);} finally {setWorking(false);}
  };
  return <div className="delegate-file-upload-panel">
    {pending.map(item => <Message key={item.id} warning={Boolean(item.failureCode || item.agentCommitState === 'CONFLICT')}
      info={!item.failureCode && item.agentCommitState !== 'CONFLICT'} header={item.logicalName}
      content={item.failureCode || item.agentCommitState === 'CONFLICT' ? t('Save unavailable. Check storage and retry.') : t('Saving files')} />)}
    {saved && <Segment className="delegate-file-upload-result" role="status" aria-live="polite">
      <Icon name="check circle" color="green" size="big" />
      <Header as="h3">{t('File submitted for review')}</Header><p>{saved}</p>
      <Button as={Link} primary fluid to={`/committees/${snapshot.committee.id}/posts/attachments`}>{t('View files')} <Icon name="arrow right" /></Button>
    </Segment>}
    {error && <Message error content={error} />}
    <Card centered fluid className="delegate-file-chair-upload"><Card.Content><Form onSubmit={() => void upload()}>
      <Form.Input disabled={working || snapshot.committee.status !== 'ACTIVE'} type="file" label={t("Choose file")} input={{ref: fileInput, onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        {setSelected(event.currentTarget.files?.[0]); setSaved(undefined);}, 'aria-label': t("Choose file")}} />
      {progress === undefined ? <Button primary disabled={!selected || working || snapshot.committee.status !== 'ACTIVE'}>{t("Upload files")} <Icon name="arrow up" /></Button>
        : <Progress percent={Math.round(progress)} progress color="blue">{progress >= 98 ? t("Saving files") : t("Uploading")}</Progress>}
    </Form></Card.Content></Card>
  </div>;
}

function DelegateFileReviewPanel({snapshot, api, files, refresh}: {
  snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi; files: DelegateReviewFile[]; refresh(): Promise<void>;
}) {
  useLanguage();
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [replacing, setReplacing] = React.useState<{fileId: string; revision: number; logicalName: string;
    fileType: DelegateFileType; confirmationToken: string}>();
  const running = React.useRef(false);
  const [rejecting, setRejecting] = React.useState<DelegateReviewFile>();
  const [reason, setReason] = React.useState('');
  const [settings, setSettings] = React.useState<DelegateFileSettings>();
  const [rejectionTypeId, setRejectionTypeId] = React.useState('');
  const [types, setTypes] = React.useState<Record<string, DelegateFileType>>(() =>
    Object.fromEntries(files.map(item => [item.id, item.fileType ?? 'WORKING_PAPER'])));
  const [working, setWorking] = React.useState(false);
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? storageErrorText(failure) : undefined;
  React.useEffect(() => {
    setTypes(current => Object.fromEntries(files.map(item => [item.id, current[item.id] ?? item.fileType ?? 'WORKING_PAPER'])));
  }, [files]);
  const run = async (operation: () => Promise<unknown>) => {if (running.current) return; running.current = true; setWorking(true); setError(undefined); try {await operation(); await refresh();}
    catch (caught) {setError(caught); await refresh().catch(() => {});} finally {running.current = false; setWorking(false);}};
  const nameFor = (file: DelegateReviewFile) => {
    const fileType = types[file.id] ?? file.fileType ?? 'WORKING_PAPER';
    const suggestion = file.suggestedNames?.[fileType];
    return names[file.id] ?? (suggestion ? formatCommitteeContent({kind: 'FILE', fileType, ...suggestion},
      snapshot.committee.committeeLanguage) : file.logicalName);
  };
  const approve = (file: DelegateReviewFile) => run(async () => {
    const logicalName = nameFor(file).trim(); const fileType = types[file.id] ?? file.fileType ?? 'WORKING_PAPER';
    const preview = await api.previewFileApproval(file.id, file.revision, logicalName, fileType);
    if (preview.target && preview.confirmationToken) {
      setReplacing({fileId: file.id, revision: file.revision, logicalName, fileType, confirmationToken: preview.confirmationToken});
    } else await api.approveDelegateFile(file.id, file.revision, logicalName, fileType);
  });
  React.useEffect(() => {
    if (replacing && !files.some(file => file.id === replacing.fileId && file.revision === replacing.revision)) setReplacing(undefined);
  }, [files, replacing]);
  const [downloading, setDownloading] = React.useState<string>();
  const download = async (id: string) => {
    setDownloading(id); setError(undefined);
    try {
      let state = await api.prepareFileDownload(id);
      while (state.status === 'PREPARING') {
        await new Promise(resolve => window.setTimeout(resolve, (state.retryAfterSeconds ?? 2) * 1000));
        state = await api.fileDownloadReadiness(id);
      }
      if (state.status !== 'READY') throw new SelfHostedApiError(503, 'SERVICE_NOT_READY', 'File unavailable');
      window.location.assign(api.fileDownloadUrl(id));
    } catch (caught) {setError(caught);} finally {setDownloading(undefined);}
  };
  const readOnly = snapshot.committee.status !== 'ACTIVE';
  const pendingFiles = files
    .filter(file => ['UPLOAD_COMPLETE', 'PENDING_REVIEW'].includes(file.status))
    .sort((first, second) => toSubmissionTime(first.submittedAt) - toSubmissionTime(second.submittedAt));
  return <div className="delegate-file-review-panel">
    {error && <Message error content={error} />}
    <div className="delegate-file-card-list">{pendingFiles.length ? pendingFiles.map(file => <Card fluid key={file.id} className="delegate-file-card motion-card">
      <Card.Content><div className="motion-heading delegate-file-heading"><Card.Header><Form.Input fluid aria-label={t("File name")} disabled={working || readOnly || Boolean(replacing)} value={nameFor(file)}
        onChange={event => { const value = event.currentTarget.value; setNames(current => ({...current, [file.id]: value})); setReplacing(undefined); }} />
        {files.some(existing => existing.id !== file.id && existing.status === 'PUBLISHED' && !existing.publishedFileId
          && existing.logicalName === nameFor(file).trim()) && <div className="file-name-conflict-hint">{t("This name already exists. Approval will update the existing file.")}</div>}</Card.Header><Label basic color="blue" icon="clock outline" className="self-hosted-file-status" content={t("Pending review")} /></div>
        <Card.Meta><Table compact celled unstackable className="motion-metadata-table delegate-file-metadata"><Table.Body>
          <Table.Row><Table.Cell className="motion-metadata-key">{t("File source")}</Table.Cell><Table.Cell>{file.submissionSource === 'CHAIR' ? t('Chair') : file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">{t("File type")}</Table.Cell><Table.Cell><Form.Select compact options={FILE_TYPES.map(item => ({...item, text: delegateFileTypeName(item.value, snapshot.committee.committeeLanguage)}))}
            disabled={working || readOnly || Boolean(replacing)} value={types[file.id]} onChange={(_, data) => setTypes(current => ({...current,
              [file.id]: data.value as DelegateFileType}))} /></Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">{t("Submitted at")}</Table.Cell><Table.Cell>{dateTime(file.submittedAt)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">{t("Original file")}</Table.Cell><Table.Cell>{file.originalName}</Table.Cell></Table.Row>
        </Table.Body></Table></Card.Meta>
      </Card.Content><Card.Content extra className="delegate-file-review-actions">
        <Button primary fluid loading={downloading === file.id} disabled={Boolean(downloading)}
          onClick={() => void download(file.id)}>{t('Download file')} <Icon name="arrow down" /></Button>
        <Button.Group fluid widths={2} className="delegate-file-decisions"><Button positive disabled={working || readOnly || Boolean(replacing) || !nameFor(file).trim()} onClick={() => void approve(file)}>{t("Approve file")}</Button>
        <Button negative disabled={working || readOnly || Boolean(replacing)} onClick={() => {setRejecting(file); setReason(''); setSettings(undefined); setRejectionTypeId(''); setError(undefined);
          void api.getDelegateFileSettings(snapshot.committee.id).then(next => {setSettings(next); setRejectionTypeId(next.rejectionTypes[0]?.id ?? '');})
            .catch(caught => setError(caught));}}>{t("Reject file")}</Button></Button.Group>
      </Card.Content></Card>) : <Message content={t("No files awaiting review")} />}</div>
    <Modal size="tiny" open={Boolean(replacing)} closeOnDimmerClick={!working} closeOnEscape={!working}
      onClose={() => {if (!working) setReplacing(undefined);}}>
      <Modal.Header>{t('Replace and publish file')}</Modal.Header>
      <Modal.Content><Header as="h4" style={{overflowWrap: 'anywhere'}}>{replacing?.logicalName}</Header>
        <p>{t('This will replace the current version. Draft Resolutions and Amendments that reference this file will use the new version.')}</p>
        {error && <Message error content={error} />}
      </Modal.Content>
      <Modal.Actions><Button disabled={working} onClick={() => setReplacing(undefined)}>{t('Cancel')}</Button>
        <Button positive loading={working} disabled={working} onClick={() => {
          const confirmed = replacing; if (!confirmed) return;
          void run(async () => {
            try {await api.approveDelegateFile(confirmed.fileId, confirmed.revision, confirmed.logicalName,
              confirmed.fileType, confirmed.confirmationToken); setReplacing(undefined);}
            catch (caught) {setReplacing(undefined); throw caught;}
          });
        }}>{t('Confirm replacement and publish')}</Button>
      </Modal.Actions>
    </Modal>
    <Modal size="tiny" open={Boolean(rejecting)} closeOnDimmerClick={!working} closeOnEscape={!working}
      onClose={() => {if (!working) setRejecting(undefined);}}>
      <Modal.Header>{t("Reject file")}</Modal.Header><Modal.Content>
        <Form loading={!settings && !error}><Form.Select label={t("Rejection reason")} aria-label={t("Rejection reason")} selection
          options={settings?.rejectionTypes.map(item => ({key: item.id, value: item.id, text: committeeContentName(item.label, snapshot.committee.committeeLanguage)})) ?? []}
          value={rejectionTypeId} disabled={working} onChange={(_, data) => {setRejectionTypeId(String(data.value)); setReason('');}} />
          {settings?.rejectionTypes.find(item => item.id === rejectionTypeId)?.custom
            ? <Form.TextArea label={t("Message to delegate")} aria-label={t("Message to delegate")} required maxLength={2000} value={reason}
              disabled={working} onChange={(_, data) => setReason(String(data.value))} />
            : <Message content={settings?.rejectionTypes.find(item => item.id === rejectionTypeId) ? committeeContentName(settings.rejectionTypes.find(item => item.id === rejectionTypeId)!.message, snapshot.committee.committeeLanguage) : ''} />}
        </Form>
        {error && <Message error content={error} />}
      </Modal.Content><Modal.Actions><Button disabled={working} onClick={() => setRejecting(undefined)}>{t("Cancel")}</Button>
        <Button negative loading={working} disabled={working || !rejectionTypeId || Boolean(settings?.rejectionTypes.find(item => item.id === rejectionTypeId)?.custom && !reason.trim())} onClick={() => {if (!rejecting) return;
          const file = rejecting; void run(async () => {await api.rejectDelegateFile(file.id,file.revision,nameFor(file),
            types[file.id] ?? file.fileType ?? 'WORKING_PAPER',reason.trim() || undefined, rejectionTypeId);
            setRejecting(undefined);});}}>{t("Confirm rejection")}</Button>
      </Modal.Actions></Modal>
  </div>;
}

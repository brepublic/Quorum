import {ChairAgentDownload} from '../../components/ChairAgentDownload';
import {openChairAgent, downloadChairConfiguration} from '../../services/agent-pairing';
import {ViewportFormSelect} from '../../components/ViewportDropdown';
import {apiErrorText} from '../../i18n';
import {t, useLanguage, getLanguage} from '../../i18n';
import * as React from 'react';
import type {CommitteeWorkspaceSnapshot, FileEntry, FileUpload, StorageMigration, DelegateReviewFile,
  StorageAgentConflict, StorageAgentConflictResolution, StoragePairingSetup, StorageProviderType} from '@quorum/contracts';
import {Button, Card, Divider, Form, Modal, Header, Icon, Label, Message, Progress, Segment, Table} from 'semantic-ui-react';
import {SelfHostedApiError, newIdempotencyKey, type SelfHostedApi} from '../../services/self-hosted-api';
import {delegateFileTypeName, ERROR_TEXT} from '@quorum/contracts';
import {Link} from 'react-router-dom';
import {FileStatusLabel} from '../../components/FileStatusLabel';
import {sha256File} from '../../services/sha256';
import {compareStorageConflict, conflictRecommendationReason} from './conflict-comparison';
import './conflict-comparison.css';

const MIGRATION_STATUS: Record<StorageMigration['status'], string> = {
  COPYING: "Copying", READY_TO_CONFIRM: "Awaiting confirmation", FAILED: "Migration failed", COMPLETED: "Migration completed", CANCELLED: "Cancelled"
};
const HOST_STATUS = {ACTIVE: "Online", DEGRADED: "Offline", REVOKED: "Revoked"} as const;
function migrationFailureText(code: string): string {
  if (code === 'ENOSPC') return t("The Chair computer is out of space. Free space and retry.");
  if (code === 'HOST_TRANSFERRED') return t("The target computer changed. Cancel this migration and select a new target.");
  if (code === 'LOCAL_CONTENT_INVALID' || code === 'ENOENT') return t("The local migration copy is missing or damaged. Retry the migration.");
  if (code === 'LOCAL_WRITE_FAILED') return t("Cannot save on the Chair computer. Check the folder and retry.");
  if (Object.hasOwn(ERROR_TEXT, code)) return apiErrorText({code});
  if (code === 'MANIFEST_CHANGED') return t("The file list changed. Retry the migration.");
  return t("Copy failed. Check the storage service and retry.");
}

export function storageErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return t("Upload cancelled.");
  if (!(error instanceof SelfHostedApiError)) return apiErrorText(error);
  if (error.localization?.reason && error.localization.reason !== error.code) return apiErrorText(error);
  const messages: Partial<Record<string, string>> = {
    PAYLOAD_TOO_LARGE: t("The file is too large. Choose a smaller file."),
    REVISION_CONFLICT: t("The state changed. Try again."),
    IDEMPOTENCY_CONFLICT: t("The request changed. Try again."),
    SERVICE_NOT_READY: t("Storage is unavailable. Check capacity and the storage service, then retry."),
    FORBIDDEN: t("You do not have permission for this action."),
    AUTHENTICATION_REQUIRED: t("Your session expired. Sign in again."),
    LINK_EXPIRED: t("The pairing code expired. Generate a new one."),
    VALIDATION_FAILED: t("Invalid file information. Select the file again.")
  };
  return messages[error.code] ?? apiErrorText(error);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function remainingTime(seconds:number|null):string {
  if (seconds===null) return t("Estimating…");
  const rounded=Math.max(10,Math.ceil(seconds/10)*10);
  return t("About {minutes} min {seconds} sec",{minutes:Math.floor(rounded/60),seconds:rounded%60});
}

type UploadProgress = {phase: 'HASHING' | 'UPLOADING' | 'COMMITTING'; processed: number; total: number};

export default function FilesPanel({snapshot, api, currentUserId, section = 'all', reviewFiles, reviewPanel}: {
  snapshot: CommitteeWorkspaceSnapshot;
  api: SelfHostedApi;
  currentUserId?: string;
  section?: 'attachments' | 'overview' | 'storage' | 'all';
  reviewFiles?: DelegateReviewFile[];
  reviewPanel?: React.ReactNode;
}) {
  useLanguage();
  const committeeId = snapshot.committee.id;
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const canManage = !readOnly && (snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER');
  const canUpload = !readOnly && snapshot.viewer.audience !== 'PUBLIC';
  const [statusFilter, setStatusFilter] = React.useState('ACTIVE');
  const [deletingFile, setDeletingFile] = React.useState<FileEntry>();
  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [pendingHostCommits, setPendingHostCommits] = React.useState<FileUpload[]>([]);
  const [bindings, setBindings] = React.useState<Awaited<ReturnType<SelfHostedApi['listStorageBindings']>>>([]);
  const [configs, setConfigs] = React.useState<Awaited<ReturnType<SelfHostedApi['listS3ProviderConfigs']>>>([]);
  const [migrations, setMigrations] = React.useState<StorageMigration[]>([]);
  const [hosts, setHosts] = React.useState<Awaited<ReturnType<SelfHostedApi['listStorageHosts']>>>([]);
  const [pairing, setPairing] = React.useState<StoragePairingSetup>();
  const pairingHostId = React.useRef<string>();
  const [pairingExpired, setPairingExpired] = React.useState(false);
  const [pairingWaiting, setPairingWaiting] = React.useState(false);
  const [pairingFeedback, setPairingFeedback] = React.useState('');
  const [conflicts, setConflicts] = React.useState<StorageAgentConflict[]>([]);
  const [conflictFiles, setConflictFiles] = React.useState<Record<string, FileEntry>>({});
  const [conflictDecision, setConflictDecision] = React.useState<{item: StorageAgentConflict;
    action: StorageAgentConflictResolution; fileRevision: number | null; title: string; label: string; consequence: string} | null>(null);
  const conflictRefresh = React.useRef(0);
  const [comparisonRetryAt, setComparisonRetryAt] = React.useState(0);
  const conflictList = React.useRef<HTMLDivElement>(null);
  const hasPendingConflicts = conflicts.some(item => item.status === 'PENDING');
  React.useEffect(() => {
    if (hasPendingConflicts && window.location.hash === '#sync-conflicts') {
      conflictList.current?.scrollIntoView({block: 'start'});
      conflictList.current?.focus({preventScroll: true});
    }
  }, [hasPendingConflicts, section]);
  const [conflictNames, setConflictNames] = React.useState<Record<string, string>>({});
  const [selectedFile, setSelectedFile] = React.useState<File>();
  const [logicalName, setLogicalName] = React.useState('');
  const [targetType, setTargetType] = React.useState<StorageProviderType>('SERVER_VOLUME');
  const [targetConfigId, setTargetConfigId] = React.useState('');
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? storageErrorText(failure) : undefined;
  const [working, setWorking] = React.useState(false);
  const [progress, setProgress] = React.useState<UploadProgress>();
  const [preparingDownloads, setPreparingDownloads] = React.useState<Set<string>>(() => new Set());
  const uploadController = React.useRef<AbortController>();

  const downloadFile = async (fileId: string) => {
    setPreparingDownloads(current => new Set(current).add(fileId)); setError(undefined);
    try {
      let readiness = await api.prepareFileDownload(fileId);
      while (readiness.status === 'PREPARING') {
        await new Promise(resolve => window.setTimeout(resolve, (readiness.retryAfterSeconds ?? 2) * 1000));
        readiness = await api.fileDownloadReadiness(fileId);
      }
      if (readiness.status !== 'READY') throw Object.assign(new Error(), {code: readiness.code ?? 'FILE_CONTENT_UNAVAILABLE'});
      window.location.assign(api.fileDownloadUrl(fileId));
    } catch (caught) { setError(caught); }
    finally { setPreparingDownloads(current => { const next = new Set(current); next.delete(fileId); return next; }); }
  };

  const refresh = React.useCallback(async (clearError = true) => {
    const refreshId = ++conflictRefresh.current;
    try {
      const [nextFiles, nextPendingHostCommits] = await Promise.all([
        api.listFiles(committeeId), canUpload ? api.listPendingHostCommits(committeeId) : Promise.resolve([])
      ]);
      if (refreshId !== conflictRefresh.current) return;
      setFiles(nextFiles); setPendingHostCommits(nextPendingHostCommits);
      if (canManage) {
        const [nextBindings, nextConfigs, nextMigrations, nextHosts, nextConflicts] = await Promise.all([
          api.listStorageBindings(committeeId), api.listS3ProviderConfigs(), api.listStorageMigrations(committeeId),
          api.listStorageHosts(committeeId), api.listStorageAgentConflicts(committeeId)
        ]);
        if (refreshId !== conflictRefresh.current) return;
        setBindings(nextBindings); setConfigs(nextConfigs); setMigrations(nextMigrations); setHosts(nextHosts);
        setConflicts(nextConflicts);
        const missingIds = [...new Set(nextConflicts.filter(item => item.status === 'PENDING' && item.fileEntryId
          && !nextFiles.some(file => file.id === item.fileEntryId)).map(item => item.fileEntryId!))];
        const details = await Promise.allSettled(missingIds.map(id => Promise.resolve().then(() => api.getFile(id))));
        if (refreshId !== conflictRefresh.current) return;
        setComparisonRetryAt(details.some(result => result.status === 'rejected') ? Date.now() : 0);
        setConflictFiles(Object.fromEntries(details.flatMap((result, index) => result.status === 'fulfilled'
          && result.value?.committeeId === committeeId ? [[missingIds[index]!, result.value]] : [])));
        setConflictNames(current => Object.fromEntries(nextConflicts.flatMap(item => item.change.kind === 'DELETE'
          ? [] : [[item.id, current[item.id] ?? item.change.logicalName]])));
        const active = nextBindings.find(binding => binding.status === 'ACTIVE');
        const availableS3 = nextConfigs.filter(config => config.status === 'ACTIVE'
          && config.id !== active?.providerConfigId);
        if (active?.providerType === 'SERVER_VOLUME') {
          const chairAvailable=nextHosts.some(host=>host.status==='ACTIVE'||host.status==='DEGRADED');
          setTargetType(current=>current==='CHAIR_AGENT'&&chairAvailable||current==='S3_COMPATIBLE'&&availableS3.length>0
            ?current:chairAvailable?'CHAIR_AGENT':'S3_COMPATIBLE');
          setTargetConfigId(current => availableS3.some(config => config.id === current)
            ? current : availableS3[0]?.id || '');
        } else if (active?.providerType === 'S3_COMPATIBLE') {
          setTargetType(current => current === 'S3_COMPATIBLE' && availableS3.length === 0
            ? 'SERVER_VOLUME' : current);
          setTargetConfigId(current => availableS3.some(config => config.id === current)
            ? current : availableS3[0]?.id || '');
        } else if (active?.providerType === 'CHAIR_AGENT') {
          setTargetType('SERVER_VOLUME'); setTargetConfigId('');
        } else {
          setTargetType(current => current === 'S3_COMPATIBLE' && availableS3.length === 0
            ? 'SERVER_VOLUME' : current);
          setTargetConfigId(current => availableS3.some(config => config.id === current)
            ? current : availableS3[0]?.id || '');
        }
      } else {
        setComparisonRetryAt(0);
        setBindings([]); setConfigs([]); setMigrations([]); setHosts([]); setConflicts([]); setConflictFiles({});
      }
      if (clearError) setError(undefined);
    } catch (caught) {
      if (refreshId !== conflictRefresh.current) return;
      setError(caught);
      setComparisonRetryAt(caught instanceof SelfHostedApiError && [401, 403, 404].includes(caught.status) ? 0 : Date.now());
    }
  }, [api, canManage, canUpload, committeeId]);

  React.useEffect(() => { void refresh(); }, [refresh, snapshot, reviewFiles]);
  React.useEffect(() => {
    if (!comparisonRetryAt) return;
    const retry = window.setTimeout(() => void refresh(), 5000);
    return () => window.clearTimeout(retry);
  }, [comparisonRetryAt, refresh]);
  React.useEffect(() => () => {conflictRefresh.current++;}, []);
  React.useEffect(() => () => uploadController.current?.abort(), []);

  const run = React.useCallback(async (operation: () => Promise<unknown>) => {
    setWorking(true); setError(undefined);
    let failed = false;
    try { await operation(); }
    catch (caught) { failed = true; setError(caught); }
    finally { await refresh(!failed); setWorking(false); }
  }, [refresh]);

  const upload = async () => {
    if (!selectedFile || !logicalName.trim()) return;
    const controller = new AbortController(); uploadController.current = controller;
    setWorking(true); setError(undefined);
    try {
      setProgress({phase: 'HASHING', processed: 0, total: selectedFile.size});
      const sha256 = await sha256File(selectedFile, {signal: controller.signal,
        onProgress: (processed, total) => setProgress({phase: 'HASHING', processed, total})});
      const created = await api.createFileUpload(committeeId, {logicalName: logicalName.trim(),
        originalName: selectedFile.name, mediaType: selectedFile.type || 'application/octet-stream',
        expectedSizeBytes: selectedFile.size, sha256}, newIdempotencyKey());
      setProgress({phase: 'UPLOADING', processed: 0, total: selectedFile.size});
      await api.uploadFileContent(created.id, selectedFile, newIdempotencyKey(), {signal: controller.signal,
        onProgress: (processed, total) => setProgress({phase: 'UPLOADING', processed, total})});
      setProgress({phase: 'COMMITTING', processed: selectedFile.size, total: selectedFile.size});
      await api.commitFileUpload(created.id, newIdempotencyKey());
      setSelectedFile(undefined); setLogicalName(''); setProgress(undefined);
      await refresh();
    } catch (caught) {
      setError(caught);
      setProgress(undefined);
      await refresh(false);
    } finally {
      if (uploadController.current === controller) uploadController.current = undefined;
      setWorking(false);
    }
  };

  const initializeStorage = () => run(() => targetType === 'SERVER_VOLUME'
    ? api.createServerVolumeBinding(committeeId, snapshot.committee.revision)
    : targetType === 'CHAIR_AGENT' ? api.createChairAgentBinding(committeeId, snapshot.committee.revision)
      : api.createS3Binding(committeeId, snapshot.committee.revision, targetConfigId));
  const createMigration = () => run(() => api.createStorageMigration(committeeId, snapshot.committee.revision,
    targetType, targetType === 'S3_COMPATIBLE' ? targetConfigId : undefined));
  const activeBinding = bindings.find(binding => binding.status === 'ACTIVE');
  const activeHost = hosts.find(host => host.status === 'ACTIVE' || host.status === 'DEGRADED');
  const openMigration=migrations.find(item=>!['COMPLETED','CANCELLED'].includes(item.status));
  const hostOnline=Boolean(activeHost?.lastSeenAt&&Date.now()-Date.parse(activeHost.lastSeenAt)<=45_000);
  const chairTargetBlocked=targetType==='CHAIR_AGENT'&&Boolean(activeBinding)&&(!hostOnline||!activeHost?.capabilities.includes('STORAGE_MIGRATION'));
  React.useEffect(()=>{
    if (!canManage||!openMigration||!['storage','all'].includes(section)) return;
    let cancelled=false;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try {const [nextMigrations,nextHosts]=await Promise.all([api.listStorageMigrations(committeeId),api.listStorageHosts(committeeId)]);
        if (!cancelled) {setMigrations(nextMigrations);setHosts(nextHosts);}
      } catch (caught) {if (!cancelled) setError(caught);}
      if (!cancelled) timer=setTimeout(poll,2000);
    };
    timer=setTimeout(poll,2000);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[api,committeeId,canManage,section,openMigration?.id]);
  const createPairing = async (purpose: 'INITIAL' | 'TRANSFER') => {
    setWorking(true); setError(undefined);
    try {
      const result = await api.createStoragePairingCode(committeeId, snapshot.committee.revision, purpose);
      pairingHostId.current = activeHost?.id;
      setPairing(result); setPairingExpired(false); setPairingWaiting(false); setPairingFeedback('');
      openChairAgent(result.configuration);
    }
    catch (caught) { setError(caught); await refresh(false); }
    finally { setWorking(false); }
  };
  React.useEffect(() => {
    if (!pairing) return;
    const checkExpiry = () => setPairingExpired(Date.now() >= Date.parse(pairing.expiresAt));
    checkExpiry();
    const timer = window.setInterval(checkExpiry, 1000);
    const waiting = window.setTimeout(() => setPairingWaiting(true), 8000);
    return () => {window.clearInterval(timer); window.clearTimeout(waiting);};
  }, [pairing]);
  React.useEffect(() => {
    if (pairing && activeHost && activeHost.id !== pairingHostId.current) {
      setPairing(undefined); setPairingFeedback('Pairing completed');
    }
  }, [pairing, activeHost]);
  React.useEffect(() => {setPairing(undefined); setPairingFeedback('');}, [committeeId, canManage]);
  const resolveConflict = (item: StorageAgentConflict, action: StorageAgentConflictResolution) => {
    if (!activeHost) return Promise.reject(Object.assign(new Error(), {code: 'CHAIR_HOST_REQUIRED'}));
    const loadedFile = files.find(file => file.id === item.fileEntryId)
      ?? (item.fileEntryId ? conflictFiles[item.fileEntryId] : undefined);
    const comparison = compareStorageConflict(item, loadedFile, activeHost.id);
    if (!comparison.allowed.includes(action)) return Promise.reject(Object.assign(new Error(), {code: 'RESOURCE_CONFLICT'}));
    const resolvedName = item.change.kind === 'DELETE' ? ''
      : conflictNames[item.id] ?? item.change.logicalName;
    return api.resolveStorageAgentConflict(committeeId, item.id, {baseRevision: item.revision,
      leaseGeneration: activeHost.leaseGeneration, fileRevision: comparison.fileRevision, action,
      ...((action === 'SAVE_AS_NEW' || (action === 'ACCEPT_LOCAL' && item.reasonCode === 'NAME_CONFLICT'))
        ? {logicalName: resolvedName} : {})}, newIdempotencyKey());
  };
  const targetOptions = [
    ...(!activeBinding || (activeBinding.providerType !== 'SERVER_VOLUME' && activeBinding.providerType !== 'CHAIR_AGENT')
      ? [{key: 'volume', value: 'SERVER_VOLUME', text: t("Server volume")}] : []),
    ...((!activeBinding||activeBinding.providerType==='SERVER_VOLUME') && hosts.some(host => host.status === 'ACTIVE' || host.status === 'DEGRADED')
      ? [{key: 'chair-agent', value: 'CHAIR_AGENT', text: t("Chair computer")}] : []),
    ...(activeBinding?.providerType === 'CHAIR_AGENT' ? [] : configs.filter(config => config.status === 'ACTIVE'
      && config.id !== activeBinding?.providerConfigId)).map(config => ({key: config.id,
      value: `S3:${config.id}`, text: `S3 · ${config.displayName}`}))
  ];
  const setTarget = (value: string) => {
    if (value === 'SERVER_VOLUME' || value === 'CHAIR_AGENT') { setTargetType(value); setTargetConfigId(''); }
    else { setTargetType('S3_COMPATIBLE'); setTargetConfigId(value.slice(3)); }
  };
  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round(progress.processed / progress.total * 100)) : 0;

  const isPending = (file: FileEntry) => ['UPLOAD_COMPLETE', 'PENDING_REVIEW'].includes(file.status);
  const reviewTimes = new Map(reviewFiles?.map(file => [file.id, file.reviewedAt]));
  const timestamp = (value?: string | null) => value ? Date.parse(value) || 0 : 0;
  const visibleFiles = files.filter(file => statusFilter === 'REJECTED' ? file.status === 'REJECTED'
    : file.status === 'PUBLISHED' || (!reviewPanel && isPending(file)))
    .sort((first, second) => Number(isPending(second)) - Number(isPending(first))
      || (isPending(first) ? timestamp(first.submittedAt) - timestamp(second.submittedAt)
        : timestamp(reviewTimes.get(second.id) ?? second.publishedAt) - timestamp(reviewTimes.get(first.id) ?? first.publishedAt)));

  return <div className="self-hosted-files">
    <Modal open={Boolean(conflictDecision)} size="small" closeOnDimmerClick={false}
      onClose={() => {if (!working) setConflictDecision(null);}} aria-labelledby="conflict-decision-title">
      <Modal.Header id="conflict-decision-title">{t('Confirm your file choice')}</Modal.Header>
      <Modal.Content>
        <p><strong>{conflictDecision?.title}</strong></p>
        <p>{conflictDecision && t(conflictDecision.consequence)}</p>
        {conflictDecision?.action !== 'SAVE_AS_NEW' && <Message warning>
          <Message.Header>{t('This action cannot be undone in this interface.')}</Message.Header>
          <p>{t('Before confirming, compare both files and back up any content you want to keep.')}</p>
        </Message>}
      </Modal.Content>
      <Modal.Actions>
        <Button disabled={working} onClick={() => setConflictDecision(null)}>{t('Go back to compare')}</Button>
        <Button negative={conflictDecision?.action !== 'SAVE_AS_NEW'} primary={conflictDecision?.action === 'SAVE_AS_NEW'}
          loading={working} disabled={working} onClick={() => {
            const decision = conflictDecision;
            if (!decision) return;
            const current = conflicts.find(item => item.id === decision.item.id && item.status === 'PENDING');
            const loaded = files.find(file => file.id === current?.fileEntryId) ?? (current?.fileEntryId ? conflictFiles[current.fileEntryId] : undefined);
            if (!current || current.revision !== decision.item.revision
              || compareStorageConflict(current, loaded, activeHost?.id).fileRevision !== decision.fileRevision) {
              setConflictDecision(null); setError(new SelfHostedApiError(409, 'REVISION_CONFLICT', 'Conflict changed')); return;
            }
            void run(async () => {await resolveConflict(current, decision.action); setConflictDecision(null);});
          }}>{t('Confirm choice: {choice}', {choice: conflictDecision ? t(conflictDecision.label) : ''})}</Button>
      </Modal.Actions>
    </Modal>
    {error && <Message error role="alert" content={error} />}
    {section !== 'storage' && <>
    {pendingHostCommits.map(item => <Message key={item.id} header={item.logicalName}
      warning={Boolean(item.failureCode || item.agentCommitState === 'CONFLICT')}
      content={item.failureCode && Object.hasOwn(ERROR_TEXT, item.failureCode) ? apiErrorText({code: item.failureCode})
        : item.agentCommitState === 'CONFLICT' ? apiErrorText({code: 'LOCAL_FILE_CONFLICT'})
        : item.failureCode ? t('Save unavailable. Check storage and retry.') : t('Saving files')} />)}
    {canUpload && section !== 'overview' && <Segment loading={working && !progress}><Header as="h3">{t("Upload files")}</Header>
      <Form onSubmit={() => void upload()}><Form.Field>
        <div className="localized-file-picker"><input id="committee-upload-file" type="file"
          aria-label={t('Select a file to upload')} onChange={event => {const file = event.currentTarget.files?.[0];
            setSelectedFile(file); if (file) setLogicalName(file.name);}} />
          <label htmlFor="committee-upload-file" className="ui button">{t('Choose file')}</label>
          <span>{selectedFile?.name ?? t('No file chosen')}</span></div>
      </Form.Field>
      <Form.Input label={t("File name")} value={logicalName} onChange={event => setLogicalName(event.currentTarget.value)} />
      <Button primary disabled={working || !selectedFile || !logicalName.trim()}>{t("Upload files")} <Icon name="arrow up" /></Button>
      {progress && progress.phase !== 'COMMITTING'
        && <Button type="button" onClick={() => uploadController.current?.abort()}>{t("Cancel upload")}</Button>}
      </Form>
      {progress && <Progress percent={progressPercent} progress aria-label={progress.phase === 'HASHING' ? t("Verifying file")
        : progress.phase === 'UPLOADING' ? t("Uploading file") : t("Committing file")}>
        {progress.phase === 'HASHING' ? t("Verifying") : progress.phase === 'UPLOADING' ? t("Uploading") : t("Committing")}
      </Progress>}
    </Segment>}

    <div className="self-hosted-file-overview">
    <div className="self-hosted-file-toolbar">
    <Form.Select aria-label={t('File status')} value={statusFilter} onChange={(_, data) => setStatusFilter(String(data.value))}
      options={[{key: 'ACTIVE', value: 'ACTIVE', text: t('Pending and published')},
        {key: 'REJECTED', value: 'REJECTED', text: t('File status: Rejected')}]} /></div>
    {statusFilter === 'ACTIVE' && reviewPanel}
    {statusFilter === 'ACTIVE' && reviewPanel && visibleFiles.length > 0 && <Divider className="delegate-file-review-divider" />}
    {visibleFiles.length === 0 ? (!reviewPanel || statusFilter === 'REJECTED') && <Message content={t("No files")} /> : <div className="self-hosted-file-list">
      {visibleFiles.map((file, index) => {
        const ownsFile = currentUserId === file.createdByUserId;
        const canChange = !readOnly && (canManage || ownsFile);
        return <React.Fragment key={file.id}>
          {index > 0 && isPending(visibleFiles[index - 1]) && !isPending(file) && <Divider className="delegate-file-review-divider" />}
          <Card fluid className="self-hosted-file-card motion-card"><Card.Content>
          <div className="motion-heading self-hosted-file-heading"><Card.Header>{file.logicalName}</Card.Header>
            <FileStatusLabel status={file.status} />
          </div>
          {file.syncState !== 'SYNCED' && <div className="self-hosted-file-sync"><Label color="orange" icon="sync"
            content={file.syncState === 'PENDING_HOST_COMMIT' ? t("Waiting for the chair computer to save") : t("Waiting for chair computer sync")} /></div>}
          <Table compact celled unstackable className="motion-metadata-table self-hosted-file-metadata"><Table.Body>
            <Table.Row><Table.Cell className="motion-metadata-key">{t('File source')}</Table.Cell><Table.Cell>{file.submissionSource === 'CHAIR' ? t('Chair') : file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">{t('File type')}</Table.Cell><Table.Cell>{file.fileType ? delegateFileTypeName(file.fileType, snapshot.committee.committeeLanguage) : '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">{t('Submitted at')}</Table.Cell><Table.Cell>{file.submittedAt ? new Date(file.submittedAt).toLocaleString(getLanguage()) : '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">{t('Original file')}</Table.Cell><Table.Cell>
              {file.currentVersion.originalName}<span className="self-hosted-file-size">{formatBytes(file.currentVersion.sizeBytes)}</span>
            </Table.Cell></Table.Row>
          </Table.Body></Table>
          {file.rejectionReason && <div className="self-hosted-file-rejection">
            <strong>{t('Rejection reason')}</strong><p>{file.rejectionReason}</p>
          </div>}
        </Card.Content><Card.Content extra className="self-hosted-file-actions">
          <Button as="a" primary fluid href={api.fileDownloadUrl(file.id)} download
            loading={preparingDownloads.has(file.id)} disabled={preparingDownloads.has(file.id)}
            onClick={(event: React.MouseEvent) => {event.preventDefault(); void downloadFile(file.id);}}>
            {preparingDownloads.has(file.id) ? t("Preparing the file from the chair computer") : <>{t("Download file")} <Icon name="arrow down" /></>}</Button>
          {canChange && file.status === 'UPLOAD_COMPLETE' && <Button size="small"
            onClick={() => void run(() => api.submitFileForReview(file.id, file.revision))}>{t("Submit for review")}</Button>}
          {canManage && ['PENDING_REVIEW', 'UPLOAD_COMPLETE'].includes(file.status) && <Button as={Link} primary size="small"
            to={`/committees/${committeeId}/posts/review`}>{t("File review")}</Button>}
          {canChange && <Button negative fluid disabled={working} onClick={() => setDeletingFile(file)}>{t("Delete permanently")} <Icon name="trash alternate outline" /></Button>}
        </Card.Content></Card></React.Fragment>;
      })}
    </div>}</div></>}

    <Modal size="tiny" open={Boolean(deletingFile)} closeOnDimmerClick={!working} closeOnEscape={!working}
      onClose={() => {if (!working) setDeletingFile(undefined);}}>
      <Modal.Header>{t('Delete permanently')}</Modal.Header>
      <Modal.Content>{t('Permanently delete “{name}”? The file will become unavailable and cannot be recovered.', {name: deletingFile?.logicalName ?? ''})}</Modal.Content>
      <Modal.Actions><Button disabled={working} onClick={() => setDeletingFile(undefined)}>{t('Cancel')}</Button>
        <Button negative loading={working} disabled={working} onClick={() => {const file = deletingFile; if (!file || working) return;
          void run(async () => {await api.deleteFile(file.id, file.revision); setDeletingFile(undefined);});}}>{t('Delete permanently')}</Button></Modal.Actions>
    </Modal>

    {(section === 'storage' || section === 'all') && canManage && <Segment loading={working && !progress} className="self-hosted-storage-panel">
      {conflicts.some(item => item.status === 'PENDING') && <div id="sync-conflicts" ref={conflictList} tabIndex={-1} aria-label={t("Sync conflicts")} className="self-hosted-storage-conflicts">
        <div className="conflict-section-header"><Header as="h3">{t("File conflicts")}</Header>
          <p aria-live="polite">{t("{count} files to resolve", {count: conflicts.filter(item => item.status === 'PENDING').length})}</p></div>
        {conflicts.filter(item => item.status === 'PENDING').map(item => {
          const loadedFile = files.find(file => file.id === item.fileEntryId)
            ?? (item.fileEntryId ? conflictFiles[item.fileEntryId] : undefined);
          const comparison = compareStorageConflict(item, loadedFile, activeHost?.id);
          const serverFile = comparison.serverFile;
          const originalName = serverFile?.logicalName
            ?? (loadedFile?.id === item.fileEntryId ? loadedFile?.logicalName : undefined);
          const title = item.change.kind === 'RENAME' ? item.change.logicalName
            : originalName ?? (item.change.kind === 'DELETE' ? t("Local deletion") : item.change.logicalName);
          const localLabel = item.change.kind === 'DELETE' ? "Delete server file"
            : item.change.kind === 'RENAME' ? "Use local name" : "Keep local version";
          const recommendation = comparison.recommended === 'KEEP_SERVER' ? "Keep server version"
            : comparison.recommended === 'ACCEPT_LOCAL' ? localLabel : "Keep both versions";
          const recommended = (action: StorageAgentConflictResolution) => comparison.recommended === action
            ? <span className="conflict-recommendation" aria-label={`${t("Recommended")}: ${t(recommendation)}`}>
              {t("Recommended choice")}</span> : null;
          const choose = (action: StorageAgentConflictResolution) => {
            const consequence = action === 'KEEP_SERVER' ? "Replace the local file with the server version?"
              : action === 'SAVE_AS_NEW' ? "Save the local file separately and keep the server version?"
              : item.change.kind === 'DELETE' ? "Delete the server file as well?"
              : item.change.kind === 'RENAME' ? "Apply the local name to the server file?"
              : "Replace the server contents with the local version?";
            setConflictDecision({item, action, title, fileRevision: comparison.fileRevision, label: action === 'KEEP_SERVER' ? 'Keep server version'
              : action === 'SAVE_AS_NEW' ? 'Keep both versions' : localLabel,
              consequence: item.change.kind === 'UPSERT' && action !== 'SAVE_AS_NEW'
                ? action === 'KEEP_SERVER' ? 'The file on the Chair computer will be replaced by the server file. Local changes will be discarded.'
                  : 'The server file will be replaced by the file on the Chair computer. Others will download the replacement.'
                : consequence});
          };
          return <Card key={item.id} fluid data-conflict-id={item.id} className="conflict-card">
          <Card.Content><Card.Header>{title}</Card.Header>
            <div className="conflict-decision-summary">
              <span>{t(conflictRecommendationReason(comparison) ?? comparison.summary)}</span>
              {comparison.recommended === 'SAVE_AS_NEW' && <span className="conflict-recommendation">{t("Recommended")}: {t("Keep both versions")}</span>}
            </div>
            {item.change.kind === 'UPSERT' && comparison.downloadFileId && comparison.relation !== 'IDENTICAL' && <p className="conflict-compare-reminder">
              {t('Before choosing, download the server file and compare it with the file on the Chair computer. Back up any content you want to keep.')}</p>}
            <div className="conflict-versions" aria-label={t("Version comparison")}>
              <section className={`conflict-version${comparison.recommended === 'ACCEPT_LOCAL' ? ' conflict-version-recommended' : ''}`} aria-label={t("Local version")}>
                <div className="conflict-version-heading"><h5><Icon name="computer" />{t("Local version")}</h5>{recommended('ACCEPT_LOCAL')}</div>
                <p className="conflict-source">{hosts.find(host => host.id === item.hostId)?.deviceLabel ?? t("Chair computer")}</p>
                <dl>
                  {item.change.kind === 'UPSERT' ? <div><dt>{t("Size")}</dt><dd>{formatBytes(item.change.sizeBytes)}</dd></div>
                    : <div><dt>{t("Local change")}</dt><dd>{t(item.change.kind === 'RENAME' ? "Rename" : "Local deletion")}</dd></div>}
                  {item.change.kind === 'RENAME' && <div><dt>{t("New file name")}</dt><dd>{item.change.logicalName}</dd></div>}
                </dl>
                {item.reasonCode === 'NAME_CONFLICT' && comparison.allowed.includes('ACCEPT_LOCAL') && item.change.kind !== 'DELETE'
                  && <Form.Input label={t("New file name")} aria-label={t("New file name")}
                    value={conflictNames[item.id] ?? item.change.logicalName}
                    onChange={event => {const value = event.currentTarget.value; setConflictNames(current => ({...current, [item.id]: value}));}} />}
                <div className="conflict-version-actions"><Button basic color="blue" size="small"
                  disabled={working || !comparison.allowed.includes('ACCEPT_LOCAL') || item.reasonCode === 'NAME_CONFLICT' && !conflictNames[item.id]?.trim()}
                  onClick={() => choose('ACCEPT_LOCAL')}>{t(localLabel)}</Button></div>
                {!comparison.allowed.includes('ACCEPT_LOCAL') && <p className="conflict-choice-help">{t(comparison.merged
                  ? "Open the published file to update it." : comparison.relation === 'DELETED'
                  ? "Save a new file to retain the local content." : item.hostId !== activeHost?.id
                  ? "This change came from a replaced Chair computer." : "Waiting for the latest file information.")}</p>}
              </section>
              <section className={`conflict-version${comparison.recommended === 'KEEP_SERVER' ? ' conflict-version-recommended' : ''}`} aria-label={t("Server version")}>
                <div className="conflict-version-heading"><h5><Icon name="cloud" />{t("Server version")}</h5>{recommended('KEEP_SERVER')}</div>
                <p className="conflict-source">{serverFile?.logicalName ?? loadedFile?.logicalName ?? t("Server version")}</p>
                <dl>
                  <div><dt>{t("File status")}</dt><dd>{serverFile ? <FileStatusLabel status={serverFile.status} /> : t("Unknown")}</dd></div>
                  {serverFile?.currentVersion && serverFile.status !== 'DELETED' && <>
                    <div><dt>{t("Size")}</dt><dd>{formatBytes(serverFile.currentVersion.sizeBytes)}</dd></div>
                  </>}
                </dl>
                {comparison.downloadFileId && <a className="conflict-download" href={api.fileDownloadUrl(comparison.downloadFileId)} download
                  aria-disabled={preparingDownloads.has(comparison.downloadFileId)}
                  onClick={(event: React.MouseEvent) => {event.preventDefault(); if (!preparingDownloads.has(comparison.downloadFileId!)) void downloadFile(comparison.downloadFileId!);}}>
                  <Icon name="download" />{preparingDownloads.has(comparison.downloadFileId) ? t("Preparing server version")
                    : t(comparison.merged ? "Download formal server version" : "Download server version")}
                </a>}
                <div className="conflict-version-actions"><Button basic color="blue" size="small"
                  disabled={working || !comparison.allowed.includes('KEEP_SERVER')} onClick={() => choose('KEEP_SERVER')}>
                  {t("Keep server version")}</Button></div>
              </section>
            </div>
            {comparison.allowed.includes('ACCEPT_LOCAL') && serverFile?.publishedAt && item.change.kind === 'UPSERT'
              && <p className="conflict-choice-help">{t("If you choose the local version, it will replace the server file. Others will download the replacement.")}</p>}
            <div className="conflict-secondary-actions">
              {comparison.allowed.includes('SAVE_AS_NEW') && item.change.kind === 'UPSERT' && <details className="conflict-save-both">
                <summary>{t("Keep both versions")}</summary>
                <Form.Input label={t("Save as name")} aria-label={t("Save as name")}
                  value={conflictNames[item.id] ?? item.change.logicalName}
                  onChange={event => {const value = event.currentTarget.value; setConflictNames(current => ({...current, [item.id]: value}));}} />
                <Button size="small" disabled={working || !conflictNames[item.id]?.trim()} onClick={() => choose('SAVE_AS_NEW')}>{t("Save as a new file")}</Button>
              </details>}
              <details className="conflict-fingerprints"><summary>{t("Technical details")}</summary>
                <div className="conflict-detail-group">
                  <h5>{t("Version records")}</h5>
                  <p className="conflict-detail-hint">{t("Compare the server record used by the local file with the current server record.")}</p>
                  <dl className="conflict-detail-list conflict-records">
                    <div><dt>{t("Server record number when the local file last synced")}</dt><dd>{item.localBaseRevision ?? '—'}</dd></div>
                    <div><dt>{t("Current server record number")}</dt><dd>{serverFile?.revision ?? '—'}</dd></div>
                    {serverFile?.currentVersion && <div><dt>{t("Server version created at")}</dt><dd>{new Date(serverFile.currentVersion.createdAt).toLocaleString(getLanguage())}</dd></div>}
                  </dl>
                </div>
                {item.change.kind === 'UPSERT' && <div className="conflict-detail-group">
                  <h5>{t("Content checksums (SHA-256)")}</h5>
                  <p className="conflict-detail-hint">{t("Matching checksums indicate identical file contents.")}</p>
                  <dl className="conflict-detail-list">
                    <div><dt>{t("Local version")}</dt><dd><code>{item.change.sha256}</code></dd></div>
                    <div><dt>{t("Server version")}</dt><dd><code>{serverFile?.currentVersion?.sha256 ?? '—'}</code></dd></div>
                  </dl>
                </div>}
              </details>
            </div>
          </Card.Content></Card>;

        })}

      </div>}
      <Header as="h3">{t("File storage")}</Header>
      <div className="storage-settings-row">
        <div><Header as="h4">{t("Chair computer")}</Header>
          {activeHost ? <span>{activeHost.deviceLabel} · {t(HOST_STATUS[activeHost.status])}
            {activeHost.lastSeenAt ? ` · ${new Date(activeHost.lastSeenAt).toLocaleString(getLanguage())}` : ''}</span>
            : <span>{t("Not paired")}</span>}
        </div>
        <div className="self-hosted-storage-host-actions">
          <ChairAgentDownload />
          {!pairing && <Button type="button" primary size="small" disabled={working||Boolean(openMigration)}
            onClick={() => void createPairing(activeHost ? 'TRANSFER' : 'INITIAL')}>
            {activeHost ? t("Transfer to another computer") : t("Pair chair computer")}</Button>}
          {activeHost && <Button type="button" basic negative size="small" disabled={working||Boolean(openMigration)} onClick={() => {
            if (window.confirm(t('Revoke “{name}”?', {name: activeHost.deviceLabel}))) {
              void run(() => api.revokeStorageHost(committeeId, activeHost.id, snapshot.committee.revision));
            }
          }}>{t("Revoke chair computer")}</Button>}
        </div>
      </div>
      {pairingFeedback && <Message positive={pairingFeedback !== "Copy failed. Select and copy the code."} warning={pairingFeedback === "Copy failed. Select and copy the code."} role="status">{t(pairingFeedback)}</Message>}
      {pairing && <Message info={!pairingExpired} warning={pairingExpired}>
        <div className="storage-settings-row">
          <div><Message.Header>{t(pairingExpired ? "Pairing configuration expired" : "Waiting for Chair Agent")}</Message.Header>
            <span>{t("· Expires at")} {new Date(pairing.expiresAt).toLocaleTimeString(getLanguage())}</span></div>
          <div className="self-hosted-storage-host-actions">
            {pairingExpired ? <Button type="button" primary onClick={() => void createPairing(activeHost ? 'TRANSFER' : 'INITIAL')}>
              {t("Generate new configuration")}</Button> : <>
              <Button type="button" primary onClick={() => openChairAgent(pairing.configuration)}>{t("Open Chair Agent")}</Button>
              <Button type="button" onClick={() => downloadChairConfiguration(pairing.configuration)}>{t("Download pairing file")}</Button>
            </>}
            <Button type="button" basic onClick={() => setPairing(undefined)}>{t("Close")}</Button>
          </div>
        </div>
        {!pairingExpired && pairingWaiting && <p>{t("Pairing is not complete. If the Agent did not open, download the pairing file and select it in the Agent.")}</p>}
        {!pairingExpired && <details className="storage-pairing-manual"><summary>{t("Manual pairing")}</summary>
          <code className="self-hosted-pairing-code">{pairing.code}</code>
          <Button type="button" basic size="small" onClick={async () => {
            try {await navigator.clipboard.writeText(pairing.code); setPairingFeedback('Pairing code copied');}
            catch {setPairingFeedback('Copy failed. Select and copy the code.');}
          }}><Icon name="copy" />{t("Copy pairing code")}</Button>
        </details>}
      </Message>}
      {activeBinding && <p>{t("Current:")}{activeBinding.providerType === 'SERVER_VOLUME' ? t("Server volume")
        : activeBinding.providerType === 'CHAIR_AGENT' ? t("Chair computer")
          : `S3 · ${configs.find(config => config.id === activeBinding.providerConfigId)?.displayName ?? t("Configured storage")}`}</p>}
      {!openMigration && (targetOptions.length > 0 ? <Form onSubmit={activeBinding ? createMigration : initializeStorage}>
        <div className="storage-settings-row storage-target-row">
          <ViewportFormSelect label={activeBinding ? t("Migrate to") : t("Initial storage")} options={targetOptions}
            value={targetType === 'S3_COMPATIBLE' ? `S3:${targetConfigId}` : targetType}
            onChange={(_, data) => setTarget(String(data.value))} />
          <Button primary disabled={working || chairTargetBlocked || (targetType === 'S3_COMPATIBLE' && !targetConfigId)}>
            {activeBinding ? t("Start migration") : t("Enable storage")}</Button>
        </div>
        {chairTargetBlocked&&<p>{t(!hostOnline?"The Chair computer is offline.":"Update the Chair Agent to migrate storage.")}</p>}
      </Form> : <p className="storage-empty-target">{t("No available storage migration targets")}</p>)}
      {migrations.length > 0 && <Card.Group stackable className="self-hosted-migrations">{migrations.map(migration =>
        <Card fluid key={migration.id}><Card.Content><Card.Header>{t(MIGRATION_STATUS[migration.status])}</Card.Header>
          {!migration.progress&&<Card.Meta>{migration.completedItems}/{migration.totalItems}</Card.Meta>}
          {migration.progress&&<Card.Description>
            <p>{t("Server volume")} → {t("Chair computer")} · {migration.progress.targetDeviceLabel}</p>
            {migration.status==='COPYING'&&<p>{t(!migration.progress.online?"Connection interrupted":
              ({WAITING:"Waiting for Chair computer",TRANSFERRING:"Transferring files",VERIFYING:"Verifying files",
                CONFIRMING:"Verifying before switch",IDLE:"Waiting for Chair computer"} as const)[migration.progress.phase])}</p>}
            {migration.progress.phase==='CONFIRMING'&&<p>{t("Verifying before switch")}</p>}
            <Progress color="blue" size="small" percent={migration.progress.totalBytes>0
              ?100*migration.progress.completedBytes/migration.progress.totalBytes:migration.status==='COPYING'?0:100}
              aria-label={t("Verified migration progress")} />
            <p>{t("Verified content")} {migration.completedItems}/{migration.totalItems} · {formatBytes(migration.progress.completedBytes)} / {formatBytes(migration.progress.totalBytes)}</p>
            {migration.status==='COPYING'&&migration.progress.currentName&&<>
              <p>{migration.progress.currentName} · {formatBytes(migration.progress.currentBytes)} / {formatBytes(migration.progress.currentTotalBytes)}</p>
              <Progress color="blue" size="tiny" percent={migration.progress.currentTotalBytes>0
                ?100*migration.progress.currentBytes/migration.progress.currentTotalBytes:0} aria-label={t("Current file progress")} />
            </>}
            {migration.status==='COPYING'&&<p>{t("Estimated time remaining")}: {migration.progress.online
              ?remainingTime(migration.progress.remainingSeconds):t("Re-estimate after reconnecting")}</p>}
          </Card.Description>}
          {migration.failureCode && <Card.Description>{migrationFailureText(migration.failureCode)}</Card.Description>}
        </Card.Content>{!['COMPLETED','CANCELLED'].includes(migration.status)&&<Card.Content extra>
          {migration.status === 'FAILED' && <Button size="small"
            onClick={() => void run(() => api.retryStorageMigration(migration.id, migration.revision))}>{t("Retry migration")}</Button>}
          {migration.status === 'READY_TO_CONFIRM' && migration.progress?.phase!=='CONFIRMING' && <Button primary size="small"
            disabled={working||Boolean(migration.progress&&!migration.progress.online)}
            onClick={() => void run(() => api.confirmStorageMigration(migration.id, migration.revision))}>{t("Confirm switch")}</Button>}
          {!['COMPLETED', 'CANCELLED'].includes(migration.status) && <Button size="small"
            onClick={() => { if (window.confirm(t("Cancel this storage migration?"))) {
              void run(() => api.cancelStorageMigration(migration.id, migration.revision));
            } }}>{t("Cancel migration")}</Button>}
        </Card.Content>}</Card>)}</Card.Group>}
    </Segment>}
  </div>;
}

import {apiErrorText} from '../../i18n';
import {t, useLanguage, getLanguage} from '../../i18n';
import * as React from 'react';
import type {CommitteeWorkspaceSnapshot, FileEntry, FileUpload, StorageMigration,
  StorageAgentConflict, StorageAgentConflictResolution, StoragePairingCode, StorageProviderType} from '@quorum/contracts';
import {Button, Card, Form, Header, Label, Message, Progress, Segment} from 'semantic-ui-react';
import {SelfHostedApiError, newIdempotencyKey, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';

const FILE_STATUS: Record<FileEntry['status'], string> = {
  UPLOAD_COMPLETE: "Upload complete", PENDING_REVIEW: "Pending review", PUBLISHED: "Published", REJECTED: "File status: Rejected", DELETED: "Deleted"
};
const MIGRATION_STATUS: Record<StorageMigration['status'], string> = {
  COPYING: "Copying", READY_TO_CONFIRM: "Awaiting confirmation", FAILED: "Migration failed", COMPLETED: "Migration completed", CANCELLED: "Cancelled"
};
const HOST_STATUS = {ACTIVE: "Online", DEGRADED: "Offline", REVOKED: "Revoked"} as const;
const CONFLICT_REASON: Record<StorageAgentConflict['reasonCode'], string> = {
  MANIFEST_STALE: "Sync state changed", FILE_DELETED: "File deleted", REVISION_CONFLICT: "A newer file version exists",
  NAME_CONFLICT: "File name conflict", HOST_TRANSFERRED: "Chair computer transferred"
};

function migrationFailureText(code: string): string {
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
    RESOURCE_CONFLICT: t("The current state does not allow this action."),
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

type UploadProgress = {phase: 'HASHING' | 'UPLOADING' | 'COMMITTING'; processed: number; total: number};

export default function FilesPanel({snapshot, api, currentUserId, section = 'all'}: {
  snapshot: CommitteeWorkspaceSnapshot;
  api: SelfHostedApi;
  currentUserId?: string;
  section?: 'attachments' | 'storage' | 'all';
}) {
  useLanguage();
  const committeeId = snapshot.committee.id;
  const readOnly = snapshot.committee.status === 'ARCHIVED' || snapshot.committee.status === 'DELETING';
  const canManage = !readOnly && (snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER');
  const canUpload = !readOnly && snapshot.viewer.audience !== 'PUBLIC';
  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [pendingHostCommits, setPendingHostCommits] = React.useState<FileUpload[]>([]);
  const [bindings, setBindings] = React.useState<Awaited<ReturnType<SelfHostedApi['listStorageBindings']>>>([]);
  const [configs, setConfigs] = React.useState<Awaited<ReturnType<SelfHostedApi['listS3ProviderConfigs']>>>([]);
  const [migrations, setMigrations] = React.useState<StorageMigration[]>([]);
  const [hosts, setHosts] = React.useState<Awaited<ReturnType<SelfHostedApi['listStorageHosts']>>>([]);
  const [pairing, setPairing] = React.useState<StoragePairingCode>();
  const [conflicts, setConflicts] = React.useState<StorageAgentConflict[]>([]);
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
      if (readiness.status !== 'READY') throw new Error(readiness.code ?? 'File is unavailable.');
      window.location.assign(api.fileDownloadUrl(fileId));
    } catch (caught) { setError(caught); }
    finally { setPreparingDownloads(current => { const next = new Set(current); next.delete(fileId); return next; }); }
  };

  const refresh = React.useCallback(async (clearError = true) => {
    try {
      const [nextFiles, nextPendingHostCommits] = await Promise.all([
        api.listFiles(committeeId), canUpload ? api.listPendingHostCommits(committeeId) : Promise.resolve([])
      ]);
      setFiles(nextFiles); setPendingHostCommits(nextPendingHostCommits);
      if (canManage) {
        const [nextBindings, nextConfigs, nextMigrations, nextHosts, nextConflicts] = await Promise.all([
          api.listStorageBindings(committeeId), api.listS3ProviderConfigs(), api.listStorageMigrations(committeeId),
          api.listStorageHosts(committeeId), api.listStorageAgentConflicts(committeeId)
        ]);
        setBindings(nextBindings); setConfigs(nextConfigs); setMigrations(nextMigrations); setHosts(nextHosts);
        setConflicts(nextConflicts);
        setConflictNames(current => Object.fromEntries(nextConflicts.flatMap(item => item.change.kind === 'DELETE'
          ? [] : [[item.id, current[item.id] ?? item.change.logicalName]])));
        const active = nextBindings.find(binding => binding.status === 'ACTIVE');
        const availableS3 = nextConfigs.filter(config => config.status === 'ACTIVE'
          && config.id !== active?.providerConfigId);
        if (active?.providerType === 'SERVER_VOLUME') {
          setTargetType('S3_COMPATIBLE');
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
        setBindings([]); setConfigs([]); setMigrations([]); setHosts([]); setConflicts([]);
      }
      if (clearError) setError(undefined);
    } catch (caught) { setError(caught); }
  }, [api, canManage, canUpload, committeeId]);

  React.useEffect(() => { void refresh(); }, [refresh, snapshot.sync.committeeEventSequence]);
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
  const createPairing = async (purpose: 'INITIAL' | 'TRANSFER') => {
    setWorking(true); setError(undefined);
    try { setPairing(await api.createStoragePairingCode(committeeId, snapshot.committee.revision, purpose)); }
    catch (caught) { setError(caught); await refresh(false); }
    finally { setWorking(false); }
  };
  const resolveConflict = (item: StorageAgentConflict, action: StorageAgentConflictResolution) => {
    if (!activeHost) return Promise.reject(Object.assign(new Error(), {code: 'CHAIR_HOST_REQUIRED'}));
    const resolvedName = item.change.kind === 'DELETE' ? ''
      : conflictNames[item.id] ?? item.change.logicalName;
    return api.resolveStorageAgentConflict(committeeId, item.id, {baseRevision: item.revision,
      leaseGeneration: activeHost.leaseGeneration, fileRevision: item.serverRevision, action,
      ...((action === 'SAVE_AS_NEW' || (action === 'ACCEPT_LOCAL' && item.reasonCode === 'NAME_CONFLICT'))
        ? {logicalName: resolvedName} : {})}, newIdempotencyKey());
  };
  const targetOptions = [
    ...(!activeBinding || (activeBinding.providerType !== 'SERVER_VOLUME' && activeBinding.providerType !== 'CHAIR_AGENT')
      ? [{key: 'volume', value: 'SERVER_VOLUME', text: t("Server volume")}] : []),
    ...(!activeBinding && hosts.some(host => host.status === 'ACTIVE' || host.status === 'DEGRADED')
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

  return <div className="self-hosted-files">
    {error && <Message error role="alert" content={error} />}
    {section !== 'storage' && <>
    {pendingHostCommits.length > 0 && <Message info header={t("Waiting for the chair computer to save")}
      list={pendingHostCommits.map(item => item.logicalName)} />}
    {canUpload && <Segment loading={working && !progress}><Header as="h3">{t("Upload files")}</Header>
      <Form onSubmit={() => void upload()}><Form.Field>
        <div className="localized-file-picker"><input id="committee-upload-file" type="file"
          aria-label={t('Select a file to upload')} onChange={event => {const file = event.currentTarget.files?.[0];
            setSelectedFile(file); if (file) setLogicalName(file.name);}} />
          <label htmlFor="committee-upload-file" className="ui button">{t('Choose file')}</label>
          <span>{selectedFile?.name ?? t('No file chosen')}</span></div>
      </Form.Field>
      <Form.Input label={t("File name")} value={logicalName} onChange={event => setLogicalName(event.currentTarget.value)} />
      <Button primary disabled={working || !selectedFile || !logicalName.trim()}>{t("Upload files")}</Button>
      {progress && progress.phase !== 'COMMITTING'
        && <Button type="button" onClick={() => uploadController.current?.abort()}>{t("Cancel upload")}</Button>}
      </Form>
      {progress && <Progress percent={progressPercent} progress aria-label={progress.phase === 'HASHING' ? t("Verifying file")
        : progress.phase === 'UPLOADING' ? t("Uploading file") : t("Committing file")}>
        {progress.phase === 'HASHING' ? t("Verifying") : progress.phase === 'UPLOADING' ? t("Uploading") : t("Committing")}
      </Progress>}
    </Segment>}

    <Header as="h3">{t("File")}</Header>
    {files.length === 0 ? <Message content={t("No files")} /> : <Card.Group itemsPerRow={3} stackable>
      {files.map(file => {
        const ownsFile = currentUserId === file.createdByUserId;
        const canChange = !readOnly && (canManage || ownsFile);
        return <Card key={file.id} className="self-hosted-file-card"><Card.Content>
          <Card.Header>{file.logicalName}</Card.Header>
          <Card.Meta>{formatBytes(file.currentVersion.sizeBytes)} · <Label size="tiny">{t(FILE_STATUS[file.status])}</Label>
            {file.syncState !== 'SYNCED' && <> · <Label size="tiny" color="orange">
              {file.syncState === 'PENDING_HOST_COMMIT' ? t("Waiting for the chair computer to save") : t("Waiting for chair computer sync")}
            </Label></>}
          </Card.Meta>
          <Card.Description>{file.currentVersion.originalName}</Card.Description>
        </Card.Content><Card.Content extra className="self-hosted-file-actions">
          <Button as="a" size="small" href={api.fileDownloadUrl(file.id)} download
            loading={preparingDownloads.has(file.id)} disabled={preparingDownloads.has(file.id)}
            onClick={(event: React.MouseEvent) => {event.preventDefault(); void downloadFile(file.id);}}>
            {preparingDownloads.has(file.id) ? t("Preparing the file from the chair computer") : t("Download file")}</Button>
          {canChange && file.status === 'UPLOAD_COMPLETE' && <Button size="small"
            onClick={() => void run(() => api.submitFileForReview(file.id, file.revision))}>{t("Submit for review")}</Button>}
          {canManage && file.status === 'PENDING_REVIEW' && <Button primary size="small"
            onClick={() => void run(() => api.publishFile(file.id, file.revision))}>{t("Publish file")}</Button>}
          {canChange && <Button negative size="small" onClick={() => {
            if (window.confirm(t('Permanently delete “{name}”? The file will become unavailable and cannot be recovered.', {name: file.logicalName}))) {
              void run(() => api.deleteFile(file.id, file.revision));
            }
          }}>{t("Delete permanently")}</Button>}
        </Card.Content></Card>;
      })}
    </Card.Group>}</>}

    {section !== 'attachments' && canManage && <Segment loading={working && !progress} className="self-hosted-storage-panel">
      <Header as="h3">{t("File storage")}</Header>
      <Header as="h4">{t("Chair computer")}</Header>
      {activeHost ? <p>{activeHost.deviceLabel} · {t(HOST_STATUS[activeHost.status])}
        {activeHost.lastSeenAt ? ` · ${new Date(activeHost.lastSeenAt).toLocaleString(getLanguage())}` : ''}</p>
        : <p>{t("Not paired")}</p>}
      {pairing && <Message info><Message.Header>{t("Pairing code")}</Message.Header>
        <code className="self-hosted-pairing-code">{pairing.code}</code>
        <span className="self-hosted-pairing-code-meta">

          {t("· Expires at")} {new Date(pairing.expiresAt).toLocaleTimeString(getLanguage())}
        </span>
        <span className="self-hosted-pairing-code-actions">
          <Button type="button" size="small" onClick={() => void navigator.clipboard?.writeText(pairing.code)}>

            {t("Copy pairing code")}
          </Button>
        </span>
      </Message>}
      {!pairing && <Button type="button" size="small" disabled={working}
        onClick={() => void createPairing(activeHost ? 'TRANSFER' : 'INITIAL')}>
        {activeHost ? t("Transfer to another computer") : t("Pair chair computer")}
      </Button>}
      {pairing && <Button type="button" size="small" onClick={() => setPairing(undefined)}>{t("Close pairing code")}</Button>}
      {activeHost && <Button type="button" negative size="small" disabled={working} onClick={() => {
        if (window.confirm(t('Revoke “{name}”?', {name: activeHost.deviceLabel}))) {
          void run(() => api.revokeStorageHost(committeeId, activeHost.id, snapshot.committee.revision));
        }
      }}>{t("Revoke chair computer")}</Button>}
      {conflicts.some(item => item.status === 'PENDING') && <div className="self-hosted-storage-conflicts">
        <Header as="h4">{t("Sync conflicts")}</Header>
        {conflicts.filter(item => item.status === 'PENDING').map(item => <Card key={item.id} fluid>
          <Card.Content><Card.Header>{item.change.kind === 'DELETE' ? t("Local deletion") : item.change.logicalName}</Card.Header>
            <Card.Meta>{t(CONFLICT_REASON[item.reasonCode])}</Card.Meta>
            {(item.change.kind === 'UPSERT' || item.reasonCode === 'NAME_CONFLICT')
              && item.change.kind !== 'DELETE' && <Form.Input label={item.reasonCode === 'NAME_CONFLICT'
                ? t("New file name") : t("Save as name")} aria-label={item.reasonCode === 'NAME_CONFLICT' ? t("New file name") : t("Save as name")}
              value={conflictNames[item.id] ?? item.change.logicalName}
              onChange={event => { const value = event.currentTarget.value;
                setConflictNames(current => ({...current, [item.id]: value})); }} />}
          </Card.Content><Card.Content extra>
            <Button size="small" onClick={() => void run(() => resolveConflict(item, 'KEEP_SERVER'))}>

              {t("Keep server version")}
            </Button>
            {!['FILE_DELETED', 'HOST_TRANSFERRED'].includes(item.reasonCode) && <Button primary size="small"
              disabled={item.reasonCode === 'NAME_CONFLICT' && !conflictNames[item.id]?.trim()}
              onClick={() => void run(() => resolveConflict(item, 'ACCEPT_LOCAL'))}>{t("Use local version")}</Button>}
            {item.change.kind === 'UPSERT' && item.reasonCode !== 'HOST_TRANSFERRED' && <Button size="small"
              disabled={!conflictNames[item.id]?.trim()}
              onClick={() => void run(() => resolveConflict(item, 'SAVE_AS_NEW'))}>{t("Save as a new file")}</Button>}
          </Card.Content></Card>)}
      </div>}
      {activeBinding && <p>{t("Current:")}{activeBinding.providerType === 'SERVER_VOLUME' ? t("Server volume")
        : activeBinding.providerType === 'CHAIR_AGENT' ? t("Chair computer")
          : `S3 · ${configs.find(config => config.id === activeBinding.providerConfigId)?.displayName ?? t("Configured storage")}`}</p>}
      <Form onSubmit={activeBinding ? createMigration : initializeStorage}>
        <Form.Select label={activeBinding ? t("Migrate to") : t("Initial storage")} options={targetOptions}
          value={targetType === 'S3_COMPATIBLE' ? `S3:${targetConfigId}` : targetType}
          onChange={(_, data) => setTarget(String(data.value))} />
        <Button primary disabled={working || targetOptions.length === 0
          || (targetType === 'S3_COMPATIBLE' && !targetConfigId)}>
          {activeBinding ? t("Start migration") : t("Enable storage")}
        </Button>
      </Form>
      {migrations.length > 0 && <Card.Group stackable className="self-hosted-migrations">{migrations.map(migration =>
        <Card key={migration.id}><Card.Content><Card.Header>{t(MIGRATION_STATUS[migration.status])}</Card.Header>
          <Card.Meta>{migration.completedItems}/{migration.totalItems}</Card.Meta>
          {migration.failureCode && <Card.Description>{migrationFailureText(migration.failureCode)}</Card.Description>}
        </Card.Content><Card.Content extra>
          {migration.status === 'FAILED' && <Button size="small"
            onClick={() => void run(() => api.retryStorageMigration(migration.id, migration.revision))}>{t("Retry migration")}</Button>}
          {migration.status === 'READY_TO_CONFIRM' && <Button primary size="small"
            onClick={() => void run(() => api.confirmStorageMigration(migration.id, migration.revision))}>{t("Confirm switch")}</Button>}
          {!['COMPLETED', 'CANCELLED'].includes(migration.status) && <Button size="small"
            onClick={() => { if (window.confirm(t("Cancel this storage migration?"))) {
              void run(() => api.cancelStorageMigration(migration.id, migration.revision));
            } }}>{t("Cancel migration")}</Button>}
        </Card.Content></Card>)}</Card.Group>}
    </Segment>}
  </div>;
}

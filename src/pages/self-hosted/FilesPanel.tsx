import * as React from 'react';
import type {CommitteeWorkspaceSnapshot, FileEntry, FileUpload, StorageMigration,
  StoragePairingCode, StorageProviderType} from '@quorum/contracts';
import {Button, Card, Form, Header, Label, Message, Progress, Segment} from 'semantic-ui-react';
import {SelfHostedApiError, newIdempotencyKey, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';

const FILE_STATUS: Record<FileEntry['status'], string> = {
  UPLOAD_COMPLETE: '上传完成', PENDING_REVIEW: '待审核', PUBLISHED: '已发布', DELETED: '已删除'
};
const MIGRATION_STATUS: Record<StorageMigration['status'], string> = {
  COPYING: '正在复制', READY_TO_CONFIRM: '等待确认', FAILED: '迁移失败', COMPLETED: '迁移完成', CANCELLED: '已取消'
};
const HOST_STATUS = {ACTIVE: '在线', DEGRADED: '离线', REVOKED: '已撤销'} as const;

function migrationFailureText(code: string): string {
  if (code === 'MANIFEST_CHANGED') return '文件列表已变更，请重试迁移。';
  return '复制失败，请检查存储服务后重试。';
}

export function storageErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '已取消上传。';
  if (!(error instanceof SelfHostedApiError)) return error instanceof Error ? error.message : String(error);
  const messages: Partial<Record<string, string>> = {
    PAYLOAD_TOO_LARGE: '文件过大，请选择较小的文件。',
    REVISION_CONFLICT: '状态已更新，请重新操作。',
    IDEMPOTENCY_CONFLICT: '请求内容已变更，请重新操作。',
    RESOURCE_CONFLICT: '当前状态不允许此操作。',
    SERVICE_NOT_READY: '存储暂不可用，请检查容量和存储服务后重试。',
    FORBIDDEN: '你没有权限执行此操作。',
    AUTHENTICATION_REQUIRED: '登录已失效，请重新登录。',
    LINK_EXPIRED: '配对码已失效，请重新生成。',
    VALIDATION_FAILED: '文件信息无效，请重新选择文件。'
  };
  return messages[error.code] ?? error.message;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

type UploadProgress = {phase: 'HASHING' | 'UPLOADING' | 'COMMITTING'; processed: number; total: number};

export default function FilesPanel({snapshot, api, currentUserId}: {
  snapshot: CommitteeWorkspaceSnapshot;
  api: SelfHostedApi;
  currentUserId?: string;
}) {
  const committeeId = snapshot.committee.id;
  const canManage = snapshot.viewer.audience === 'CHAIR' || snapshot.viewer.audience === 'OWNER';
  const canUpload = snapshot.viewer.audience !== 'PUBLIC';
  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [pendingHostCommits, setPendingHostCommits] = React.useState<FileUpload[]>([]);
  const [bindings, setBindings] = React.useState<Awaited<ReturnType<SelfHostedApi['listStorageBindings']>>>([]);
  const [configs, setConfigs] = React.useState<Awaited<ReturnType<SelfHostedApi['listS3ProviderConfigs']>>>([]);
  const [migrations, setMigrations] = React.useState<StorageMigration[]>([]);
  const [hosts, setHosts] = React.useState<Awaited<ReturnType<SelfHostedApi['listStorageHosts']>>>([]);
  const [pairing, setPairing] = React.useState<StoragePairingCode>();
  const [selectedFile, setSelectedFile] = React.useState<File>();
  const [logicalName, setLogicalName] = React.useState('');
  const [targetType, setTargetType] = React.useState<StorageProviderType>('SERVER_VOLUME');
  const [targetConfigId, setTargetConfigId] = React.useState('');
  const [error, setError] = React.useState<string>();
  const [working, setWorking] = React.useState(false);
  const [progress, setProgress] = React.useState<UploadProgress>();
  const uploadController = React.useRef<AbortController>();

  const refresh = React.useCallback(async (clearError = true) => {
    try {
      const [nextFiles, nextPendingHostCommits] = await Promise.all([
        api.listFiles(committeeId), canUpload ? api.listPendingHostCommits(committeeId) : Promise.resolve([])
      ]);
      setFiles(nextFiles); setPendingHostCommits(nextPendingHostCommits);
      if (canManage) {
        const [nextBindings, nextConfigs, nextMigrations, nextHosts] = await Promise.all([
          api.listStorageBindings(committeeId), api.listS3ProviderConfigs(), api.listStorageMigrations(committeeId),
          api.listStorageHosts(committeeId)
        ]);
        setBindings(nextBindings); setConfigs(nextConfigs); setMigrations(nextMigrations); setHosts(nextHosts);
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
        setBindings([]); setConfigs([]); setMigrations([]); setHosts([]);
      }
      if (clearError) setError(undefined);
    } catch (caught) { setError(storageErrorText(caught)); }
  }, [api, canManage, canUpload, committeeId]);

  React.useEffect(() => { void refresh(); }, [refresh, snapshot.sync.committeeEventSequence]);
  React.useEffect(() => () => uploadController.current?.abort(), []);

  const run = React.useCallback(async (operation: () => Promise<unknown>) => {
    setWorking(true); setError(undefined);
    let failed = false;
    try { await operation(); }
    catch (caught) { failed = true; setError(storageErrorText(caught)); }
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
      setError(storageErrorText(caught));
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
    catch (caught) { setError(storageErrorText(caught)); await refresh(false); }
    finally { setWorking(false); }
  };
  const targetOptions = [
    ...(!activeBinding || (activeBinding.providerType !== 'SERVER_VOLUME' && activeBinding.providerType !== 'CHAIR_AGENT')
      ? [{key: 'volume', value: 'SERVER_VOLUME', text: '服务器卷'}] : []),
    ...(!activeBinding && hosts.some(host => host.status === 'ACTIVE' || host.status === 'DEGRADED')
      ? [{key: 'chair-agent', value: 'CHAIR_AGENT', text: '主席电脑'}] : []),
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
    {pendingHostCommits.length > 0 && <Message info header="等待主席电脑保存"
      list={pendingHostCommits.map(item => item.logicalName)} />}
    {canUpload && <Segment loading={working && !progress}><Header as="h3">上传文件</Header>
      <Form onSubmit={() => void upload()}><Form.Input type="file" label="选择文件" input={{
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.currentTarget.files?.[0];
          setSelectedFile(file); if (file) setLogicalName(file.name); }, 'aria-label': '选择上传文件'
      }} />
      <Form.Input label="文件名称" value={logicalName} onChange={event => setLogicalName(event.currentTarget.value)} />
      <Button primary disabled={working || !selectedFile || !logicalName.trim()}>上传文件</Button>
      {progress && progress.phase !== 'COMMITTING'
        && <Button type="button" onClick={() => uploadController.current?.abort()}>取消上传</Button>}
      </Form>
      {progress && <Progress percent={progressPercent} progress aria-label={progress.phase === 'HASHING' ? '正在校验文件'
        : progress.phase === 'UPLOADING' ? '正在上传文件' : '正在提交文件'}>
        {progress.phase === 'HASHING' ? '正在校验' : progress.phase === 'UPLOADING' ? '正在上传' : '正在提交'}
      </Progress>}
    </Segment>}

    <Header as="h3">文件</Header>
    {files.length === 0 ? <Message content="暂无文件" /> : <Card.Group itemsPerRow={3} stackable>
      {files.map(file => {
        const ownsFile = currentUserId === file.createdByUserId;
        const canChange = canManage || ownsFile;
        return <Card key={file.id} className="self-hosted-file-card"><Card.Content>
          <Card.Header>{file.logicalName}</Card.Header>
          <Card.Meta>{formatBytes(file.currentVersion.sizeBytes)} · <Label size="tiny">{FILE_STATUS[file.status]}</Label>
            {file.syncState !== 'SYNCED' && <> · <Label size="tiny" color="orange">
              {file.syncState === 'PENDING_HOST_COMMIT' ? '等待主席电脑保存' : '等待主席电脑同步'}
            </Label></>}
          </Card.Meta>
          <Card.Description>{file.currentVersion.originalName}</Card.Description>
        </Card.Content><Card.Content extra className="self-hosted-file-actions">
          <Button as="a" size="small" href={api.fileDownloadUrl(file.id)} download>下载文件</Button>
          {canChange && file.status === 'UPLOAD_COMPLETE' && <Button size="small"
            onClick={() => void run(() => api.submitFileForReview(file.id, file.revision))}>提交审核</Button>}
          {canManage && file.status === 'PENDING_REVIEW' && <Button primary size="small"
            onClick={() => void run(() => api.publishFile(file.id, file.revision))}>发布文件</Button>}
          {canChange && <Button negative size="small" onClick={() => {
            if (window.confirm(`永久删除“${file.logicalName}”？文件将立即不可下载，且无法恢复。`)) {
              void run(() => api.deleteFile(file.id, file.revision));
            }
          }}>永久删除</Button>}
        </Card.Content></Card>;
      })}
    </Card.Group>}

    {canManage && <Segment loading={working && !progress} className="self-hosted-storage-panel">
      <Header as="h3">文件存储</Header>
      <Header as="h4">主席电脑</Header>
      {activeHost ? <p>{activeHost.deviceLabel} · {HOST_STATUS[activeHost.status]}
        {activeHost.lastSeenAt ? ` · ${new Date(activeHost.lastSeenAt).toLocaleString('zh-CN')}` : ''}</p>
        : <p>未配对</p>}
      {pairing && <Message info><Message.Header>配对码</Message.Header>
        <code className="self-hosted-pairing-code">{pairing.code}</code>
        <span> · 有效至 {new Date(pairing.expiresAt).toLocaleTimeString('zh-CN')}</span>
        <Button type="button" size="small" onClick={() => void navigator.clipboard?.writeText(pairing.code)}>
          复制配对码
        </Button>
      </Message>}
      {!pairing && <Button type="button" size="small" disabled={working}
        onClick={() => void createPairing(activeHost ? 'TRANSFER' : 'INITIAL')}>
        {activeHost ? '转移到其他电脑' : '配对主席电脑'}
      </Button>}
      {pairing && <Button type="button" size="small" onClick={() => setPairing(undefined)}>关闭配对码</Button>}
      {activeHost && <Button type="button" negative size="small" disabled={working} onClick={() => {
        if (window.confirm(`撤销“${activeHost.deviceLabel}”？`)) {
          void run(() => api.revokeStorageHost(committeeId, activeHost.id, snapshot.committee.revision));
        }
      }}>撤销主席电脑</Button>}
      {activeBinding && <p>当前：{activeBinding.providerType === 'SERVER_VOLUME' ? '服务器卷'
        : activeBinding.providerType === 'CHAIR_AGENT' ? '主席电脑'
          : `S3 · ${configs.find(config => config.id === activeBinding.providerConfigId)?.displayName ?? '已配置存储'}`}</p>}
      <Form onSubmit={activeBinding ? createMigration : initializeStorage}>
        <Form.Select label={activeBinding ? '迁移到' : '初始存储'} options={targetOptions}
          value={targetType === 'S3_COMPATIBLE' ? `S3:${targetConfigId}` : targetType}
          onChange={(_, data) => setTarget(String(data.value))} />
        <Button primary disabled={working || targetOptions.length === 0
          || (targetType === 'S3_COMPATIBLE' && !targetConfigId)}>
          {activeBinding ? '开始迁移' : '启用存储'}
        </Button>
      </Form>
      {migrations.length > 0 && <Card.Group stackable className="self-hosted-migrations">{migrations.map(migration =>
        <Card key={migration.id}><Card.Content><Card.Header>{MIGRATION_STATUS[migration.status]}</Card.Header>
          <Card.Meta>{migration.completedItems}/{migration.totalItems}</Card.Meta>
          {migration.failureCode && <Card.Description>{migrationFailureText(migration.failureCode)}</Card.Description>}
        </Card.Content><Card.Content extra>
          {migration.status === 'FAILED' && <Button size="small"
            onClick={() => void run(() => api.retryStorageMigration(migration.id, migration.revision))}>重试迁移</Button>}
          {migration.status === 'READY_TO_CONFIRM' && <Button primary size="small"
            onClick={() => void run(() => api.confirmStorageMigration(migration.id, migration.revision))}>确认切换</Button>}
          {!['COMPLETED', 'CANCELLED'].includes(migration.status) && <Button size="small"
            onClick={() => { if (window.confirm('取消此次存储迁移？')) {
              void run(() => api.cancelStorageMigration(migration.id, migration.revision));
            } }}>取消迁移</Button>}
        </Card.Content></Card>)}</Card.Group>}
    </Segment>}
  </div>;
}

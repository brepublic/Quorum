import * as React from 'react';
import {isAllowedDelegateFile} from '@quorum/contracts';
import type {DelegateFileAvailableEvent, DelegateFileType, DelegatePortalBootstrap,
  DelegatePublishedFile} from '@quorum/contracts';
import {Button, Card, Container, Divider, Form, Icon, Menu, Message, Modal, Progress, Table} from 'semantic-ui-react';
import {SelfHostedApiError, selfHostedApi, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';
import {CountryFlagDisplay} from '../../components/CountryFlagDisplay';

const FILE_TYPES: Array<{key: DelegateFileType; value: DelegateFileType; text: string}> = [
  {key: 'WORKING_PAPER', value: 'WORKING_PAPER', text: '工作文件'},
  {key: 'DIRECTIVE_DRAFT', value: 'DIRECTIVE_DRAFT', text: '指令草案'},
  {key: 'RESOLUTION_DRAFT', value: 'RESOLUTION_DRAFT', text: '决议草案'}
];
const FILE_TYPE_LABEL = Object.fromEntries(FILE_TYPES.map(item => [item.value, item.text])) as Record<DelegateFileType, string>;

function dateTime(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '—'; }
function portalError(error: unknown): string {
  if (!(error instanceof SelfHostedApiError)) return error instanceof Error ? error.message : String(error);
  if (error.code === 'VALIDATION_FAILED' && error.details && typeof error.details === 'object' && 'allowedExtensions' in error.details) return error.message;
  return ({LINK_EXPIRED: '分享链接已失效。', RESOURCE_CONFLICT: '当前状态不允许此操作。',
    AUTHENTICATION_REQUIRED: '代表身份已失效，请重新打开分享链接。', FORBIDDEN: '当前代表团不可上传文件。',
    PAYLOAD_TOO_LARGE: '文件过大，请选择较小的文件。', SERVICE_NOT_READY: '主席端故障。',
    VALIDATION_FAILED: '文件信息无效。'} as Record<string, string>)[error.code] ?? error.message;
}
function fileSizeMiB(bytes: number | null | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const limit = value / 1024 / 1024;
  return Number.isInteger(limit) ? `${limit}` : limit.toFixed(1);
}

function PublishedCard({file, preparing, onDownload}: {
  file: DelegatePublishedFile; preparing: boolean; onDownload(id: string): void;
}) {
  return <Card fluid className="delegate-file-card motion-card"><Card.Content>
    <div className="motion-heading delegate-file-heading"><Card.Header>{file.logicalName}</Card.Header>
      <span className="motion-decision motion-decision-passed">已批准</span></div>
    <Card.Meta><Table compact celled className="motion-metadata-table delegate-file-metadata"><Table.Body>
      <Table.Row><Table.Cell className="motion-metadata-key">提交国</Table.Cell><Table.Cell>{file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">文件类型</Table.Cell><Table.Cell>{file.fileType ? FILE_TYPE_LABEL[file.fileType] : '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">提交时间</Table.Cell><Table.Cell>{dateTime(file.submittedAt)}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">审核时间</Table.Cell><Table.Cell>{dateTime(file.publishedAt)}</Table.Cell></Table.Row>
    </Table.Body></Table></Card.Meta>
  </Card.Content><Card.Content extra><Button as="a" primary fluid download
    href={`/api/v1/delegate-files/files/${encodeURIComponent(file.id)}/download`}
    loading={preparing} disabled={preparing}
    onClick={(event: React.MouseEvent) => {event.preventDefault(); onDownload(file.id);}}>
    {preparing ? '正在从主席电脑准备文件' : <>下载 <Icon name="arrow down" /></>}
  </Button></Card.Content></Card>;
}

export default function DelegateFilePortal({api = selfHostedApi}: {api?: SelfHostedApi}) {
  const capability = window.location.hash.replace(/^#/, '');
  const [portal, setPortal] = React.useState<DelegatePortalBootstrap>();
  const [active, setActive] = React.useState<'files' | 'upload'>('files');
  const [seatId, setSeatId] = React.useState(''); const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string>(); const [working, setWorking] = React.useState(false);
  const [connection, setConnection] = React.useState<'LIVE' | 'OFFLINE'>('OFFLINE');
  const [notices, setNotices] = React.useState<Array<DelegateFileAvailableEvent & {expiresAt: number}>>([]);
  const [file, setFile] = React.useState<File>(); const [fileType, setFileType] = React.useState<DelegateFileType>('WORKING_PAPER');
  const [progress, setProgress] = React.useState<number>(); const [submitted, setSubmitted] = React.useState(false);
  const [preparingDownload, setPreparingDownload] = React.useState<string>();

  const load = React.useCallback(async () => {
    if (!capability) { setError('分享链接无效。'); return; }
    try { setPortal(await api.bootstrapDelegatePortal(capability)); setError(undefined); }
    catch (caught) { setError(portalError(caught)); }
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
      const value = JSON.parse(event.data) as {chairHostHealthy: boolean};
      setPortal(current => current ? {...current, chairHostHealthy: value.chairHostHealthy} : current);
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
    catch (caught) { setError(portalError(caught)); }
    finally { setWorking(false); }
  };
  const uploadSizeError = file && portal && Number.isFinite(portal.maxUploadSizeBytes)
    && portal.maxUploadSizeBytes > 0 && file.size > portal.maxUploadSizeBytes
    ? `文件大小超出上限，请选择不超过 ${fileSizeMiB(portal.maxUploadSizeBytes)} MiB 的文件。` : undefined;
  const upload = async () => {
    if (!file || uploadSizeError) return;
    const extensions = portal?.allowedExtensions?.[fileType];
    if (extensions && !isAllowedDelegateFile(file.name, extensions)) {setError(`允许的文件格式：${extensions.map(ext => '.' + ext).join('、')}`); return;}
    setWorking(true); setSubmitted(false); setError(undefined); setProgress(0);
    try {
      const sha256 = await sha256File(file, {onProgress: (done, total) => setProgress(total ? done / total * 20 : 0)});
      const created = await api.createDelegateFileUpload({logicalName: file.name, originalName: file.name,
        mediaType: file.type || 'application/octet-stream', expectedSizeBytes: file.size, sha256, fileType});
      await api.uploadDelegateFileContent(created.id, file, (done, total) => setProgress(20 + (total ? done / total * 75 : 0)));
      setProgress(98); await api.commitDelegateFileUpload(created.id); setProgress(100); setSubmitted(true); setFile(undefined); await refreshFiles();
    } catch (caught) { setProgress(undefined); setError(portalError(caught)); }
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
      if (readiness.status !== 'READY') throw new Error(readiness.code ?? 'File is unavailable.');
      window.location.assign(api.delegateFileDownloadUrl(id));
    } catch (caught) { setError(portalError(caught)); }
    finally { setPreparingDownload(undefined); }
  };

  if (!portal) return <Container className="delegate-file-portal">{error
    ? <Message error content={error} /> : <Message content="正在载入…" />}</Container>;
  if (!portal.claimedSeat) return <Container className="delegate-file-claim-page">
    {error && <Message error content={error} />}
    <Card centered className="delegate-file-claim-card"><Card.Content><Card.Header>选择代表团</Card.Header>
      <Form><Form.Select fluid selection search placeholder="请选择代表团" value={seatId}
        options={portal.eligibleSeats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName,
          content: <span className="motion-seat-option"><CountryFlagDisplay flag={seat.flag} /><span>{seat.displayName}</span></span>}))}
        onChange={(_, data) => setSeatId(String(data.value))} /></Form>
    </Card.Content><Card.Content extra><Button primary fluid disabled={!seatId} onClick={() => setConfirming(true)}>确认</Button></Card.Content></Card>
    <Modal size="tiny" open={confirming} onClose={() => setConfirming(false)}><Modal.Header>确认代表团</Modal.Header>
      <Modal.Content>确认后不可更改代表团身份。</Modal.Content><Modal.Actions>
        <Button onClick={() => setConfirming(false)}>取消</Button><Button primary loading={working} onClick={() => void claim()}>确认</Button>
      </Modal.Actions></Modal>
  </Container>;

  const isLive = portal.chairHostHealthy && connection === 'LIVE';
  const status = isLive ? '实时' : !portal.chairHostHealthy ? '主席端故障' : '离线';
  const maxUploadSizeMiB = fileSizeMiB(portal.maxUploadSizeBytes);
  return <div className="delegate-file-portal">
    <Menu className="delegate-file-menu"><Menu.Item header className="delegate-file-committee-name">{portal.committeeName}</Menu.Item>
      <Menu.Item active={active === 'files'} onClick={() => setActive('files')}>已发布文件</Menu.Item>
      <Menu.Item active={active === 'upload'} onClick={() => setActive('upload')}>上传文件</Menu.Item>
      <Menu.Menu position="right"><Menu.Item className={isLive ? 'realtime-status-live' : undefined}>
        {isLive && <Icon name="check circle" />} {status}
      </Menu.Item><Menu.Item className="delegate-file-seat">{portal.claimedSeat.flag && <CountryFlagDisplay flag={portal.claimedSeat.flag} />}<span>{portal.claimedSeat.displayName}</span></Menu.Item></Menu.Menu>
    </Menu>
    <Container>
      {notices.map(item => <Message info={item.kind !== 'rejected'} negative={item.kind === 'rejected'} key={item.fileId} onDismiss={() => setNotices(current =>
        current.filter(candidate => candidate.fileId !== item.fileId))}
        content={item.kind === 'rejected' ? <><strong>{item.submitterDisplayName}</strong> 提交的 <strong>{item.logicalName}</strong> 被主席驳回。{item.rejectionReason && <div>{item.rejectionReason}</div>}</> : <><strong>{item.submitterDisplayName}</strong> 代表提交的 <strong>{item.logicalName}</strong> 现已可用。</>} />)}
      {error && <Message error content={error} />}
      {active === 'files' && <div className="delegate-file-card-list">{portal.files.length
        ? portal.files.map(item => <PublishedCard key={item.id} file={item} preparing={preparingDownload === item.id}
          onDownload={id => void download(id)} />)
        : <Message content="暂无已发布文件" />}</div>}
        {active === 'upload' && <><Card centered fluid className="delegate-file-upload-card"><Card.Content>
        <Form onSubmit={() => void upload()}>
        <Form.Select label="文件类型" options={FILE_TYPES} value={fileType} disabled={working}
          onChange={(_, data) => {setFileType(data.value as DelegateFileType); setError(undefined);}} />
        <Form.Field>
          <label>选择文件</label>
          {maxUploadSizeMiB === '—'
            ? null
            : <small className="ui tiny text delegate-file-upload-limit-note">文件大小上限为 {maxUploadSizeMiB} MiB</small>}
          <input type="file" disabled={working} accept={portal.allowedExtensions?.[fileType].map(ext => `.${ext}`).join(',')} onChange={(event: React.ChangeEvent<HTMLInputElement>) => {setFile(event.currentTarget.files?.[0]);
            setSubmitted(false); setProgress(undefined);}} aria-label="选择文件" />
        </Form.Field>
        {uploadSizeError && <Message negative role="alert" content={uploadSizeError} />}
        {portal.allowedExtensions && <p className="delegate-file-allowed-formats">允许的格式：{portal.allowedExtensions[fileType].join('、')}</p>}
        {!submitted && progress === undefined && <Button primary fluid disabled={!file || working || !portal.mayUpload || Boolean(uploadSizeError)}>
          提交 <Icon name="arrow up" /></Button>}
        {progress !== undefined && !submitted && <Progress percent={Math.round(progress)} progress color="blue" />}
        {submitted && <div className="delegate-file-upload-success">✔提交成功，等待审核</div>}
        </Form>
      </Card.Content></Card>
      <Divider className="delegate-file-review-divider" />
      <div className="delegate-file-card-list">{portal.submissions?.length ? portal.submissions.map(item =>
        <Card fluid key={item.id} className="delegate-file-card motion-card"><Card.Content>
          <div className="motion-heading delegate-file-heading"><Card.Header>{item.logicalName}</Card.Header>
            <span className={`motion-decision ${item.status === 'PUBLISHED' ? 'motion-decision-passed' : item.status === 'REJECTED' ? 'motion-decision-failed' : ''}`}>
              {({UPLOAD_COMPLETE:'等待保存',PENDING_REVIEW:'待审核',PUBLISHED:'已批准',REJECTED:'已驳回',DELETED:'已删除'})[item.status]}</span></div>
          <Card.Meta><Table compact celled className="motion-metadata-table delegate-file-metadata"><Table.Body>
            <Table.Row><Table.Cell className="motion-metadata-key">提交国</Table.Cell><Table.Cell>{item.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">文件类型</Table.Cell><Table.Cell>{item.fileType ? FILE_TYPE_LABEL[item.fileType] : '—'}</Table.Cell></Table.Row>
            <Table.Row><Table.Cell className="motion-metadata-key">提交时间</Table.Cell><Table.Cell>{dateTime(item.submittedAt)}</Table.Cell></Table.Row>
            {item.reviewedAt && <Table.Row><Table.Cell className="motion-metadata-key">审核时间</Table.Cell><Table.Cell>{dateTime(item.reviewedAt)}</Table.Cell></Table.Row>}
            <Table.Row><Table.Cell className="motion-metadata-key">原始文件</Table.Cell><Table.Cell>{item.originalName}</Table.Cell></Table.Row>
            {item.rejectionReason && <Table.Row><Table.Cell className="motion-metadata-key">驳回理由</Table.Cell><Table.Cell>{item.rejectionReason}</Table.Cell></Table.Row>}
          </Table.Body></Table></Card.Meta>
        </Card.Content></Card>) : <Message content="暂无上传记录" />}</div></>}
    </Container>
  </div>;
}

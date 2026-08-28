import * as React from 'react';
import type {DelegateFileAvailableEvent, DelegateFileType, DelegatePortalBootstrap,
  DelegatePublishedFile} from '@quorum/contracts';
import {Button, Card, Container, Form, Icon, Menu, Message, Modal, Progress, Table} from 'semantic-ui-react';
import {SelfHostedApiError, selfHostedApi, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';

const FILE_TYPES: Array<{key: DelegateFileType; value: DelegateFileType; text: string}> = [
  {key: 'WORKING_PAPER', value: 'WORKING_PAPER', text: '工作文件'},
  {key: 'DIRECTIVE_DRAFT', value: 'DIRECTIVE_DRAFT', text: '指令草案'},
  {key: 'RESOLUTION_DRAFT', value: 'RESOLUTION_DRAFT', text: '决议草案'}
];
const FILE_TYPE_LABEL = Object.fromEntries(FILE_TYPES.map(item => [item.value, item.text])) as Record<DelegateFileType, string>;

function dateTime(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '—'; }
function portalError(error: unknown): string {
  if (!(error instanceof SelfHostedApiError)) return error instanceof Error ? error.message : String(error);
  return ({LINK_EXPIRED: '分享链接已失效。', RESOURCE_CONFLICT: '当前状态不允许此操作。',
    AUTHENTICATION_REQUIRED: '代表身份已失效，请重新打开分享链接。', FORBIDDEN: '当前代表团不可上传文件。',
    PAYLOAD_TOO_LARGE: '文件过大，请选择较小的文件。', SERVICE_NOT_READY: '主席端故障。',
    VALIDATION_FAILED: '文件信息无效。'} as Record<string, string>)[error.code] ?? error.message;
}

function PublishedCard({file, onDownload}: {file: DelegatePublishedFile; onDownload(id: string): void}) {
  return <Card fluid className="delegate-file-card"><Card.Content><Card.Header>{file.logicalName}</Card.Header>
    <Table compact celled className="delegate-file-metadata"><Table.Body>
      <Table.Row><Table.Cell>提交国</Table.Cell><Table.Cell>{file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell>文件类型</Table.Cell><Table.Cell>{file.fileType ? FILE_TYPE_LABEL[file.fileType] : '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell>提交时间</Table.Cell><Table.Cell>{dateTime(file.submittedAt)}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell>公布时间</Table.Cell><Table.Cell>{dateTime(file.publishedAt)}</Table.Cell></Table.Row>
    </Table.Body></Table>
  </Card.Content><Card.Content extra><Button as="a" primary fluid download
    href={`/api/v1/delegate-files/files/${encodeURIComponent(file.id)}/download`}
    onClick={() => onDownload(file.id)}>下载 <Icon name="arrow down" /></Button></Card.Content></Card>;
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

  const load = React.useCallback(async () => {
    if (!capability) { setError('分享链接无效。'); return; }
    try { setPortal(await api.bootstrapDelegatePortal(capability)); setError(undefined); }
    catch (caught) { setError(portalError(caught)); }
  }, [api, capability]);
  React.useEffect(() => { void load(); }, [load]);

  const refreshFiles = React.useCallback(async () => {
    try { const files = await api.listDelegatePublishedFiles(); setPortal(current => current ? {...current, files} : current); }
    catch { /* The stream state communicates loss of service. */ }
  }, [api]);

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
    stream.addEventListener('portal.status', status as EventListener);
    return () => stream.close();
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
  const upload = async () => {
    if (!file) return; setWorking(true); setSubmitted(false); setError(undefined); setProgress(0);
    try {
      const sha256 = await sha256File(file, {onProgress: (done, total) => setProgress(total ? done / total * 20 : 0)});
      const created = await api.createDelegateFileUpload({logicalName: file.name, originalName: file.name,
        mediaType: file.type || 'application/octet-stream', expectedSizeBytes: file.size, sha256, fileType});
      await api.uploadDelegateFileContent(created.id, file, (done, total) => setProgress(20 + (total ? done / total * 75 : 0)));
      setProgress(98); await api.commitDelegateFileUpload(created.id); setProgress(100); setSubmitted(true); setFile(undefined);
    } catch (caught) { setProgress(undefined); setError(portalError(caught)); }
    finally { setWorking(false); }
  };
  const dismissForDownload = (id: string) => setNotices(current => current.filter(item => item.fileId !== id));

  if (!portal) return <Container className="delegate-file-portal">{error
    ? <Message error content={error} /> : <Message content="正在载入…" />}</Container>;
  if (!portal.claimedSeat) return <Container className="delegate-file-claim-page">
    {error && <Message error content={error} />}
    <Card centered className="delegate-file-claim-card"><Card.Content><Card.Header>选择代表团</Card.Header>
      <Form><Form.Select fluid selection search placeholder="请选择代表团" value={seatId}
        options={portal.eligibleSeats.map(seat => ({key: seat.id, value: seat.id, text: seat.displayName}))}
        onChange={(_, data) => setSeatId(String(data.value))} /></Form>
    </Card.Content><Card.Content extra><Button primary fluid disabled={!seatId} onClick={() => setConfirming(true)}>确认</Button></Card.Content></Card>
    <Modal size="tiny" open={confirming} onClose={() => setConfirming(false)}><Modal.Header>确认代表团</Modal.Header>
      <Modal.Content>确认后不可更改代表团身份。</Modal.Content><Modal.Actions>
        <Button onClick={() => setConfirming(false)}>取消</Button><Button primary loading={working} onClick={() => void claim()}>确认</Button>
      </Modal.Actions></Modal>
  </Container>;

  const status = !portal.chairHostHealthy ? '主席端故障' : connection === 'LIVE' ? '实时' : '离线';
  return <div className="delegate-file-portal">
    <Menu className="delegate-file-menu"><Menu.Item header className="delegate-file-committee-name">{portal.committeeName}</Menu.Item>
      <Menu.Item active={active === 'files'} onClick={() => setActive('files')}>已发布文件</Menu.Item>
      <Menu.Item active={active === 'upload'} onClick={() => setActive('upload')}>上传文件</Menu.Item>
      <Menu.Menu position="right"><Menu.Item>{status}</Menu.Item></Menu.Menu>
    </Menu>
    <Container>
      {notices.map(item => <Message info key={item.fileId} onDismiss={() => dismissForDownload(item.fileId)}
        content={`${item.submitterDisplayName} 代表 提交的 ${item.logicalName} 现已可用。`} />)}
      {error && <Message error content={error} />}
      {active === 'files' && <div className="delegate-file-card-list">{portal.files.length
        ? portal.files.map(item => <PublishedCard key={item.id} file={item} onDownload={dismissForDownload} />)
        : <Message content="暂无已发布文件" />}</div>}
      {active === 'upload' && <Card centered fluid className="delegate-file-upload-card"><Card.Content>
        <Form onSubmit={() => void upload()}><Form.Input type="file" label="选择文件" input={{
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => {setFile(event.currentTarget.files?.[0]);
            setSubmitted(false); setProgress(undefined);},
          'aria-label': '选择文件'
        }} /><Form.Select label="文件类型" options={FILE_TYPES} value={fileType}
          onChange={(_, data) => setFileType(data.value as DelegateFileType)} />
        {!submitted && progress === undefined && <Button primary fluid disabled={!file || working || !portal.mayUpload}>
          提交 <Icon name="arrow up" /></Button>}
        {progress !== undefined && !submitted && <Progress percent={Math.round(progress)} progress color="blue" />}
        {submitted && <div className="delegate-file-upload-success">✔提交成功，等待审核</div>}
        </Form>
      </Card.Content></Card>}
    </Container>
  </div>;
}

import * as React from 'react';
import type {CommitteeWorkspaceSnapshot, DelegateFileType, DelegateReviewFile, DelegateFileSettings} from '@quorum/contracts';
import QRCode from 'qrcode';
import {Button, Card, Divider, Form, Icon, Image, Message, Modal, Progress, Segment, Table} from 'semantic-ui-react';
import {newIdempotencyKey, type SelfHostedApi} from '../../services/self-hosted-api';
import {sha256File} from '../../services/sha256';
import {storageErrorText} from './FilesPanel';

const FILE_TYPES: Array<{key: DelegateFileType; value: DelegateFileType; text: string}> = [
  {key: 'WORKING_PAPER', value: 'WORKING_PAPER', text: '工作文件'},
  {key: 'DIRECTIVE_DRAFT', value: 'DIRECTIVE_DRAFT', text: '指令草案'},
  {key: 'RESOLUTION_DRAFT', value: 'RESOLUTION_DRAFT', text: '决议草案'}
];

function dateTime(value: string | null): string { return value ? new Date(value).toLocaleString('zh-CN') : '—'; }

export function DelegateFileSharePanel({snapshot, api}: {snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi}) {
  const [share, setShare] = React.useState<Awaited<ReturnType<SelfHostedApi['getDelegateFileShare']>>>();
  const [qr, setQr] = React.useState(''); const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const refresh = React.useCallback(async () => {
    try { setShare(await api.getDelegateFileShare(snapshot.committee.id)); setError(undefined); }
    catch (caught) { setError(storageErrorText(caught)); }
  }, [api, snapshot.committee.id]);
  React.useEffect(() => { void refresh(); }, [refresh, snapshot.sync.committeeEventSequence]);
  React.useEffect(() => { if (!share?.url) {setQr(''); return;} void QRCode.toDataURL(share.url, {width: 260, margin: 1}).then(setQr); }, [share?.url]);
  const start = async () => {setWorking(true); try {setShare(await api.startDelegateFileShare(snapshot.committee.id,
    snapshot.committee.revision)); setError(undefined);} catch (caught) {setError(storageErrorText(caught));} finally {setWorking(false);}};
  const end = async () => {if (!share) return; setWorking(true); try {await api.endDelegateFileShare(snapshot.committee.id,
    share.revision); setShare(null); setError(undefined);} catch (caught) {setError(storageErrorText(caught));} finally {setWorking(false);}};
  return <Segment className="delegate-file-share-panel">
    {error && <Message error content={error} />}
    {!share ? <Button primary loading={working} onClick={() => void start()}>开始分享</Button> : <>
      <Form><Form.Input readOnly label="代表端链接" value={share.url} action={{icon: 'copy', content: '复制',
        onClick: () => void navigator.clipboard?.writeText(share.url)}} /></Form>
      {qr && <Image centered src={qr} alt="代表端链接二维码" className="delegate-file-qr" />}
      <Button negative loading={working} onClick={() => void end()}>结束分享</Button>
    </>}
  </Segment>;
}

export function DelegateFileReviewPanel({snapshot, api}: {snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi}) {
  const [files, setFiles] = React.useState<DelegateReviewFile[]>([]); const [selected, setSelected] = React.useState<File>();
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [rejecting, setRejecting] = React.useState<DelegateReviewFile>();
  const [reason, setReason] = React.useState('');
  const [settings, setSettings] = React.useState<DelegateFileSettings>();
  const [rejectionTypeId, setRejectionTypeId] = React.useState('');
  const [deleting, setDeleting] = React.useState<DelegateReviewFile>();
  const [types, setTypes] = React.useState<Record<string, DelegateFileType>>({});
  const [progress, setProgress] = React.useState<number>(); const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const refresh = React.useCallback(async () => {
    try {
      const next = await api.listDelegateReviewFiles(snapshot.committee.id);
      setFiles(next);
      setTypes(current => Object.fromEntries(next.map(item => [item.id, current[item.id] ?? item.fileType ?? 'WORKING_PAPER'])));
      setError(undefined);
    } catch (caught) { setError(storageErrorText(caught)); }
  }, [api, snapshot.committee.id]);
  React.useEffect(() => {void refresh();}, [refresh, snapshot.sync.committeeEventSequence]);
  const upload = async () => {
    if (!selected) return; setWorking(true); setProgress(0); setError(undefined);
    try {
      const sha256 = await sha256File(selected, {onProgress: (done, total) => setProgress(total ? done / total * 20 : 0)});
      const created = await api.createFileUpload(snapshot.committee.id, {logicalName: selected.name,
        originalName: selected.name, mediaType: selected.type || 'application/octet-stream', expectedSizeBytes: selected.size, sha256});
      await api.uploadFileContent(created.id, selected, newIdempotencyKey(), {onProgress: (done, total) => setProgress(20 + (total ? done / total * 75 : 0))});
      setProgress(98); await api.commitFileUpload(created.id); setProgress(undefined); setSelected(undefined); await refresh();
    } catch (caught) {setProgress(undefined); setError(storageErrorText(caught));} finally {setWorking(false);}
  };
  const run = async (operation: () => Promise<unknown>) => {setWorking(true); setError(undefined); try {await operation(); await refresh();}
    catch (caught) {setError(storageErrorText(caught));} finally {setWorking(false);}};
  const nameFor = (file: DelegateReviewFile) => names[file.id] ?? file.suggestedNames?.[types[file.id] ?? file.fileType ?? 'WORKING_PAPER'] ?? file.logicalName;
  const pendingFiles = files.filter(file => ['UPLOAD_COMPLETE', 'PENDING_REVIEW'].includes(file.status));
  const reviewedFiles = files.filter(file => ['PUBLISHED', 'REJECTED'].includes(file.status));
  return <div className="delegate-file-review-panel">
    {error && <Message error content={error} />}
    <Card centered fluid className="delegate-file-chair-upload"><Card.Content><Form onSubmit={() => void upload()}>
      <Form.Input type="file" label="选择文件" input={{onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        setSelected(event.currentTarget.files?.[0]), 'aria-label': '选择文件'}} />
      {progress === undefined ? <Button primary disabled={!selected || working}>上传文件 <Icon name="arrow up" /></Button>
        : <Progress percent={Math.round(progress)} progress color="blue" />}
    </Form></Card.Content></Card>
    <div className="delegate-file-card-list">{pendingFiles.length ? pendingFiles.map(file => <Card fluid key={file.id} className="delegate-file-card motion-card">
      <Card.Content><div className="motion-heading delegate-file-heading"><Card.Header><Form.Input aria-label="文件名称" value={nameFor(file)}
        onChange={event => { const value = event.currentTarget.value; setNames(current => ({...current, [file.id]: value})); }} /></Card.Header></div>
        <Card.Meta><Table compact celled className="motion-metadata-table delegate-file-metadata"><Table.Body>
          <Table.Row><Table.Cell className="motion-metadata-key">提交国</Table.Cell><Table.Cell>{file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">文件类型</Table.Cell><Table.Cell><Form.Select compact options={FILE_TYPES}
            value={types[file.id]} onChange={(_, data) => setTypes(current => ({...current,
              [file.id]: data.value as DelegateFileType}))} /></Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">提交时间</Table.Cell><Table.Cell>{dateTime(file.submittedAt)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">原始文件</Table.Cell><Table.Cell>{file.originalName}</Table.Cell></Table.Row>
        </Table.Body></Table></Card.Meta>
      </Card.Content><Card.Content extra className="delegate-file-review-actions">
        <Button primary disabled={working || !nameFor(file).trim()} onClick={() => void run(() => api.approveDelegateFile(
          file.id, file.revision, nameFor(file), types[file.id] as DelegateFileType))}>批准</Button>
        <Button negative disabled={working} onClick={() => {setRejecting(file); setReason(''); setSettings(undefined); setRejectionTypeId(''); setError(undefined);
          void api.getDelegateFileSettings(snapshot.committee.id).then(next => {setSettings(next); setRejectionTypeId(next.rejectionTypes[0]?.id ?? '');})
            .catch(caught => setError(storageErrorText(caught)));}}>驳回</Button>
      </Card.Content></Card>) : <Message content="暂无待审核文件" />}</div>
    <Divider className="delegate-file-review-divider" />
    <div className="delegate-file-card-list">{reviewedFiles.length ? reviewedFiles.map(file => <Card fluid key={file.id} className="delegate-file-card motion-card">
      <Card.Content><div className="motion-heading delegate-file-heading"><Card.Header>{file.logicalName}</Card.Header>
        <span className={`motion-decision ${file.status === 'REJECTED' ? 'motion-decision-failed' : 'motion-decision-passed'}`}>{file.status === 'REJECTED' ? '已驳回' : '已批准'}</span></div>
        <Card.Meta><Table compact celled className="motion-metadata-table delegate-file-metadata"><Table.Body>
          <Table.Row><Table.Cell className="motion-metadata-key">提交国</Table.Cell><Table.Cell>{file.submitterDisplayName ?? '—'}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">文件类型</Table.Cell><Table.Cell>{FILE_TYPES.find(type => type.value === file.fileType)?.text ?? '—'}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">提交时间</Table.Cell><Table.Cell>{dateTime(file.submittedAt)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">审核时间</Table.Cell><Table.Cell>{dateTime(file.reviewedAt ?? file.publishedAt)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell className="motion-metadata-key">原始文件</Table.Cell><Table.Cell>{file.originalName}</Table.Cell></Table.Row>
          {file.rejectionReason && <Table.Row><Table.Cell className="motion-metadata-key">驳回理由</Table.Cell><Table.Cell>{file.rejectionReason}</Table.Cell></Table.Row>}
        </Table.Body></Table></Card.Meta>
      </Card.Content>{file.status === 'REJECTED' && !file.deleted && <Card.Content extra><Button negative fluid disabled={working}
        onClick={() => setDeleting(file)}><Icon name="times" /> 删除文件</Button></Card.Content>}</Card>) : <Message content="暂无已审核文件" />}</div>
    <Modal size="tiny" open={Boolean(rejecting)} closeOnDimmerClick={!working} closeOnEscape={!working}
      onClose={() => {if (!working) setRejecting(undefined);}}>
      <Modal.Header>驳回文件</Modal.Header><Modal.Content>
        <Form loading={!settings && !error}><Form.Select label="驳回理由" aria-label="驳回理由" selection
          options={settings?.rejectionTypes.map(item => ({key: item.id, value: item.id, text: item.label})) ?? []}
          value={rejectionTypeId} disabled={working} onChange={(_, data) => {setRejectionTypeId(String(data.value)); setReason('');}} />
          {settings?.rejectionTypes.find(item => item.id === rejectionTypeId)?.custom
            ? <Form.TextArea label="代表端提示消息" aria-label="代表端提示消息" required maxLength={2000} value={reason}
              disabled={working} onChange={(_, data) => setReason(String(data.value))} />
            : <Message content={settings?.rejectionTypes.find(item => item.id === rejectionTypeId)?.message} />}
        </Form>
        {error && <Message error content={error} />}
      </Modal.Content><Modal.Actions><Button disabled={working} onClick={() => setRejecting(undefined)}>取消</Button>
        <Button negative loading={working} disabled={working || !rejectionTypeId || Boolean(settings?.rejectionTypes.find(item => item.id === rejectionTypeId)?.custom && !reason.trim())} onClick={() => {if (!rejecting) return;
          const file = rejecting; void run(async () => {await api.rejectDelegateFile(file.id,file.revision,nameFor(file),
            types[file.id] ?? file.fileType ?? 'WORKING_PAPER',reason.trim() || undefined, rejectionTypeId);
            setRejecting(undefined); setDeleting({...file,revision:file.revision+1,status:'REJECTED'});});}}>确认驳回</Button>
      </Modal.Actions></Modal>
    <Modal size="tiny" open={Boolean(deleting)} closeOnDimmerClick={!working} closeOnEscape={!working}
      onClose={() => {if (!working) setDeleting(undefined);}}>
      <Modal.Header>是否删除被驳回的文件？</Modal.Header><Modal.Content>
        删除后无法恢复文件内容。审核记录仍会保留。{error && <Message error content={error} />}
      </Modal.Content><Modal.Actions><Button primary autoFocus disabled={working} onClick={() => setDeleting(undefined)}>保留文件</Button>
        <Button negative loading={working} disabled={working} onClick={() => {if (!deleting) return;
          const file = deleting; void run(async () => {await api.deleteFile(file.id,file.revision); setDeleting(undefined);});}}>删除文件</Button>
      </Modal.Actions></Modal>
  </div>;
}

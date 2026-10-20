import * as React from 'react';
import {saveAs} from 'file-saver';
import {Button, Checkbox, Form, Header, Message, Modal, Segment, Table} from 'semantic-ui-react';
import type {ServerVolumeCleanup, ServerVolumeInventory} from '@quorum/contracts';
import type {SelfHostedApi} from '../../services/self-hosted-api';
import {t, apiErrorText} from '../../i18n';

const bytes = (value: number) => value<1024 ? `${value} B` : value<1024*1024 ? `${(value/1024).toFixed(1)} KiB` : `${(value/1024/1024).toFixed(2)} MiB`;
export default function ServerVolumeAdminPanel({api}: {api: SelfHostedApi}) {
  const [policy, setPolicy] = React.useState<{disabled: boolean; revision: number}>();
  const [inventory, setInventory] = React.useState<ServerVolumeInventory>();
  const [jobs, setJobs] = React.useState<ServerVolumeCleanup[]>([]);
  const [preview, setPreview] = React.useState<ServerVolumeCleanup>();
  const [error, setError] = React.useState<unknown>();
  const [working, setWorking] = React.useState(false);
  const [downloading, setDownloading] = React.useState<Set<string>>(() => new Set());
  const [search, setSearch] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [page, setPage] = React.useState(1);
  const generation = React.useRef(0);
  const refresh = React.useCallback(async () => {
    const current=++generation.current;
    try {const [nextPolicy,nextFiles,nextJobs]=await Promise.all([api.serverVolumePolicy(),api.serverVolumeFiles(search,status,page),api.serverVolumeCleanups()]);
      if(current===generation.current){setPolicy(nextPolicy);setInventory(nextFiles);setJobs(nextJobs);}}
    catch(failure){if(current===generation.current)setError(failure);}
  },[api,search,status,page]);
  React.useEffect(()=>{void refresh();const timer=window.setInterval(()=>void refresh(),5000);
    return()=>{generation.current++;window.clearInterval(timer);};},[refresh]);
  const run = async (operation: () => Promise<void>) => {
    if(working)return;setWorking(true);setError(undefined);
    try {await operation();}catch(failure){setError(failure);}finally{setWorking(false);await refresh();}
  };
  const download = async (id: string) => {
    setDownloading(current => new Set(current).add(id)); setError(undefined);
    try {const file = await api.downloadServerVolumeFile(id); saveAs(file.blob,file.name);}
    catch (failure) {setError(failure);}
    finally {setDownloading(current => {const next = new Set(current);next.delete(id);return next;});}
  };
  const requestCleanup = (scope: ServerVolumeCleanup['scope'], fileId?: string) => run(async()=>{
    setPreview(await api.previewServerVolumeCleanup(scope,fileId));
  });
  return <Segment loading={working} className="server-volume-admin">
    <Header as="h2">{t('Server volume')}</Header>
    {Boolean(error) && <Message error role="alert">{apiErrorText(error)}</Message>}
    <div className="server-volume-policy">
      <Checkbox toggle label={t('Disable server volume storage')} checked={policy?.disabled ?? false}
        disabled={!policy || working} onChange={(_, data) => void run(async()=>{
          if(policy)setPolicy(await api.updateServerVolumePolicy({revision:policy.revision,disabled:Boolean(data.checked)}));
        })} />
      {policy?.disabled && <div className="admin-actions">
        <Button negative basic disabled={working} onClick={()=>void requestCleanup('ARCHIVED')}>{t('Clear archived committees’ server volume files')}</Button>
        <Button negative basic disabled={working} onClick={()=>void requestCleanup('ALL')}>{t('Clear all server volume files')}</Button>
      </div>}
    </div>
    <div className="system-settings-section-heading server-volume-heading">
      <Header as="h3">{t('Server volume files')}</Header>
      {inventory && <span className="server-volume-secondary">{t('Volume file count: {count}; size: {size}',{count:inventory.total,size:bytes(inventory.totalBytes)})}</span>}
    </div>
    <Form className="server-volume-toolbar" onSubmit={()=>void refresh()}>
      <Form.Input className="server-volume-search" icon="search" aria-label={t('Search volume files')} placeholder={t('Search volume files')} value={search}
        onChange={(_,data)=>{setSearch(data.value);setPage(1);}} />
      <Form.Select aria-label={t('Committee status')} value={status || 'ALL'} options={[
        {key:'all',value:'ALL',text:t('All committees')},{key:'active',value:'ACTIVE',text:t('Active')},
        {key:'paused',value:'PAUSED',text:t('Paused')},{key:'archived',value:'ARCHIVED',text:t('Archived')}
      ]} onChange={(_,data)=>{setStatus(data.value==='ALL'?'':String(data.value));setPage(1);}} />
      <Button type="submit" icon="refresh" content={t('Refresh')} disabled={working} />
    </Form>
    {inventory && <>
      <div className="server-volume-root server-volume-secondary">{t('Container path')}: <code>{inventory.rootPath}</code></div>
      {inventory.files.length === 0 ? <Message>{t('No files')}</Message> : <div className="server-volume-table-scroll" role="region" aria-label={t('Server volume files')} tabIndex={0}><Table compact unstackable className="server-volume-table">
        <Table.Header><Table.Row><Table.HeaderCell>{t('Owner account')}</Table.HeaderCell><Table.HeaderCell>{t('Committee')}</Table.HeaderCell><Table.HeaderCell>{t('File record')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Container path')}</Table.HeaderCell><Table.HeaderCell>{t('Size')}</Table.HeaderCell>
          <Table.HeaderCell>{t('Status')}</Table.HeaderCell><Table.HeaderCell>{t('Actions')}</Table.HeaderCell></Table.Row></Table.Header>
        <Table.Body>{inventory.files.map(file=><Table.Row key={file.id}>
          <Table.Cell>{file.ownerEmail ?? '—'}</Table.Cell>
          <Table.Cell>{file.committeeName ?? '—'}<div className="server-volume-secondary">{file.committeeStatus && t(({ACTIVE:'Active',PAUSED:'Paused',ARCHIVED:'Archived',DELETING:'Deleting'} as Record<string,string>)[file.committeeStatus] ?? file.committeeStatus)}</div></Table.Cell>
          <Table.Cell>{file.references.length > 1 ? <details><summary>{file.references[0].name} · v{file.references[0].version}</summary>
            {file.references.slice(1).map(ref=><div key={`${ref.fileId}/${ref.version}`}>{ref.name} · v{ref.version}</div>)}</details>
            : file.references.length === 1 ? <>{file.references[0].name} · v{file.references[0].version}</> : '—'}</Table.Cell>
          <Table.Cell><div className="server-volume-path"><code>{file.path}</code><Button basic size="mini" icon="copy" aria-label={t('Copy path')} title={t('Copy path')}
            onClick={()=>void navigator.clipboard.writeText(file.path).catch(setError)} /></div></Table.Cell>
          <Table.Cell>{bytes(file.sizeBytes)}</Table.Cell>
          <Table.Cell>{!file.present?t('Missing from disk'):file.state==='DELETE_PENDING'?t('Cleaning server volume')
            :file.bindingStatus==='RETIRED'?t('Retired storage copy'):file.state==='UNTRACKED'?t('Untracked file'):t('Stored')}
            {!file.hasOtherCopy && <div className="server-volume-secondary">{t(file.blobId ? 'No verified copy in other storage' : 'Copy status unknown')}</div>}</Table.Cell>
          <Table.Cell><div className="server-volume-actions"><Button basic size="small" loading={downloading.has(file.id)}
            disabled={working || downloading.has(file.id) || !file.present || file.state==='DELETE_PENDING'}
            onClick={()=>void download(file.id)}>{t('Download')}</Button>
            <Button negative basic size="small" disabled={working || file.state==='DELETE_PENDING'}
            onClick={()=>void requestCleanup('SELECTED',file.id)}>{t('Delete')}</Button></div></Table.Cell>
        </Table.Row>)}</Table.Body>
      </Table></div>}
      {(inventory.total > 25 || page > 1) && <div className="server-volume-pagination">
        <Button size="small" disabled={page<=1 || working} onClick={()=>setPage(value=>value-1)}>{t('Previous page')}</Button>
        <span>{page} / {Math.max(1,Math.ceil(inventory.total/25))}</span>
        <Button size="small" disabled={page*25>=inventory.total || working} onClick={()=>setPage(value=>value+1)}>{t('Next page')}</Button>
      </div>}
    </>}
    {jobs.length>0 && <><Header as="h3">{t('Server volume cleanup tasks')}</Header>{jobs.map(job=><Message key={job.id}
      warning={job.failed>0} positive={job.status==='COMPLETED'} role="status">
      {t(job.scope==='ARCHIVED'?'Clear archived committees’ server volume files':job.scope==='ALL'?'Clear all server volume files':'Delete selected volume file')}
      {' · '}{t(job.status==='COMPLETED'?'Server volume cleanup completed':'Cleaning server volume')} · {job.completed}/{job.total}
      {job.failed>0 && ` · ${t('Cleanup retrying')}: ${job.failed}`}
    </Message>)}</>}
    <Modal className="server-volume-confirm" open={Boolean(preview)} onClose={()=>{if(!working)setPreview(undefined);}} size="small" closeOnDimmerClick={!working} closeOnEscape={!working}>
      <Modal.Header>{t('Confirm server volume cleanup')}</Modal.Header>
      <Modal.Content scrolling>
        {Boolean(error) && <Message error role="alert">{apiErrorText(error)}</Message>}
        {preview && <>
          <p>{t(preview.scope==='ARCHIVED'?'Clear archived committees’ server volume files':preview.scope==='ALL'?'Clear all server volume files':'Delete selected volume file')}</p>
          <p>{t('Clear {files} copies in {committees} committees, freeing approximately {size}.',
            {files:preview.total,committees:preview.committeeCount,size:bytes(preview.sizeBytes)})}</p>
          {preview.withoutOtherCopy>0 && <Message negative>{t('{count} copies have no verified copy in current alternative storage. Clearing them can permanently prevent downloads and migration.',{count:preview.withoutOtherCopy})}</Message>}
          <details open={preview.scope==='SELECTED'}><summary>{t('Files to clear')}</summary>
            {preview.files?.map(file=><div className="server-volume-preview-file" key={file.id}><strong>{file.committeeName ?? t('Untracked file')}</strong>
              {file.references.map(ref=><div key={`${ref.fileId}/${ref.version}`}>{ref.name} · v{ref.version}</div>)}
              <div className="server-volume-secondary"><code>{file.path}</code> · {bytes(file.sizeBytes)}</div></div>)}
          </details>
        </>}
      </Modal.Content>
      <Modal.Actions><Button disabled={working} onClick={()=>setPreview(undefined)}>{t('Cancel')}</Button>
        <Button negative disabled={working || !preview?.total} onClick={()=>void run(async()=>{
          if(preview){await api.confirmServerVolumeCleanup(preview.id);setPreview(undefined);}
        })}>{t('Confirm deletion')}</Button></Modal.Actions>
    </Modal>
  </Segment>;
}

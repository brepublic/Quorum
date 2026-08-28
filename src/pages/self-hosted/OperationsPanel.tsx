import * as React from 'react';
import {Button, Form, Header, Label, Message, Segment, Statistic, Table} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

type Status = Awaited<ReturnType<SelfHostedApi['operationsStatus']>>;

export default function OperationsPanel({api}: {api: SelfHostedApi}) {
  const [status, setStatus] = React.useState<Status>();
  const [error, setError] = React.useState<string>();
  const [cache, setCache] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheStatus']>>>();
  const [published, setPublished] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheFiles']>>>();
  const [pending, setPending] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheFiles']>>>();
  const [saving, setSaving] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    void api.operationsStatus().then(value => { if (active) setStatus(value); }, caught => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    if (typeof api.storageCacheStatus === 'function') void Promise.all([
      api.storageCacheStatus(), api.storageCacheFiles('published'), api.storageCacheFiles('pending')
    ]).then(([nextCache, nextPublished, nextPending]) => {
      if (active) {setCache(nextCache); setPublished(nextPublished); setPending(nextPending);}
    }, caught => {if (active) setError(caught instanceof Error ? caught.message : String(caught));});
    return () => { active = false; };
  }, [api]);
  if (error) return <Message error role="alert" content={error} />;
  if (!status) return <Segment loading style={{minHeight: '8em'}} />;
  const percent = Math.round(status.storage.usageRatio * 100);
  const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB`
    : `${(value / 1024 ** 2).toFixed(1)} MiB`;
  const save = async () => {
    if (!cache) return; setSaving(true); setError(undefined);
    try { const config = await api.updateStorageCacheConfig(cache.config); setCache({...cache, config}); }
    catch (caught) {setError(caught instanceof Error ? caught.message : String(caught));}
    finally {setSaving(false);}
  };
  const fileTable = (title: string, page: typeof published, lru: boolean) => <>
    <Header as="h2">{title}</Header><div className="storage-cache-table-wrap"><Table compact celled>
      <Table.Header><Table.Row><Table.HeaderCell>文件名</Table.HeaderCell><Table.HeaderCell>委员会</Table.HeaderCell>
        <Table.HeaderCell>大小</Table.HeaderCell><Table.HeaderCell>状态</Table.HeaderCell>
        <Table.HeaderCell>{lru ? '最近访问' : '进入保留区'}</Table.HeaderCell></Table.Row></Table.Header>
      <Table.Body>{page?.files.map((file, index) => <Table.Row key={file.id}>
        <Table.Cell>{file.fileName}{lru && index === 0 && file.state === 'READY' ? <Label size="tiny">最先淘汰</Label> : null}</Table.Cell>
        <Table.Cell>{file.committeeName}</Table.Cell><Table.Cell>{bytes(file.sizeBytes)}</Table.Cell>
        <Table.Cell>{file.state}</Table.Cell><Table.Cell>{new Date((lru ? file.lastAccessedAt : file.cachedAt)
          ?? file.cachedAt ?? 0).toLocaleString()}</Table.Cell></Table.Row>)}</Table.Body>
    </Table></div></>;
  return <div className="self-hosted-operations">
    <Header as="h1">运行状态</Header>
    {status.storage.state !== 'normal' && <Message warning={status.storage.state === 'warning'}
      error={status.storage.state === 'critical'} content={`存储使用率 ${percent}%`} />}
    <Statistic.Group size="small" widths="four">
      <Statistic label="数据库版本" value={status.database.schemaCompatibility} />
      <Statistic label="存储使用率" value={`${percent}%`} />
      <Statistic label="活动账号" value={status.accounts.active} />
      <Statistic label="活动委员会" value={status.committees.active} />
    </Statistic.Group>
    <Header as="h2">待处理任务</Header>
    <Table compact celled><Table.Body>
      {Object.entries(status.queues).map(([name, count]) => <Table.Row key={name}>
        <Table.Cell>{({blobDelete: '文件删除', uploadStaging: '上传暂存', migration: '存储迁移',
          agentTasks: '主席电脑任务', committeeDeletion: '委员会删除'} as Record<string, string>)[name]}</Table.Cell>
        <Table.Cell textAlign="right"><Label color={count ? 'orange' : undefined}>{count}</Label></Table.Cell>
      </Table.Row>)}
    </Table.Body>
    </Table>
    <Header as="h2">保留任务</Header>
    <Segment>{status.retention.lastStatus ?? '尚未运行'}{status.retention.lastCompletedAt
      ? ` · ${new Date(status.retention.lastCompletedAt).toLocaleString()}` : ''}</Segment>
    {cache && <>
      <Header as="h2">文件缓存</Header>
      <Statistic.Group size="mini" widths="four">
        <Statistic label="文件系统总量" value={bytes(cache.capacity.totalBytes)} />
        <Statistic label="当前可用" value={bytes(cache.capacity.availableBytes)} />
        <Statistic label="待审核" value={bytes(cache.capacity.pendingReviewBytes)} />
        <Statistic label="发布缓存" value={bytes(cache.capacity.publishedCacheBytes)} />
      </Statistic.Group>
      <Table compact celled><Table.Body>
        <Table.Row><Table.Cell>Quorum 文件</Table.Cell><Table.Cell>{bytes(cache.capacity.quorumBytes)}</Table.Cell></Table.Row>
        <Table.Row><Table.Cell>其他暂存</Table.Cell><Table.Cell>{bytes(cache.capacity.otherStagingBytes)}</Table.Cell></Table.Row>
        <Table.Row><Table.Cell>命中／未命中</Table.Cell><Table.Cell>{cache.runtime.hits}／{cache.runtime.misses}</Table.Cell></Table.Row>
        <Table.Row><Table.Cell>正在取回</Table.Cell><Table.Cell>{cache.runtime.fetching}</Table.Cell></Table.Row>
        <Table.Row><Table.Cell>最近清理</Table.Cell><Table.Cell>{cache.runtime.lastEvictedAt
          ? `${new Date(cache.runtime.lastEvictedAt).toLocaleString()} · ${bytes(cache.runtime.lastEvictedBytes)}` : '尚未清理'}</Table.Cell></Table.Row>
      </Table.Body></Table>
      <Form onSubmit={() => void save()} loading={saving}><Form.Group widths="equal">
        <Form.Input label="发布缓存额度（字节）" type="number" value={cache.config.publishedCacheMaxBytes}
          onChange={(_, data) => setCache({...cache, config: {...cache.config, publishedCacheMaxBytes: Number(data.value)}})} />
        <Form.Input label="待审核总额度（字节）" type="number" value={cache.config.pendingReviewMaxBytes}
          onChange={(_, data) => setCache({...cache, config: {...cache.config, pendingReviewMaxBytes: Number(data.value)}})} />
        <Form.Input label="单委员会待审核额度（字节）" type="number" value={cache.config.pendingReviewCommitteeMaxBytes}
          onChange={(_, data) => setCache({...cache, config: {...cache.config, pendingReviewCommitteeMaxBytes: Number(data.value)}})} />
      </Form.Group><Form.Group widths="equal">
        <Form.Input label="最低可用空间（字节）" type="number" value={cache.config.storageMinFreeBytes}
          onChange={(_, data) => setCache({...cache, config: {...cache.config, storageMinFreeBytes: Number(data.value)}})} />
        <Form.Input label="最低可用空间（%）" type="number" value={cache.config.storageMinFreePercent}
          onChange={(_, data) => setCache({...cache, config: {...cache.config, storageMinFreePercent: Number(data.value)}})} />
      </Form.Group><Button primary>保存缓存配置</Button></Form>
      {fileTable('发布缓存', published, true)}{fileTable('待审核保留区', pending, false)}
    </>}
  </div>;
}

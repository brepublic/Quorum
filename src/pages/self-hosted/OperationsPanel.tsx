import * as React from 'react';
import {Button, Header, Label, Message, Segment, Statistic, Table} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

type Status = Awaited<ReturnType<SelfHostedApi['operationsStatus']>>;
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB`
  : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const cacheStateText: Record<string, string> = {READY: '已缓存', REVIEW_PINNED: '待审核', MISSING: '未缓存',
  FETCHING: '正在取回', EVICTING: '正在清理', FAILED: '失败'};

export default function OperationsPanel({api}: {api: SelfHostedApi}) {
  const [status, setStatus] = React.useState<Status>();
  const [error, setError] = React.useState<string>();
  const [cacheError, setCacheError] = React.useState<string>();
  const [cache, setCache] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheStatus']>>>();
  const [published, setPublished] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheFiles']>>>();
  const [pending, setPending] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheFiles']>>>();
  const [reload, setReload] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    setLoading(true); setError(undefined); setCacheError(undefined);
    const loadStatus = api.operationsStatus().then(value => {if (active) setStatus(value);}, caught => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    const loadCache = typeof api.storageCacheStatus === 'function' ? Promise.all([
      api.storageCacheStatus(), api.storageCacheFiles('published'), api.storageCacheFiles('pending')
    ]).then(([nextCache, nextPublished, nextPending]) => {
      if (active) {setCache(nextCache); setPublished(nextPublished); setPending(nextPending);}
    }, caught => {if (active) setCacheError(caught instanceof Error ? caught.message : String(caught));}) : undefined;
    void Promise.all([loadStatus, loadCache]).finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [api, reload]);
  const percent = Math.round((status?.storage.usageRatio ?? 0) * 100);
  const fileTable = (title: string, page: typeof published, lru: boolean) => <Segment as="details" className="storage-cache-inventory">
    <summary>{title}<Label size="small">{page?.total ?? 0}</Label></summary>
    {!page?.files.length ? <p className="storage-cache-empty">暂无文件</p> : <div className="storage-cache-table-wrap"><Table compact celled unstackable>
      <Table.Header><Table.Row><Table.HeaderCell>文件名</Table.HeaderCell><Table.HeaderCell>委员会</Table.HeaderCell>
        <Table.HeaderCell>大小</Table.HeaderCell><Table.HeaderCell>状态</Table.HeaderCell>
        <Table.HeaderCell>{lru ? '最近访问' : '进入保留区'}</Table.HeaderCell></Table.Row></Table.Header>
      <Table.Body>{page.files.map((file, index) => <Table.Row key={file.id}>
        <Table.Cell>{file.fileName}{lru && index === 0 && file.state === 'READY' ? <Label size="tiny">最先淘汰</Label> : null}</Table.Cell>
        <Table.Cell>{file.committeeName}</Table.Cell><Table.Cell>{bytes(file.sizeBytes)}</Table.Cell>
        <Table.Cell>{cacheStateText[file.state] ?? file.state}</Table.Cell><Table.Cell>{new Date((lru ? file.lastAccessedAt : file.cachedAt)
          ?? file.cachedAt ?? 0).toLocaleString()}</Table.Cell></Table.Row>)}</Table.Body>
    </Table></div>}
  </Segment>;
  return <div className="self-hosted-operations">
    <div className="system-settings-section-heading">
      <Header as="h2">系统概览</Header>
      <Button basic size="small" icon="refresh" content="刷新" loading={loading} disabled={loading}
        onClick={() => setReload(value => value + 1)} />
    </div>
    {error && <Message error role="alert" content={error} />}
    {!status && loading && <Segment loading style={{minHeight: '8em'}} />}
    {status && <>
      {status.storage.state !== 'normal' && <Message warning={status.storage.state === 'warning'}
        error={status.storage.state === 'critical'} content={`存储使用率 ${percent}%`} />}
      <div className="operations-metrics">
        <Segment><Statistic size="small" label="存储使用率" value={`${percent}%`} /></Segment>
        <Segment><Statistic size="small" label="活动账号" value={status.accounts.active} /></Segment>
        <Segment><Statistic size="small" label="活动委员会" value={status.committees.active} /></Segment>
        <Segment><Statistic size="small" label="数据库版本" value={status.database.schemaCompatibility} /></Segment>
      </div>
      <div className="operations-task-cards">
        <Segment>
          <Header as="h2">待处理任务</Header>
          <Table basic="very" compact unstackable><Table.Body>
            {Object.entries(status.queues).map(([name, count]) => <Table.Row key={name}>
              <Table.Cell>{({blobDelete: '文件删除', uploadStaging: '上传暂存', migration: '存储迁移',
                agentTasks: '主席电脑任务', committeeDeletion: '委员会删除'} as Record<string, string>)[name]}</Table.Cell>
              <Table.Cell textAlign="right"><Label color={count ? 'orange' : undefined}>{count}</Label></Table.Cell>
            </Table.Row>)}
          </Table.Body></Table>
        </Segment>
        <Segment>
          <Header as="h2">保留任务</Header>
          <Label color={status.retention.lastStatus === 'FAILED' ? 'red' : status.retention.lastStatus === 'COMPLETED' ? 'green' : undefined}>
            {({COMPLETED: '已完成', FAILED: '执行失败', RUNNING: '运行中'} as Record<string, string>)[status.retention.lastStatus ?? '']
              ?? status.retention.lastStatus ?? '尚未运行'}
          </Label>
          {status.retention.lastCompletedAt && <dl className="operations-retention-time">
            <dt>最近完成时间</dt><dd>{new Date(status.retention.lastCompletedAt).toLocaleString()}</dd>
          </dl>}
        </Segment>
      </div>
    </>}
    {cacheError && <Message error role="alert" header="文件缓存读取失败" content={cacheError} />}
    {cache && <>
      <Segment>
        <Header as="h2">文件缓存</Header>
        <div className="operations-cache-metrics">
          <Statistic size="mini" label="文件系统总量" value={bytes(cache.capacity.totalBytes)} />
          <Statistic size="mini" label="当前可用" value={bytes(cache.capacity.availableBytes)} />
          <Statistic size="mini" label="待审核" value={bytes(cache.capacity.pendingReviewBytes)} />
          <Statistic size="mini" label="发布缓存" value={bytes(cache.capacity.publishedCacheBytes)} />
        </div>
        <Table basic="very" compact unstackable><Table.Body>
          <Table.Row><Table.Cell>Quorum 文件</Table.Cell><Table.Cell textAlign="right">{bytes(cache.capacity.quorumBytes)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>其他暂存</Table.Cell><Table.Cell textAlign="right">{bytes(cache.capacity.otherStagingBytes)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>命中／未命中</Table.Cell><Table.Cell textAlign="right">{cache.runtime.hits}／{cache.runtime.misses}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>正在取回</Table.Cell><Table.Cell textAlign="right">{cache.runtime.fetching}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>最近清理</Table.Cell><Table.Cell textAlign="right">{cache.runtime.lastEvictedAt
            ? `${new Date(cache.runtime.lastEvictedAt).toLocaleString()} · ${bytes(cache.runtime.lastEvictedBytes)}` : '尚未清理'}</Table.Cell></Table.Row>
        </Table.Body></Table>
      </Segment>
      {fileTable('发布缓存', published, true)}{fileTable('待审核保留区', pending, false)}
    </>}
  </div>;
}

import {apiErrorText} from '../../i18n';
import {t, useLanguage, getLanguage} from '../../i18n';
import * as React from 'react';
import {Button, Header, Label, Message, Segment, Statistic, Table} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

type Status = Awaited<ReturnType<SelfHostedApi['operationsStatus']>>;
const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB`
  : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const cacheStateText: Record<string, string> = {READY: "Cached", REVIEW_PINNED: "Pending review", MISSING: "Not cached",
  FETCHING: "Fetching", EVICTING: "Cleaning up", FAILED: "Failed"};

export default function OperationsPanel({api}: {api: SelfHostedApi}) {
  useLanguage();
  const [status, setStatus] = React.useState<Status>();
  const [failure, setError] = React.useState<unknown>();
  const error = failure ? apiErrorText(failure) : undefined;
  const [cacheFailure, setCacheError] = React.useState<unknown>();
  const cacheError = cacheFailure ? apiErrorText(cacheFailure) : undefined;
  const [cache, setCache] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheStatus']>>>();
  const [published, setPublished] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheFiles']>>>();
  const [pending, setPending] = React.useState<Awaited<ReturnType<SelfHostedApi['storageCacheFiles']>>>();
  const [searchIndex, setSearchIndex] = React.useState<Awaited<ReturnType<SelfHostedApi['searchIndexStatus']>>>();
  const [searchFailure, setSearchFailure] = React.useState<unknown>();
  const [rebuildingSearch, setRebuildingSearch] = React.useState(false);
  const [searchRebuilt, setSearchRebuilt] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    let active = true;
    setLoading(true); setError(undefined); setCacheError(undefined);
    const loadStatus = api.operationsStatus().then(value => {if (active) setStatus(value);}, caught => {
      if (active) setError(caught);
    });
    const loadCache = typeof api.storageCacheStatus === 'function' ? Promise.all([
      api.storageCacheStatus(), api.storageCacheFiles('published'), api.storageCacheFiles('pending')
    ]).then(([nextCache, nextPublished, nextPending]) => {
      if (active) {setCache(nextCache); setPublished(nextPublished); setPending(nextPending);}
    }, caught => {if (active) setCacheError(caught);}) : undefined;
    const loadSearch = typeof api.searchIndexStatus === 'function' ? api.searchIndexStatus()
      .then(value => {if (active) setSearchIndex(value);}, caught => {if (active) setSearchFailure(caught);}) : undefined;
    void Promise.all([loadStatus, loadCache, loadSearch]).finally(() => {if (active) setLoading(false);});
    return () => {active = false;};
  }, [api, reload]);
  const percent = Math.round((status?.storage.usageRatio ?? 0) * 100);
  const fileTable = (title: string, page: typeof published, lru: boolean) => <Segment as="details" className="storage-cache-inventory">
    <summary>{title}<Label size="small">{page?.total ?? 0}</Label></summary>
    {!page?.files.length ? <p className="storage-cache-empty">{t("No files")}</p> : <div className="storage-cache-table-wrap"><Table compact celled unstackable>
      <Table.Header><Table.Row><Table.HeaderCell>{t("File name")}</Table.HeaderCell><Table.HeaderCell>{t("Committees")}</Table.HeaderCell>
        <Table.HeaderCell>{t("Size")}</Table.HeaderCell><Table.HeaderCell>{t("Status")}</Table.HeaderCell>
        <Table.HeaderCell>{lru ? t("Last accessed") : t("Entered review reserve")}</Table.HeaderCell></Table.Row></Table.Header>
      <Table.Body>{page.files.map((file, index) => <Table.Row key={file.id}>
        <Table.Cell>{file.fileName}{lru && index === 0 && file.state === 'READY' ? <Label size="tiny">{t("Evict first")}</Label> : null}</Table.Cell>
        <Table.Cell>{file.committeeName}</Table.Cell><Table.Cell>{bytes(file.sizeBytes)}</Table.Cell>
        <Table.Cell>{t(cacheStateText[file.state] ?? file.state)}</Table.Cell><Table.Cell>{new Date((lru ? file.lastAccessedAt : file.cachedAt)
          ?? file.cachedAt ?? 0).toLocaleString(getLanguage())}</Table.Cell></Table.Row>)}</Table.Body>
    </Table></div>}
  </Segment>;
  return <div className="self-hosted-operations">
    <div className="system-settings-section-heading">
      <Header as="h2">{t("System overview")}</Header>
      <Button basic size="small" icon="refresh" content={t("Refresh")} loading={loading} disabled={loading}
        onClick={() => setReload(value => value + 1)} />
    </div>
    {error && <Message error role="alert" content={error} />}
    {!status && loading && <Segment loading style={{minHeight: '8em'}} />}
    {status && <>
      {status.storage.state !== 'normal' && <Message warning={status.storage.state === 'warning'}
        error={status.storage.state === 'critical'} content={t('Storage usage {percent}%', {percent})} />}
      <div className="operations-metrics">
        <Segment><Statistic size="small" label={t("Storage usage")} value={`${percent}%`} /></Segment>
        <Segment><Statistic size="small" label={t("Active accounts")} value={status.accounts.active} /></Segment>
        <Segment><Statistic size="small" label={t("Active committees")} value={status.committees.active} /></Segment>
        <Segment><Statistic size="small" label={t("Database version")} value={status.database.schemaCompatibility} /></Segment>
      </div>
      {searchIndex && <Segment>
        <Header as="h2">{t('Search index')}</Header>
        <p>{t('Indexed options')}: {searchIndex.count}</p>
        <Button primary loading={rebuildingSearch} disabled={rebuildingSearch} onClick={() => {
          setRebuildingSearch(true); setSearchFailure(undefined); setSearchRebuilt(false);
          void api.rebuildSearchIndex().then(() => api.searchIndexStatus()).then(next => {
            setSearchIndex(next); setSearchRebuilt(true);
          }, caught => setSearchFailure(caught)).finally(() => setRebuildingSearch(false));
        }}>{t('Rebuild search index')}</Button>
        {searchRebuilt && <Message positive content={t('Search index rebuilt')} />}
        {Boolean(searchFailure) && <Message error content={apiErrorText(searchFailure)} />}
      </Segment>}
      <div className="operations-task-cards">
        <Segment>
          <Header as="h2">{t("Pending tasks")}</Header>
          <Table basic="very" compact unstackable><Table.Body>
            {Object.entries(status.queues).map(([name, count]) => <Table.Row key={name}>
              <Table.Cell>{({blobDelete: t("File deletion"), uploadStaging: t("Upload staging"), migration: t("Storage migration"),
                agentTasks: t("Chair computer tasks"), committeeDeletion: t("Committee deletion")} as Record<string, string>)[name]}</Table.Cell>
              <Table.Cell textAlign="right"><Label color={count ? 'orange' : undefined}>{count}</Label></Table.Cell>
            </Table.Row>)}
          </Table.Body></Table>
        </Segment>
        <Segment>
          <Header as="h2">{t("Retention tasks")}</Header>
          <Label color={status.retention.lastStatus === 'FAILED' ? 'red' : status.retention.lastStatus === 'COMPLETED' ? 'green' : undefined}>
            {({COMPLETED: t("COMPLETED"), FAILED: t("Execution failed"), RUNNING: t("Running")} as Record<string, string>)[status.retention.lastStatus ?? '']
              ?? status.retention.lastStatus ?? t("Not run yet")}
          </Label>
          {status.retention.lastCompletedAt && <dl className="operations-retention-time">
            <dt>{t("Last completed")}</dt><dd>{new Date(status.retention.lastCompletedAt).toLocaleString(getLanguage())}</dd>
          </dl>}
        </Segment>
      </div>
    </>}
    {cacheError && <Message error role="alert" header={t("Could not load file cache")} content={cacheError} />}
    {cache && <>
      <Segment>
        <Header as="h2">{t("File cache")}</Header>
        <div className="operations-cache-metrics">
          <Statistic size="mini" label={t("Filesystem capacity")} value={bytes(cache.capacity.totalBytes)} />
          <Statistic size="mini" label={t("Available")} value={bytes(cache.capacity.availableBytes)} />
          <Statistic size="mini" label={t("Pending review")} value={bytes(cache.capacity.pendingReviewBytes)} />
          <Statistic size="mini" label={t("Published file cache")} value={bytes(cache.capacity.publishedCacheBytes)} />
        </div>
        <Table basic="very" compact unstackable><Table.Body>
          <Table.Row><Table.Cell>{t("Quorum files")}</Table.Cell><Table.Cell textAlign="right">{bytes(cache.capacity.quorumBytes)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>{t("Other staging")}</Table.Cell><Table.Cell textAlign="right">{bytes(cache.capacity.otherStagingBytes)}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>{t("Hits / misses")}</Table.Cell><Table.Cell textAlign="right">{cache.runtime.hits}／{cache.runtime.misses}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>{t("Fetching")}</Table.Cell><Table.Cell textAlign="right">{cache.runtime.fetching}</Table.Cell></Table.Row>
          <Table.Row><Table.Cell>{t("Last cleanup")}</Table.Cell><Table.Cell textAlign="right">{cache.runtime.lastEvictedAt
            ? `${new Date(cache.runtime.lastEvictedAt).toLocaleString(getLanguage())} · ${bytes(cache.runtime.lastEvictedBytes)}` : t("Not cleaned yet")}</Table.Cell></Table.Row>
        </Table.Body></Table>
      </Segment>
      {fileTable(t("Published file cache"), published, true)}{fileTable(t("Review reserve"), pending, false)}
    </>}
  </div>;
}

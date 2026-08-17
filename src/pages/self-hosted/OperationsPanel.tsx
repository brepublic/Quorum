import * as React from 'react';
import {Header, Label, Message, Segment, Statistic, Table} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

type Status = Awaited<ReturnType<SelfHostedApi['operationsStatus']>>;

export default function OperationsPanel({api}: {api: SelfHostedApi}) {
  const [status, setStatus] = React.useState<Status>();
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    let active = true;
    void api.operationsStatus().then(value => { if (active) setStatus(value); }, caught => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; };
  }, [api]);
  if (error) return <Message error role="alert" content={error} />;
  if (!status) return <Segment loading style={{minHeight: '8em'}} />;
  const percent = Math.round(status.storage.usageRatio * 100);
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
  </div>;
}

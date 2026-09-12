import * as React from 'react';
import {Prompt} from 'react-router-dom';
import {Button, Form, Header, Message, Segment} from 'semantic-ui-react';
import type {SelfHostedApi} from '../../services/self-hosted-api';

type Config = Awaited<ReturnType<SelfHostedApi['storageCacheStatus']>>['config'];

export default function StorageCacheSettingsPanel({api}: {api: SelfHostedApi}) {
  const [config, setConfig] = React.useState<Config>();
  const [error, setError] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setError(undefined);
    void api.storageCacheStatus().then(value => {if (active) setConfig(value.config);}, caught => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {active = false;};
  }, [api, reload]);
  React.useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {if (dirty) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const save = async () => {
    if (!config) return;
    setSaving(true); setError(undefined); setSaved(false);
    try {setConfig(await api.updateStorageCacheConfig(config)); setDirty(false); setSaved(true);}
    catch (caught) {setError(caught instanceof Error ? caught.message : String(caught));}
    finally {setSaving(false);}
  };
  const input = (key: keyof Omit<Config, 'revision' | 'hardLimits'>, label: string) => <Form.Input
    id={`cache-${key}`} label={label} type="number" required min={0} step={1}
    max={key === 'storageMinFreePercent' ? 100 : undefined} value={config![key]}
    onChange={(_, data) => {setConfig({...config!, [key]: Number(data.value)}); setDirty(true); setSaved(false);}} />;
  return <div className="self-hosted-cache-settings">
    <Prompt when={dirty} message="放弃未保存的缓存设置修改？" />
    {error && <Message error role="alert" content={error} />}
    {saved && <Message positive role="status" content="已保存" />}
    {!config ? <Segment loading={!error} style={{minHeight: '8em'}}>
      {error && <Button onClick={() => setReload(value => value + 1)}>重试</Button>}
    </Segment> : <Form onSubmit={() => void save()} loading={saving}>
      <Segment>
        <Header as="h2">缓存额度</Header>
        <Form.Group widths="equal">
          {input('publishedCacheMaxBytes', '发布缓存额度（字节）')}
          {input('pendingReviewMaxBytes', '待审核总额度（字节）')}
          {input('pendingReviewCommitteeMaxBytes', '单委员会待审核额度（字节）')}
        </Form.Group>
      </Segment>
      <Segment>
        <Header as="h2">可用空间预留</Header>
        <Form.Group widths="equal">
          {input('storageMinFreeBytes', '最低可用空间（字节）')}
          {input('storageMinFreePercent', '最低可用空间（%）')}
        </Form.Group>
      </Segment>
      <Button primary disabled={saving || !dirty}>保存缓存配置</Button>
    </Form>}
  </div>;
}

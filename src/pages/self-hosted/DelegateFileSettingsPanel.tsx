import * as React from 'react';
import {Prompt} from 'react-router-dom';
import type {DefaultFileRejectionSettings, DelegateFileSettings, DelegateFileType} from '@quorum/contracts';
import {Button, Form, Header, Message, Modal, Segment} from 'semantic-ui-react';
import {selfHostedApi, type SelfHostedApi} from '../../services/self-hosted-api';

const FILE_TYPES: Array<[DelegateFileType, string]> = [
  ['WORKING_PAPER', '工作文件'], ['DIRECTIVE_DRAFT', '指令草案'], ['RESOLUTION_DRAFT', '决议草案']
];

export function DelegateFileSettingsPanel({committeeId, api = selfHostedApi, readOnly = false}: {
  committeeId?: string; api?: SelfHostedApi; readOnly?: boolean;
}) {
  const [settings, setSettings] = React.useState<DefaultFileRejectionSettings | DelegateFileSettings>();
  const [extensions, setExtensions] = React.useState<Record<string, string>>({});
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState(''); const [saved, setSaved] = React.useState(false);
  const [dirty, setDirty] = React.useState(false); const [reload, setReload] = React.useState(false);
  const load = React.useCallback(async () => {
    setWorking(true); setError('');
    try {
      const next = committeeId ? await api.getDelegateFileSettings(committeeId) : await api.getDefaultFileRejectionTypes();
      setSettings(next); setDirty(false); setSaved(false);
      if (committeeId) setExtensions(Object.fromEntries(FILE_TYPES.map(([type]) => [type, (next as DelegateFileSettings).allowedExtensions[type].join(', ')])));
    } catch (caught) {setError(caught instanceof Error ? caught.message : String(caught));}
    finally {setWorking(false);}
  }, [api, committeeId]);
  React.useEffect(() => {void load();}, [load]);
  React.useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {if (dirty) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const changed = () => {setDirty(true); setSaved(false);};
  const save = async () => {
    if (!settings) return;
    setWorking(true); setError(''); setSaved(false);
    try {
      const next = committeeId ? await api.updateDelegateFileSettings(committeeId, {...settings,
        allowedExtensions: Object.fromEntries(FILE_TYPES.map(([type]) => [type,
          [...new Set(extensions[type].split(/[,，、;；\s]+/).map(value => value.replace(/^\./, '').toLowerCase()).filter(Boolean))]])) as DelegateFileSettings['allowedExtensions']})
        : await api.updateDefaultFileRejectionTypes(settings);
      setSettings(next); setDirty(false); setSaved(true);
      if (committeeId) setExtensions(Object.fromEntries(FILE_TYPES.map(([type]) => [type, (next as DelegateFileSettings).allowedExtensions[type].join(', ')])));
    } catch (caught) {setError(caught instanceof Error ? caught.message : String(caught));}
    finally {setWorking(false);}
  };
  return <Segment className="delegate-file-settings" loading={working}>
    <Prompt when={dirty} message="放弃未保存的文件设置修改？" />
    <Header as="h2">{committeeId ? '驳回类型管理' : '默认驳回类型'}</Header>
    {!committeeId && <p>用于新建委员会。</p>}
    {error && <Message error content={error} />}
    {saved && <Message positive content="已保存" />}
    {settings && <Form onSubmit={() => void save()}>
      {settings.rejectionTypes.map((item, index) => <Segment key={item.id}>
        <Form.Group widths="equal">
          <Form.Input label="类型名称" aria-label={`类型名称 ${index + 1}`} required maxLength={100} value={item.label} disabled={readOnly}
            onChange={(_, data) => {const label = data.value; changed(); setSettings({...settings,
              rejectionTypes: settings.rejectionTypes.map(row => row.id === item.id ? {...row, label} : row)});}} />
          <Form.Select label="提示方式" value={item.custom ? 'custom' : 'preset'} disabled={readOnly} options={[
            {key: 'preset', value: 'preset', text: '固定消息'}, {key: 'custom', value: 'custom', text: '主席自行输入'}]}
            onChange={(_, data) => {changed(); setSettings({...settings, rejectionTypes: settings.rejectionTypes.map(row =>
              row.id === item.id ? {...row, custom: data.value === 'custom'} : row)});}} />
        </Form.Group>
        {!item.custom && <Form.TextArea label="代表端提示消息" aria-label={`代表端提示消息 ${index + 1}`} required maxLength={2000}
          value={item.message} disabled={readOnly} onChange={(_, data) => {const message = String(data.value); changed(); setSettings({...settings,
            rejectionTypes: settings.rejectionTypes.map(row => row.id === item.id ? {...row, message} : row)});}} />}
        {!readOnly && <Button type="button" basic negative size="small" disabled={settings.rejectionTypes.length === 1}
          onClick={() => {changed(); setSettings({...settings, rejectionTypes: settings.rejectionTypes.filter(row => row.id !== item.id)});}}>删除类型</Button>}
      </Segment>)}
      {!readOnly && <Button type="button" basic icon="plus" content="添加驳回类型" disabled={settings.rejectionTypes.length >= 30}
        onClick={() => {changed(); setSettings({...settings, rejectionTypes: [...settings.rejectionTypes,
          {id: crypto.randomUUID(), label: '', message: '', custom: false}]});}} />}
      {committeeId && <>
        <Header as="h2">文件格式设置</Header>
        {FILE_TYPES.map(([type, label]) => <Form.Input key={type} id={`file-extensions-${type}`} label={`${label}允许的后缀名`} value={extensions[type] ?? ''}
          disabled={readOnly} required placeholder="docx, doc, pdf" onChange={(_, data) => {changed(); setExtensions({...extensions, [type]: data.value});}} />)}
      </>}
      <div className="delegate-file-settings-actions">
        {!readOnly && <Button primary disabled={working || !dirty}>保存设置</Button>}
        <Button type="button" disabled={working} onClick={() => dirty ? setReload(true) : void load()}>重新载入</Button>
      </div>
    </Form>}
    {!settings && !working && <Button onClick={() => void load()}>重试</Button>}
    <Modal size="tiny" open={reload} onClose={() => setReload(false)}><Modal.Header>放弃未保存的修改？</Modal.Header>
      <Modal.Actions><Button onClick={() => setReload(false)}>继续编辑</Button><Button negative onClick={() => {setReload(false); void load();}}>放弃修改</Button></Modal.Actions></Modal>
  </Segment>;
}

import * as React from 'react';
import {useHistory} from 'react-router-dom';
import {Button, Card, Form, Icon, Label, Message, Modal, Table} from 'semantic-ui-react';
import {parseCrisisNoticeName, suggestCrisisNoticeName, type CommitteeWorkspaceSnapshot, type CrisisNoticePreview, type DelegateReviewFile} from '@quorum/contracts';
import {t} from '../../i18n';
import {type SelfHostedApi, SelfHostedApiError} from '../../services/self-hosted-api';
import {storageErrorText} from './FilesPanel';

export default function CrisisNoticeReviewCard({file,snapshot,api,refresh,download,downloading}: {
  file: DelegateReviewFile; snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi; refresh(): Promise<void>;
  download(id: string): Promise<void>; downloading?: string;
}) {
  const history=useHistory(); const manuallyEdited=React.useRef(file.crisisNameEdited===true);
  const suggestion=suggestCrisisNoticeName(snapshot.crises ?? [],snapshot.meetingSession?.ordinal ?? 1,snapshot.nextCrisisGroupOrdinal ?? 1,snapshot.committee.committeeLanguage);
  const [name,setName]=React.useState(file.crisisNameEdited ? file.logicalName : suggestion);
  const [focused,setFocused]=React.useState(false); const [working,setWorking]=React.useState(false);
  const [failure,setFailure]=React.useState<unknown>(); const [retry,setRetry]=React.useState(0);
  const [checked,setChecked]=React.useState<{name: string; revision: number; preview: CrisisNoticePreview}>();
  const [replacing,setReplacing]=React.useState(false); const input=React.useRef<HTMLInputElement>(null);
  const sequence=React.useRef(0); const readOnly=snapshot.committee.status!=='ACTIVE';
  React.useEffect(()=> {
    if (file.crisisNameEdited && !manuallyEdited.current) {manuallyEdited.current=true;setName(file.logicalName);}
  },[file.crisisNameEdited,file.logicalName]);
  React.useEffect(()=> {if (!manuallyEdited.current && !focused) setName(suggestion);},[suggestion,focused]);
  React.useEffect(()=> {
    if (focused || readOnly) return;
    const request=++sequence.current;setChecked(undefined);setFailure(undefined);
    const verify=async()=> {
      let revision=file.revision;
      if (name.trim()!==file.logicalName || manuallyEdited.current && !file.crisisNameEdited) {
        revision=(await api.saveCrisisNoticeName(file.id,revision,name,manuallyEdited.current)).revision;
        await refresh();
      }
      const preview=await api.previewCrisisNotice(file.id);
      if(request===sequence.current) setChecked({name,revision,preview});
    };
    void verify().catch(error=> {if(request===sequence.current) setFailure(error);});
    return ()=> {++sequence.current;};
  },[api,file.id,file.revision,file.logicalName,file.crisisNameEdited,name,focused,readOnly,retry,refresh]);
  const valid=parseCrisisNoticeName(name)!==null;
  const enabled=!readOnly && !focused && !working && checked?.name===name && checked.revision===file.revision;
  const importNotice=async(replaceNoticeId?: string)=> {
    if (!checked || working) return;
    setWorking(true);setFailure(undefined);
    try {
      const result=await api.importCrisisNotice(file.id,checked.revision,replaceNoticeId);
      setReplacing(false); history.push(`/committees/${snapshot.committee.id}/crises/${result.groupId}`);
    } catch(error) {setFailure(error);setChecked(undefined);} finally {setWorking(false);}
  };
  const correctable=failure instanceof SelfHostedApiError && failure.localization?.reason?.startsWith('CRISIS_NUMBER')
    || failure instanceof SelfHostedApiError && failure.localization?.reason==='CRISIS_SESSION_MISSING';
  return <Card fluid className="delegate-file-card motion-card crisis-notice-review-card"><Card.Content>
    <div className="motion-heading delegate-file-heading"><Card.Header><Form onSubmit={event=>event.preventDefault()}>
      <Form.Input fluid aria-label={t('File name')} value={name} error={!valid || Boolean(failure)} disabled={working || readOnly}
        input={{ref:input}} onFocus={()=> {setFocused(true);++sequence.current;setChecked(undefined);}}
        onChange={event=> {manuallyEdited.current=true;setName(event.currentTarget.value);setFailure(undefined);setChecked(undefined);}}
        onBlur={()=> {setFocused(false);setRetry(current=>current+1);}} />
      {!valid && <div className="file-name-conflict-hint">{t('Complete crisis number')}</div>}
    </Form></Card.Header><Label basic color="blue" icon="clock outline" className="self-hosted-file-status" content={t('Pending review')} /></div>
    {Boolean(failure) && <Message error><p>{storageErrorText(failure)}</p><Button basic onClick={()=>correctable ? input.current?.focus() : setRetry(current=>current+1)}>{t(correctable ? 'Correct file name' : 'Retry')}</Button></Message>}
    <Card.Meta><Table compact celled unstackable className="motion-metadata-table delegate-file-metadata"><Table.Body>
      <Table.Row><Table.Cell className="motion-metadata-key">{t('File source')}</Table.Cell><Table.Cell>{t('Chair')}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">{t('File type')}</Table.Cell><Table.Cell>{t('Crisis notice')}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">{t('Submitted at')}</Table.Cell><Table.Cell>{file.submittedAt ? new Date(file.submittedAt).toLocaleString() : '—'}</Table.Cell></Table.Row>
      <Table.Row><Table.Cell className="motion-metadata-key">{t('Original file')}</Table.Cell><Table.Cell>{file.originalName}</Table.Cell></Table.Row>
    </Table.Body></Table></Card.Meta>
  </Card.Content><Card.Content extra className="delegate-file-review-actions">
    <Button primary fluid loading={downloading===file.id} disabled={Boolean(downloading)} onClick={()=>void download(file.id)}>{t('Download file')} <Icon name="arrow down" /></Button>
    <Button primary fluid loading={working} disabled={!enabled || !valid} onClick={()=>checked?.preview.replacement ? setReplacing(true) : void importNotice()}>{t('Crisis')} <Icon name="arrow right" /></Button>
  </Card.Content>
    <Modal size="tiny" open={replacing} onClose={()=>setReplacing(false)} closeOnDimmerClick={!working} closeOnEscape={!working}>
      <Modal.Header>{t('Replace notice')}</Modal.Header><Modal.Content><p>{checked?.preview.replacement?.logicalName}</p>
        <Icon name="arrow down" /><p>{name}</p>{Boolean(failure) && <Message error content={storageErrorText(failure)} />}
      </Modal.Content><Modal.Actions><Button disabled={working} onClick={()=>setReplacing(false)}>{t('Cancel')}</Button>
        <Button primary loading={working} disabled={working} onClick={()=>void importNotice(checked?.preview.replacement?.id)}>{t('Replace notice')}</Button>
      </Modal.Actions></Modal>
  </Card>;
}

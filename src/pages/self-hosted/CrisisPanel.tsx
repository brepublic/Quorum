import * as React from 'react';
import {useHistory} from 'react-router-dom';
import {Button, Card, Form, Icon, Input, Label, Message, Modal} from 'semantic-ui-react';
import {parseCrisisNoticeName, type CommitteeWorkspaceSnapshot, type CrisisGroup, type CrisisUpdate, type DelegateReviewFile} from '@quorum/contracts';
import {t, useLanguage} from '../../i18n';
import {newIdempotencyKey, type SelfHostedApi} from '../../services/self-hosted-api';
import {TimerControls} from './ProceedingsPanel';
import {storageErrorText} from './FilesPanel';

const numberFor = (group: CrisisGroup, update?: CrisisUpdate) => `${group.sessionOrdinal}.${group.ordinal}${update ? `.${update.ordinal}` : ''}`;
const statusLabels = {UNPUBLISHED: 'Unpublished',PENDING: 'Awaiting action',SUPERSEDED: 'Superseded by update',ENDED: 'Ended'};

export default function CrisisPanel({snapshot,api,run,canChair,resourceId}: {
  snapshot: CommitteeWorkspaceSnapshot; api: SelfHostedApi; run(operation: () => Promise<unknown>): Promise<void>; canChair: boolean; resourceId: string;
}) {
  useLanguage(); const history = useHistory(); const [files,setFiles] = React.useState<DelegateReviewFile[]>([]);
  const [failure,setFailure] = React.useState<unknown>(); const [creating,setCreating] = React.useState(false);
  const createKey = React.useRef(newIdempotencyKey()); const createOnce = React.useRef(false);
  const editable = canChair && snapshot.committee.status === 'ACTIVE';
  const create = React.useCallback(async () => {
    if (!editable || snapshot.meetingSession?.status !== 'OPEN') return;
    setCreating(true);
    try {await run(async () => {
      const group = await api.createCrisis(snapshot.committee.id,snapshot.meetingSession!.id,createKey.current);
      history.replace(`/committees/${snapshot.committee.id}/crises/${group.id}`);
    });} finally {setCreating(false);}
  },[api,editable,history,run,snapshot.committee.id,snapshot.meetingSession]);
  React.useEffect(() => {
    if (resourceId!=='new') {createOnce.current=false;createKey.current=newIdempotencyKey();return;}
    if (resourceId === 'new' && !createOnce.current) {createOnce.current=true; void create();}
  },[resourceId,create]);
  React.useEffect(() => {
    if (!editable) return;
    let active=true;
    void api.listDelegateReviewFiles(snapshot.committee.id).then(next => {if (active) {setFiles(next);setFailure(undefined);}})
      .catch(error=> {if(active) setFailure(error);});
    return ()=> {active=false;};
  },[api,editable,snapshot.committee.id,snapshot.sync.committeeEventSequence]);
  if (resourceId === 'new') return <Button fluid primary loading={creating} disabled={creating || !editable || snapshot.meetingSession?.status !== 'OPEN'} onClick={()=>void create()}>{t('New crisis')}</Button>;
  const group = snapshot.crises?.find(group=>group.id===resourceId);
  if (!group) return <Message content={t('Crisis not found.')} />;
  const pending = group.updates.some(update=>update.status==='PENDING');
  return <div className="crisis-panel">
    {Boolean(failure) && <Message error content={storageErrorText(failure)} />}
    <TimerControls key={`${group.timer.id}:${group.updates.find(update=>update.publishedAt)?.id ?? ''}`}
      name="Crisis timer" timer={group.timer} run={run} api={api} canChair={editable && !group.endedAt && pending} />
    <Button basic color="blue" fluid disabled={!editable || Boolean(group.endedAt) || group.updates.some(update=>update.status==='UNPUBLISHED')}
      onClick={()=>void run(()=>api.createCrisisUpdate(group.id,group.revision))}><Icon name="plus" />{t('Update crisis')}</Button>
    <div className="crisis-card-list">{group.updates.map(update=><CrisisCard key={update.id} group={group} card={update} files={files} api={api}
      run={run} editable={editable && !group.endedAt && update.status==='UNPUBLISHED'} />)}</div>
  </div>;
}

function CrisisCard({group,card,files,api,run,editable}: {
  group: CrisisGroup; card: CrisisUpdate; files: DelegateReviewFile[]; api: SelfHostedApi;
  run(operation: ()=>Promise<unknown>): Promise<void>; editable: boolean;
}) {
  const fromCard = (value: CrisisUpdate) => ({title: value.title,minutes: value.handlingDurationMs === null ? '' : String(value.handlingDurationMs/60000),
    fileId: value.notice?.id ?? null,revision: value.revision});
  const [draft,setDraft] = React.useState(()=>fromCard(card)); const previous = React.useRef(card);
  const [working,setWorking] = React.useState(false); const [replacement,setReplacement] = React.useState<string>();
  const workingRef=React.useRef(false);
  const [failure,setFailure] = React.useState<unknown>(); const attempt = React.useRef<{revision: number; key: string}>();
  const dirty = draft.title!==card.title || draft.minutes!==fromCard(card).minutes || draft.fileId!==(card.notice?.id ?? null);
  React.useEffect(()=> {
    const before=fromCard(previous.current);
    setDraft(current => current.revision===card.revision ? current : current.title===before.title && current.minutes===before.minutes && current.fileId===before.fileId ? fromCard(card) : current);
    previous.current=card;
  },[card]);
  const validTime = Number(draft.minutes)>0 && Number.isSafeInteger(Number(draft.minutes)*60000);
  const matches = (file: DelegateReviewFile) => {
    const n=parseCrisisNoticeName(file.logicalName);
    return file.fileType==='CRISIS_NOTICE' && ['UPLOAD_COMPLETE','PENDING_REVIEW'].includes(file.status)
      && n?.sessionOrdinal===group.sessionOrdinal && n.groupOrdinal===group.ordinal && n.updateOrdinal===card.ordinal;
  };
  const choices=files.filter(matches);
  const save = async (fileId=draft.fileId,replaceNoticeId?: string) => {
    if (!dirty && fileId===draft.fileId) return card;
    const saved=await api.updateCrisisCard(card.id,{baseRevision: draft.revision,title: draft.title,
      handlingDurationMs: draft.minutes==='' ? null : Number(draft.minutes)*60000,fileId,replaceNoticeId});
    const next=saved.updates.find(update=>update.id===card.id)!; setDraft(fromCard(next)); return next;
  };
  const perform = async (operation: ()=>Promise<unknown>) => {
    if (workingRef.current) return; workingRef.current=true;setWorking(true);
    try {await run(operation);} finally {workingRef.current=false;setWorking(false);}
  };
  const autosave = () => {if (editable && dirty && (!draft.minutes || validTime)) void perform(()=>save());};
  const publish = () => perform(async ()=> {
    const saved = await save();
    if (attempt.current?.revision!==saved.revision) attempt.current={revision: saved.revision,key: newIdempotencyKey()};
    await api.publishCrisis(card.id,saved.revision,attempt.current.key);
  });
  const download = async () => {
    if (!card.notice) return;
    setWorking(true);setFailure(undefined);
    try {
      let state=await api.prepareFileDownload(card.notice.id);
      while (state.status==='PREPARING') {await new Promise(resolve=>window.setTimeout(resolve,(state.retryAfterSeconds ?? 2)*1000)); state=await api.fileDownloadReadiness(card.notice.id);}
      if (state.status!=='READY') throw new Error('File unavailable');
      window.location.assign(api.fileDownloadUrl(card.notice.id));
    } catch(error) {setFailure(error);} finally {setWorking(false);}
  };
  return <Card fluid className="crisis-card motion-card"><Card.Content>
    <div className="motion-heading crisis-card-heading"><Card.Header className="crisis-card-title"><strong>{t('Crisis')} {numberFor(group,card)}</strong>
      {editable ? <Input fluid aria-label={t('Crisis title')} placeholder={t('Title')} value={draft.title} disabled={working}
        onChange={event=> {const title=event.currentTarget.value;setDraft(current=>({...current,title}));}} onBlur={autosave} /> : card.title && <span> — {card.title}</span>}
    </Card.Header><Label basic color={card.status==='PENDING' ? 'orange' : card.status==='UNPUBLISHED' ? 'blue' : card.status==='ENDED' ? 'green' : 'grey'}>{t(statusLabels[card.status])}</Label></div>
    {Boolean(failure) && <Message error content={storageErrorText(failure)} />}
    {editable ? <Form>
      <Form.Select fluid selection label={t('Crisis notice')} aria-label={t('Crisis notice')} value={draft.fileId ?? ''} disabled={working}
        options={choices.map(file=>({key:file.id,value:file.id,text:file.logicalName,description:file.originalName}))}
        onChange={(_,data)=> {
          const id=String(data.value);
          if (card.notice && id!==card.notice.id) setReplacement(id);
          else {setDraft(current=>({...current,fileId:id})); void perform(()=>save(id));}
        }} />
      <Form.Input fluid type="number" step="any" min={0} label={t('Handling time (minutes)')} aria-label={t('Handling time (minutes)')}
        value={draft.minutes} error={Boolean(draft.minutes && !validTime)} disabled={working}
        onChange={event=> {const minutes=event.currentTarget.value;setDraft(current=>({...current,minutes}));}} onBlur={autosave} />
      <Button type="button" positive fluid loading={working} disabled={working || !validTime || !draft.fileId || !choices.some(file=>file.id===draft.fileId)} onClick={()=>void publish()}>{t('Publish crisis')}</Button>
    </Form> : <><p className="crisis-notice-name">{card.notice?.logicalName ?? '—'}</p>
      {card.handlingDurationMs!==null && <p>{t('Handling time (minutes)')}: {card.handlingDurationMs/60000}</p>}
      {card.notice && <Button fluid primary loading={working} disabled={working || card.notice.status==='DELETED'} onClick={()=>void download()}>{t('Download file')} <Icon name="arrow down" /></Button>}</>}
  </Card.Content>
    <Modal size="tiny" open={Boolean(replacement)} onClose={()=>setReplacement(undefined)} closeOnDimmerClick={!working} closeOnEscape={!working}>
      <Modal.Header>{t('Replace notice')}</Modal.Header><Modal.Content>
        <strong>{t('Current notice')}</strong><p>{card.notice?.logicalName}</p><p>{files.find(file=>file.id===card.notice?.id)?.originalName}</p>
        <strong>{t('New notice')}</strong><p>{files.find(file=>file.id===replacement)?.logicalName}</p><p>{files.find(file=>file.id===replacement)?.originalName}</p>
      </Modal.Content><Modal.Actions><Button disabled={working} onClick={()=>setReplacement(undefined)}>{t('Cancel')}</Button>
        <Button primary loading={working} disabled={working} onClick={()=>void perform(async()=> {await save(replacement,card.notice?.id);setReplacement(undefined);})}>{t('Replace notice')}</Button>
      </Modal.Actions></Modal>
  </Card>;
}

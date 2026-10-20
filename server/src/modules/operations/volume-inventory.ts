import {createHash, randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {safeDownloadHeaders} from '../storage/file-service.js';
import {lstat, readdir} from 'node:fs/promises';
import type {Pool, PoolClient} from 'pg';
import type {ServerVolumeFile, ServerVolumeInventory, ServerVolumeCleanup} from '@quorum/contracts';
import {AppError} from '../../http/errors.js';
import type {AuthenticatedSession} from '../identity/store.js';
import {audit, transaction, type Stage4Context} from '../stage4/database.js';
import {assertExactBody} from '../stage4/validation.js';
import {readVolumePolicy, withVolumeLock} from '../storage/volume-policy.js';
import type {ServerVolumeStore} from '../storage/server-volume.js';
import {requireVolumeAdmin} from './volume-service.js';
import type {Logger} from '../../logger.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value==='object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
type InventoryEntry = ServerVolumeFile & {storageKey: string};
const publicFile = ({storageKey: _key, ...file}: InventoryEntry): ServerVolumeFile => file;

export class ServerVolumeInventoryService {
  constructor(private readonly pool: Pool, private readonly volume: ServerVolumeStore) {}

  private async inventory(client: Pool | PoolClient): Promise<InventoryEntry[]> {
    const rows = await client.query(`SELECT b.id,b.storage_key,b.size_bytes,b.durability_state,b.admin_cleared_at,
      s.status AS binding_status,c.id AS committee_id,c.name AS committee_name,c.status AS committee_status,u.email AS owner_email,
      coalesce(refs.files,'[]'::jsonb) AS files,coalesce(refs.other_copy,false) AS other_copy
      FROM file_blobs b JOIN storage_bindings s ON s.id=b.storage_binding_id
      JOIN committees c ON c.id=b.committee_id LEFT JOIN users u ON u.id=c.owner_user_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('fileId',v.file_entry_id,'name',e.logical_name,'version',v.version_number)
          ORDER BY v.file_entry_id,v.version_number) AS files,
          bool_and(EXISTS (SELECT 1 FROM file_blobs alternative JOIN storage_bindings ab ON ab.id=alternative.storage_binding_id
            WHERE alternative.durability_state='COMMITTED' AND ab.provider_type<>'SERVER_VOLUME'
            AND ab.id=c.active_storage_binding_id AND (alternative.id=v.blob_id OR alternative.id IN
              (SELECT copy_blob_id FROM file_blob_copies WHERE content_blob_id=v.blob_id)))) AS other_copy
        FROM file_versions v JOIN file_entries e ON e.id=v.file_entry_id
        WHERE v.blob_id=b.id OR v.blob_id IN (SELECT content_blob_id FROM file_blob_copies WHERE copy_blob_id=b.id)
      ) refs ON true WHERE s.provider_type='SERVER_VOLUME' ORDER BY b.storage_key`);
    const disk = new Map<string, {size: number; modified: number}>();
    // Never traverse a symbolic link or leave this provider's root. Upload and
    // download caches are separate stores and are deliberately not scanned.
    const walk = async (prefix: string): Promise<void> => {
      const path = prefix ? this.volume.pathForKey(prefix) : this.volume.rootPath;
      const root = await lstat(path); if (!root.isDirectory() || root.isSymbolicLink()) return;
      for (const entry of await readdir(path, {withFileTypes: true})) {
        const key = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!/^[a-z0-9][a-z0-9/_-]*$/.test(key)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(key);
        else if (entry.isFile()) {
          try {const stat = await lstat(this.volume.pathForKey(key));
            if (stat.isFile() && !stat.isSymbolicLink()) disk.set(key,{size:stat.size,modified:stat.mtimeMs});
          } catch(error) {if (!missing(error)) throw error;}
        }
      }
    };
    await walk('');
    const result: InventoryEntry[] = [];
    for (const row of rows.rows) {
      const stat = disk.get(row.storage_key); disk.delete(row.storage_key);
      if (!stat && row.durability_state === 'DELETED') continue;
      result.push({id:fingerprint(row.storage_key),storageKey:row.storage_key,blobId:row.id,
        committeeId:row.committee_id,committeeName:row.committee_name,ownerEmail:row.owner_email ?? null,committeeStatus:row.committee_status,
        bindingStatus:row.binding_status,path:this.volume.pathForKey(row.storage_key),sizeBytes:stat?.size ?? Number(row.size_bytes),
        present:Boolean(stat),modifiedAt:stat?.modified ?? null,state:row.durability_state,
        hasOtherCopy:row.other_copy,references:row.files});
    }
    // Failed commits can have durable bytes before their blob metadata exists.
    // Associate them through the server-generated upload key so archive cleanup
    // includes those bytes without touching the independent staging file.
    const uploads = disk.size ? await client.query(`SELECT u.provider_storage_key,c.id,c.name,c.status,owner.email AS owner_email FROM file_uploads u
      JOIN committees c ON c.id=u.committee_id LEFT JOIN users owner ON owner.id=c.owner_user_id JOIN storage_bindings s ON s.id=u.storage_binding_id
      WHERE u.provider_storage_key=ANY($1::text[]) AND s.provider_type='SERVER_VOLUME'`,[[...disk.keys()]]) : {rows:[]};
    for (const [key,stat] of disk) {
      const owner=uploads.rows.find(row=>row.provider_storage_key===key);
      result.push({id:fingerprint(key),storageKey:key,blobId:null,committeeId:owner?.id ?? null,
        committeeName:owner?.name ?? null,ownerEmail:owner?.owner_email ?? null,committeeStatus:owner?.status ?? null,bindingStatus:null,path:this.volume.pathForKey(key),sizeBytes:stat.size,
        present:true,modifiedAt:stat.modified,state:'UNTRACKED',hasOtherCopy:false,references:[]});
    }
    const pending = await client.query(`SELECT i.storage_key FROM server_volume_cleanup_items i
      JOIN server_volume_cleanup_batches b ON b.id=i.batch_id WHERE b.status='RUNNING' AND i.status<>'COMPLETED'`);
    const pendingKeys = new Set(pending.rows.map(row => row.storage_key));
    for (const file of result) if (pendingKeys.has(file.storageKey)) file.state = 'DELETE_PENDING';
    return result.sort((a,b)=>a.path.localeCompare(b.path));
  }

  async list(auth: AuthenticatedSession, query: URLSearchParams): Promise<ServerVolumeInventory> {
    requireVolumeAdmin(auth);
    const page = Math.max(1,Math.floor(Number(query.get('page')) || 1));
    const term = (query.get('search') ?? '').toLocaleLowerCase();
    const files = (await this.inventory(this.pool)).filter(file => (!query.get('status') || file.committeeStatus===query.get('status'))
      && (!term || [file.ownerEmail,file.committeeName,file.path,...file.references.map(ref=>ref.name)].join(' ').toLocaleLowerCase().includes(term)));
    return {files:files.slice((page-1)*25,page*25).map(publicFile),page,total:files.length,
      totalBytes:files.reduce((sum,file)=>sum+(file.present?file.sizeBytes:0),0),rootPath:this.volume.rootPath};
  }

  async download(auth: AuthenticatedSession, id: string) {
    requireVolumeAdmin(auth);
    if (!/^[a-f0-9]{64}$/.test(id)) throw new AppError({code:'VALIDATION_FAILED',reason:'CLIENT_REQUEST_INVALID',message:'Invalid volume file ID.'});
    const file = (await this.inventory(this.pool)).find(item => item.id === id);
    if (!file?.present || file.state === 'DELETE_PENDING') throw new AppError({code:'NOT_FOUND',message:'File not available.'});
    const metadata = file.blobId ? (await this.pool.query(`SELECT b.size_bytes,encode(b.sha256,'hex') AS sha256,
      (SELECT v.original_name FROM file_versions v WHERE v.blob_id=b.id OR v.blob_id IN
        (SELECT content_blob_id FROM file_blob_copies WHERE copy_blob_id=b.id)
        ORDER BY v.created_at,v.id LIMIT 1) AS original_name
      FROM file_blobs b WHERE b.id=$1`,[file.blobId])).rows[0] : undefined;
    if (file.blobId && !metadata) throw new AppError({code:'NOT_FOUND',message:'File not available.'});
    let opened;
    try {
      opened = await this.volume.openDownload(file.storageKey,metadata
        ? {sizeBytes:Number(metadata.size_bytes),sha256:metadata.sha256} : undefined);
    } catch (error) {
      if (missing(error)) throw new AppError({code:'NOT_FOUND',message:'File not available.'});
      throw error;
    }
    return {content:opened.content,headers:safeDownloadHeaders({currentVersion:{
      originalName:metadata?.original_name ?? basename(file.storageKey),
      mediaType:'application/octet-stream',sizeBytes:opened.sizeBytes}})};
  }

  async preview(auth: AuthenticatedSession, body: Record<string,unknown>, context: Stage4Context): Promise<ServerVolumeCleanup> {
    requireVolumeAdmin(auth); assertExactBody(body,['scope','fileId']);
    if (!['ALL','ARCHIVED','SELECTED'].includes(String(body.scope)) || (body.scope==='SELECTED'
      && (typeof body.fileId!=='string' || !/^[a-f0-9]{64}$/.test(body.fileId)))) {
      throw new AppError({code:'VALIDATION_FAILED',reason:'CLIENT_REQUEST_INVALID',message:'Choose a cleanup scope or a file.'});
    }
    return withVolumeLock(this.pool,true,()=>transaction(this.pool,async client=>{
      if (body.scope!=='SELECTED' && !(await readVolumePolicy(client)).disabled) throw new AppError({code:'FORBIDDEN',
        reason:'SERVER_VOLUME_DISABLE_FIRST',message:'Disable server volume storage before bulk cleanup.'});
      const files = (await this.inventory(client)).filter(file=>body.scope==='ALL'
        || (body.scope==='ARCHIVED' && file.committeeStatus==='ARCHIVED') || (body.scope==='SELECTED' && file.id===body.fileId));
      if (body.scope==='SELECTED' && !files.length) throw new AppError({code:'NOT_FOUND',message:'File not found.'});
      const id=randomUUID();
      await client.query('INSERT INTO server_volume_cleanup_batches(id,requested_by_user_id,scope) VALUES($1,$2,$3)',[id,auth.user.id,body.scope]);
      for (const file of files) await client.query(`INSERT INTO server_volume_cleanup_items
        (id,batch_id,storage_key,blob_id,committee_id,file_snapshot) VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(),id,file.storageKey,file.blobId,file.committeeId,publicFile(file)]);
      await audit(client,context,{actorUserId:auth.user.id,capabilities:['SYSTEM_ADMIN'],action:'storage.volume_cleanup_previewed',
        resourceType:'server_volume_cleanup',resourceId:id,after:{scope:body.scope,count:files.length}});
      return {...await this.batch(client,id),files:files.map(publicFile)};
    }));
  }

  async confirm(auth: AuthenticatedSession, id: string, body: Record<string,unknown>, context: Stage4Context): Promise<ServerVolumeCleanup> {
    requireVolumeAdmin(auth); assertExactBody(body,['confirmed']);
    if (body.confirmed!==true) throw new AppError({code:'VALIDATION_FAILED',reason:'CLIENT_REQUEST_INVALID',message:'Confirm deletion first.'});
    return withVolumeLock(this.pool,true,()=>transaction(this.pool,async client=>{
      const result=await client.query('SELECT * FROM server_volume_cleanup_batches WHERE id=$1 FOR UPDATE',[id]);
      const row=result.rows[0];
      if (!row || row.requested_by_user_id!==auth.user.id) throw new AppError({code:'NOT_FOUND',message:'Cleanup not found.'});
      if (row.status!=='PREVIEW') return this.batch(client,id);
      if (Date.now()-row.created_at.getTime()>30*60*1000) throw new AppError({code:'REVISION_CONFLICT',message:'Cleanup preview expired.'});
      if (row.scope!=='SELECTED' && !(await readVolumePolicy(client)).disabled) throw new AppError({code:'FORBIDDEN',
        reason:'SERVER_VOLUME_DISABLE_FIRST',message:'Disable server volume storage before bulk cleanup.'});
      const items=await client.query('SELECT * FROM server_volume_cleanup_items WHERE batch_id=$1 ORDER BY storage_key',[id]);
      // Lock affected committees before rechecking archive state and references.
      const ids=[...new Set(items.rows.map(item=>item.committee_id).filter(Boolean))].sort();
      if(ids.length) await client.query('SELECT id FROM committees WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids]);
      const current=await this.inventory(client);
      const wanted=current.filter(file=>row.scope==='ALL' || (row.scope==='ARCHIVED' && file.committeeStatus==='ARCHIVED')
        || (row.scope==='SELECTED' && items.rows.some(item=>item.storage_key===file.storageKey)));
      if (wanted.length!==items.rows.length || items.rows.some(item=>{
        const file=wanted.find(value=>value.storageKey===item.storage_key);
        return !file || fingerprint(publicFile(file))!==fingerprint(item.file_snapshot);
      })) throw new AppError({code:'REVISION_CONFLICT',message:'Files changed. Preview cleanup again.'});
      const blobIds=items.rows.map(item=>item.blob_id).filter(Boolean);
      // Cancel only migrations using the selected physical copies. Completed
      // target copies remain available; unrelated provider data is never deleted.
      const migrations=await client.query(`UPDATE storage_migrations m SET status='CANCELLED',cancelled_at=now(),revision=revision+1,
        updated_at=now() WHERE m.status IN ('COPYING','READY_TO_CONFIRM','FAILED') AND EXISTS
        (SELECT 1 FROM storage_migration_items i WHERE i.migration_id=m.id AND
          (i.source_blob_id=ANY($1::uuid[]) OR i.target_blob_id=ANY($1::uuid[]))) RETURNING id`,[blobIds]);
      const migrationIds=migrations.rows.map(row=>row.id);
      await client.query(`UPDATE storage_agent_tasks SET status='CANCELLED',cancelled_at=now(),claimed_at=NULL,claim_token=NULL,
        revision=revision+1,updated_at=now() WHERE migration_item_id IN
        (SELECT id FROM storage_migration_items WHERE migration_id=ANY($1::uuid[])) AND status IN ('PENDING','IN_PROGRESS','RETRY')`,[migrationIds]);
      await client.query(`UPDATE storage_migration_items SET status='CANCELLED',claimed_at=NULL,claim_token=NULL,updated_at=now()
        WHERE migration_id=ANY($1::uuid[])`,[migrationIds]);
      await client.query(`UPDATE file_uploads SET status='CANCELLED',revision=revision+1,updated_at=now()
        WHERE status IN ('CREATED','RECEIVING','STAGED') AND provider_storage_key=ANY($1::text[])`,[items.rows.map(item=>item.storage_key)]);
      await client.query(`UPDATE file_blobs SET durability_state='DELETE_PENDING',admin_cleared_at=now(),updated_at=now()
        WHERE id=ANY($1::uuid[])`,[blobIds]);
      await client.query(`UPDATE committees SET file_manifest_revision=file_manifest_revision+1,revision=revision+1,updated_at=now()
        WHERE id=ANY($1::uuid[])`,[ids]);
      await client.query(`UPDATE server_volume_cleanup_batches SET status=$2,confirmed_at=now(),
        completed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE NULL END WHERE id=$1`,[id,items.rows.length?'RUNNING':'COMPLETED']);
      await audit(client,context,{actorUserId:auth.user.id,capabilities:['SYSTEM_ADMIN'],action:'storage.volume_cleanup_confirmed',
        resourceType:'server_volume_cleanup',resourceId:id,after:{scope:row.scope,count:items.rows.length}});
      return this.batch(client,id);
    }));
  }

  private async batch(client: Pool | PoolClient,id: string): Promise<ServerVolumeCleanup> {
    const result=await client.query(`SELECT b.id,b.scope,b.status,count(i.id)::int AS total,
      count(i.id) FILTER(WHERE i.status='COMPLETED')::int AS completed,
      count(i.id) FILTER(WHERE i.status='RETRY')::int AS failed,
      coalesce(sum(CASE WHEN (i.file_snapshot->>'present')::boolean THEN (i.file_snapshot->>'sizeBytes')::bigint ELSE 0 END),0) AS bytes,
      count(i.id) FILTER(WHERE NOT (i.file_snapshot->>'hasOtherCopy')::boolean)::int AS endangered,
      count(DISTINCT i.committee_id)::int AS committees
      FROM server_volume_cleanup_batches b LEFT JOIN server_volume_cleanup_items i ON i.batch_id=b.id
      WHERE b.id=$1 GROUP BY b.id`,[id]);
    const row=result.rows[0];if(!row) throw new AppError({code:'NOT_FOUND',message:'Cleanup not found.'});
    return {id:row.id,scope:row.scope,status:row.status,total:row.total,completed:row.completed,failed:row.failed,
      sizeBytes:Number(row.bytes),withoutOtherCopy:row.endangered,committeeCount:row.committees};
  }
  async batches(auth: AuthenticatedSession): Promise<ServerVolumeCleanup[]> {
    requireVolumeAdmin(auth);
    const rows=await this.pool.query("SELECT id FROM server_volume_cleanup_batches WHERE status<>'PREVIEW' ORDER BY created_at DESC LIMIT 20");
    return Promise.all(rows.rows.map(row=>this.batch(this.pool,row.id)));
  }
  async processNext(): Promise<boolean> {
    return withVolumeLock(this.pool,true,()=>transaction(this.pool,async client=>{
      await client.query(`UPDATE server_volume_cleanup_batches b SET status='COMPLETED',completed_at=now()
        WHERE status='RUNNING' AND NOT EXISTS(SELECT 1 FROM server_volume_cleanup_items i WHERE i.batch_id=b.id AND i.status<>'COMPLETED')`);
      const result=await client.query(`SELECT i.*,b.requested_by_user_id FROM server_volume_cleanup_items i JOIN server_volume_cleanup_batches b ON b.id=i.batch_id
        WHERE b.status='RUNNING' AND i.status<>'COMPLETED' AND i.next_attempt_at<=now() ORDER BY i.next_attempt_at,i.id
        FOR UPDATE OF i SKIP LOCKED LIMIT 1`);
      const item=result.rows[0];if(!item)return false;
      try {
        await this.volume.delete(item.storage_key);
      } catch(error) {
        await client.query(`UPDATE server_volume_cleanup_items SET status='RETRY',attempts=attempts+1,failure_code=$2,
          next_attempt_at=now()+(least(300,power(2,least(attempts+1,8)))::text||' seconds')::interval WHERE id=$1`,
        [item.id,(error as {failureCode?:string}).failureCode ?? 'SERVER_VOLUME_DELETE_FAILED']);
        return true;
      }
      await client.query(`UPDATE server_volume_cleanup_items SET status='COMPLETED',attempts=attempts+1,completed_at=now(),failure_code=NULL WHERE id=$1`,[item.id]);
      if(item.blob_id)await client.query("UPDATE file_blobs SET durability_state='DELETED',updated_at=now() WHERE id=$1",[item.blob_id]);
      await client.query(`UPDATE server_volume_cleanup_batches SET status='COMPLETED',completed_at=now() WHERE id=$1
        AND NOT EXISTS (SELECT 1 FROM server_volume_cleanup_items WHERE batch_id=$1 AND status<>'COMPLETED')`,[item.batch_id]);
      await audit(client,{requestId:item.id},{actorUserId:item.requested_by_user_id,capabilities:['SYSTEM_ADMIN'],action:'storage.volume_file_cleared',
        resourceType:'server_volume_cleanup',resourceId:item.batch_id,after:{itemId:item.id,blobId:item.blob_id}});
      return true;
    }));
  }
}
export function startServerVolumeCleanupWorker(service: ServerVolumeInventoryService,logger: Logger): () => void {
  let stopped=false;let running=false;
  const run=async()=>{if(stopped||running)return;running=true;
    try {for(let i=0;i<25&&!stopped;i++)if(!await service.processNext())break;}
    catch(error){logger.error('storage.volume_cleanup_failed',{error});}finally{running=false;}};
  const timer=setInterval(()=>void run(),2000);timer.unref();void run();
  return ()=>{stopped=true;clearInterval(timer);};
}

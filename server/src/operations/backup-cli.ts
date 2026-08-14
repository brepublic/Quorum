import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {chmod, mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';
import {loadConfig} from '../config.js';

const {Pool} = pg;

async function command(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(program, args, {env, stdio: ['ignore', 'inherit', 'inherit']});
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolveCommand() : reject(new Error(`${program} exited with ${code}`)));
  });
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function main(): Promise<void> {
  const targetArg = process.argv[2];
  if (!targetArg) throw new Error('Usage: backup <new-output-directory>');
  process.umask(0o077);
  const target = resolve(targetArg);
  await mkdir(target, {recursive: false, mode: 0o700});
  const databaseDump = resolve(target, 'database.dump');
  const fileManifest = resolve(target, 'file-manifest.jsonl');
  const metadataPath = resolve(target, 'backup-metadata.json');
  const config = loadConfig();
  const pool = new Pool({connectionString: config.databaseUrl, max: 1});
  try {
    await command('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${databaseDump}`],
      {...process.env, PGDATABASE: config.databaseUrl});
    const blobs = await pool.query<{record: Record<string, unknown>}>(`SELECT jsonb_build_object(
      'kind','blob','blobId',b.id,'committeeId',b.committee_id,'providerType',binding.provider_type,
      'storageKey',b.storage_key,'sizeBytes',b.size_bytes,'sha256',encode(b.sha256,'hex'),
      'durabilityState',b.durability_state) AS record
      FROM file_blobs b JOIN storage_bindings binding ON binding.id=b.storage_binding_id
      UNION ALL
      SELECT jsonb_build_object('kind','copy','blobId',c.content_blob_id,'committeeId',c.committee_id,
      'providerType',binding.provider_type,'storageKey',c.storage_key,'sizeBytes',c.size_bytes,
      'sha256',encode(c.sha256,'hex'),'durabilityState',c.status)
      FROM file_blob_copies c JOIN storage_bindings binding ON binding.id=c.storage_binding_id
      ORDER BY 1`);
    const runtime = await pool.query<{schema_compatibility: number}>('SELECT schema_compatibility FROM quorum_meta.runtime_metadata');
    await writeFile(fileManifest, `${blobs.rows.map(row => JSON.stringify(row.record)).join('\n')}\n`, {mode: 0o600});
    await chmod(databaseDump, 0o600);
    const metadata = {
      createdAt: new Date().toISOString(),
      schemaCompatibility: runtime.rows[0]?.schema_compatibility,
      databaseDump: {file: 'database.dump', sha256: await sha256(databaseDump)},
      fileManifest: {file: 'file-manifest.jsonl', records: blobs.rowCount ?? 0, sha256: await sha256(fileManifest)}
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {mode: 0o600});
    process.stdout.write(`${metadataPath}\n`);
  } finally {
    await pool.end();
  }
}

await main();

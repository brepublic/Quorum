// @vitest-environment node
import {execFile} from 'node:child_process';
import {chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run = promisify(execFile);
let directory: string;
const commit = 'a'.repeat(40); const tag = 'v1.3.0';
const digest = createHash('sha256').update('installer').digest('hex');
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'quorum-upgrade-'));
  await mkdir(join(directory, 'deploy')); await mkdir(join(directory, 'bin'));
  await copyFile(resolve('deploy/upgrade.sh'), join(directory, 'deploy/upgrade.sh'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({schemaVersion: 1, serverVersion: tag, commit,
    platforms: Object.fromEntries(['windows', 'linux'].map(platform => [platform,
      {file: `${platform}.bin`, url: `/downloads/chair-agent/${tag}/${platform}.bin`, sha256: digest, size: 9}]))}));
  const fake = `#!/usr/bin/env -S node --
const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2),tool=path.basename(process.argv[1]);
const dir=process.env.UPGRADE_TEST_DIR,scenario=process.env.UPGRADE_SCENARIO;
fs.appendFileSync(dir+'/calls',JSON.stringify([tool,...args])+'\\n');
const manifest=fs.readFileSync(dir+'/manifest.json','utf8');
const image=s=>'ghcr.io/brepublic/quorum-'+s+'@sha256:'+'b'.repeat(64);
const service=s=>s.includes('caddy')||s==='sha256:'+'d'.repeat(64)?'caddy':'app';
const oldId=s=>'sha256:'+(s==='caddy'?'d':'c').repeat(64);
const removed=()=>fs.existsSync(dir+'/removed')?fs.readFileSync(dir+'/removed','utf8').split('\\n'):[];
function out(value){process.stdout.write(typeof value==='string'?value:JSON.stringify(value));}
if(tool==='curl'){
 const url=args[args.length-1];
 if(url.endsWith('/health/ready')){if(scenario==='health-fails')process.exit(22);out({data:{status:'ok'}});}
 else if(url.endsWith('/api/v1/version'))out({data:{version:scenario==='wrong-runtime'?'v0.0.1':'${tag}'}});
 else if(url.endsWith('/manifest.json'))out(manifest);
 else out(scenario==='corrupt-download'?'bad':'installer');
}else if(args[0]==='compose'){
 if(args.includes('config'))out({'x-quorum-release-commit':'${commit}',services:{app:{image:image('app')},caddy:{image:scenario==='unpinned'?'latest':image('caddy'),environment:{QUORUM_SITE_ADDRESS:'quorum.example'}}}});
 else if(args.includes('pull')&&scenario==='pull-fails')process.exit(17);
 else if(args.includes('up')&&scenario==='start-fails')process.exit(18);
 else if(args.includes('ps')&&scenario!=='first-install')out('container-'+args[args.length-1]);
}else if(args[0]==='inspect')out(oldId(service(args[args.length-1])));
else if(args[0]==='run'){if(args.includes('cat'))out(manifest);else if(scenario==='corrupt-image')process.exit(1);}
else if(args[0]==='ps'){if(scenario==='shared')out('another-container');}
else if(args[0]==='image'&&args[1]==='inspect'){
 const ref=args[2],s=service(ref),old=ref.includes('old')||ref===oldId(s);
 if(removed().includes(s)&&old)process.exit(1);
 out([{Id:old?oldId(s):'sha256:'+(s==='app'?'e':'f').repeat(64),Config:{Labels:{'org.opencontainers.image.revision':scenario==='mixed-commit'&&s==='app'?'c'.repeat(40):'${commit}','io.quorum.release':'${tag}'}},
 RepoTags:old?[scenario==='foreign-tag'?'other/project:keep':'ghcr.io/brepublic/quorum-'+s+':old']:[],RepoDigests:[]}]);
}else if(args[0]==='image'&&args[1]==='rm'){
 if(scenario==='remove-fails')process.exit(1);fs.appendFileSync(dir+'/removed',service(args[2])+'\\n');
}else process.exit(3);
`;
  for (const tool of ['docker', 'curl']) {const file = join(directory, 'bin', tool); await writeFile(file, fake); await chmod(file, 0o755);}
});
afterEach(async () => {await rm(directory, {recursive: true, force: true});});
async function execute(scenario = '') {
  let failed = false; let output = '';
  try {const result = await run('bash', [join(directory, 'deploy/upgrade.sh')], {env: {...process.env,
    PATH: `${join(directory, 'bin')}:${process.env.PATH}`, UPGRADE_TEST_DIR: directory, UPGRADE_SCENARIO: scenario}}); output = result.stdout + result.stderr;}
  catch (error) {failed = true; output = String(error);}
  const calls = (await readFile(join(directory, 'calls'), 'utf8').catch(() => {throw new Error(output);})).trim().split('\n').map(line => JSON.parse(line) as string[]);
  return {failed, output, calls};
}
it('verifies the new release and downloads before removing only the replaced app and website images', async () => {
  const {failed, calls} = await execute(); expect(failed).toBe(false);
  const removals = calls.filter(call => call[0] === 'docker' && call[1] === 'image' && call[2] === 'rm');
  expect(removals.map(call => call[3])).toEqual(['ghcr.io/brepublic/quorum-app:old', 'ghcr.io/brepublic/quorum-caddy:old']);
  expect(calls.findIndex(call => call.includes('rm'))).toBeGreaterThan(calls.findLastIndex(call => call[0] === 'curl'));
  expect(calls.flat()).not.toContain('prune'); expect(calls.flat()).not.toContain('--force');
});
it.each(['pull-fails','mixed-commit','corrupt-image','start-fails','health-fails','wrong-runtime','corrupt-download','unpinned'])(
  'preserves old images when %s', async scenario => {
    const {failed, calls} = await execute(scenario); expect(failed).toBe(true);
    expect(calls.some(call => call.includes('rm'))).toBe(false);
    if (['pull-fails','mixed-commit','corrupt-image','unpinned'].includes(scenario)) expect(calls.some(call => call.includes('up'))).toBe(false);
  });
it.each(['shared','foreign-tag','remove-fails'])('reports incomplete cleanup for %s', async scenario => {
  const {failed, calls} = await execute(scenario); expect(failed).toBe(true);
  if (scenario !== 'remove-fails') expect(calls.some(call => call.includes('rm'))).toBe(false);
});
it('supports first deployment without deleting any existing image', async () => {
  const {failed, calls} = await execute('first-install'); expect(failed).toBe(false);
  expect(calls.some(call => call.includes('rm'))).toBe(false);
});

it('retries pending cleanup after post-switch verification fails', async () => {
  expect((await execute('corrupt-download')).failed).toBe(true);
  expect(await readFile(join(directory, 'deploy/.upgrade-images'), 'utf8')).toContain('sha256:');
  expect((await execute()).failed).toBe(false);
  await expect(readFile(join(directory, 'deploy/.upgrade-images'))).rejects.toThrow();
});

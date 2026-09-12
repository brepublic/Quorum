// @vitest-environment node
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it, expect} from 'vitest';
import {lockAgentRoot} from './runtime-lock';
it.skipIf(process.platform !== 'linux')('rejects a second process lock and releases without deleting the lock inode', async () => {
  const root=await mkdtemp(join(tmpdir(),'quorum-lock-'));
  try {const release=await lockAgentRoot(root);
    try {await expect(lockAgentRoot(root)).rejects.toThrow('AGENT_ALREADY_RUNNING');} finally {await release();}
    await (await lockAgentRoot(root))();
  } finally {await rm(root,{recursive:true,force:true});}
});

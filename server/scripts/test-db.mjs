import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = resolve(serverDirectory, '..');
const composeFile = resolve(repositoryDirectory, 'deploy/compose.test.yaml');
const command = process.argv[2];

function run(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, {
      cwd: repositoryDirectory,
      env: {...process.env, ...options.env},
      stdio: 'inherit',
      shell: false
    });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolvePromise()
      : reject(new Error(`${program} exited with status ${code ?? 'unknown'}.`)));
  });
}

const compose = (...args) => run('docker', ['compose', '-f', composeFile, ...args]);
const up = () => compose('up', '-d', '--wait', 'postgres-test');
const down = () => compose('down');

try {
  switch (command) {
    case 'up':
      await up();
      break;
    case 'down':
      await down();
      break;
    case 'reset':
      await compose('down', '--volumes');
      await up();
      break;
    case 'test':
      await up();
      await run('pnpm', ['exec', 'vitest', 'run', 'server/src/db/migrations.integration.test.ts'], {
        env: {
          TEST_DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL
            || 'postgresql://quorum_test:quorum_test@127.0.0.1:55432/postgres'
        }
      });
      break;
    default:
      process.stderr.write('Usage: node server/scripts/test-db.mjs <up|down|reset|test>\n');
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

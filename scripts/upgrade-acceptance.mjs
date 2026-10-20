import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function migrationSnapshot(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Empty migration baseline');
  const versions = new Set();
  return rows.map(({version, checksum}) => {
    if (!Number.isInteger(version) || version < 1 || !/^[a-f0-9]{64}$/.test(checksum)
      || versions.has(version)) throw new Error('Invalid migration baseline');
    versions.add(version);
    return {version, checksum};
  }).sort((a, b) => a.version - b.version);
}

export function assertMigrationBaseline(expected, actual) {
  const baseline = migrationSnapshot(expected);
  if (baseline.at(-1).version >= 9000) throw new Error('Migration baseline overlaps acceptance migrations 9000/9001');
  if (JSON.stringify(baseline) !== JSON.stringify(migrationSnapshot(actual))) {
    throw new Error('Database migration versions/checksums differ from the base image');
  }
}

export function redactLog(text) {
  // Drop the whole sensitive line, including structured logger objects. Do not
  // export raw configs, HTTP bodies, cookies, journals or volume archives.
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    '[redacted private key]').split('\n').map(line =>
    /password|secret|token|cookie|authorization|postgres(?:ql)?:\/\/|BEGIN .*PRIVATE KEY/i.test(line)
      ? '[redacted sensitive log line]' : line
  ).join('\n').replaceAll('Upgrade-acceptance-123!', '[redacted]')
    .replaceAll('only-for-isolated-test', '[redacted]');
}

export async function exportDiagnostics(work, destination) {
  await mkdir(destination, {recursive: true, mode: 0o700});
  for (const entry of await readdir(work, {withFileTypes: true})) {
    if (!entry.isFile() || !/^[\w-]+\.log$/.test(entry.name)) continue;
    await writeFile(join(destination, entry.name), redactLog(await readFile(join(work, entry.name), 'utf8')),
      {mode: 0o600});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'migrations') {
    assertMigrationBaseline(JSON.parse(await readFile(first, 'utf8')), JSON.parse(await readFile(second, 'utf8')));
  } else if (command === 'diagnostics') {
    await exportDiagnostics(first, second);
  } else throw new Error('Usage: upgrade-acceptance.mjs migrations|diagnostics <source> <destination>');
}

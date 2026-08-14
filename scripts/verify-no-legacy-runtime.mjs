import {access, readdir, readFile} from 'node:fs/promises';
import {extname, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const forbiddenPaths = [
  'firebase.json',
  'database.rules.json',
  'storage.rules',
  'functions',
  'cypress',
  'cypress.config.ts'
];
const forbiddenPatterns = [
  /firebase/i,
  /react-firebase-hooks/i,
  /VITE_RUNTIME_MODE/,
  /VITE_USE_FIREBASE_EMULATORS/,
  /firebaseapp\.com/i,
  /firebaseio\.com/i,
  /appspot\.com/i
];
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.sql', '.toml', '.ts', '.tsx', '.yaml', '.yml']);
const scanTargets = [
  '.github/workflows',
  'build',
  'deploy',
  'packages',
  'server',
  'src',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml'
];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function containsFiles(path) {
  if (!await exists(path)) return false;
  if (extname(path)) return true;
  const entries = await readdir(path, {withFileTypes: true});
  for (const entry of entries) {
    if (!entry.isDirectory() || await containsFiles(resolve(path, entry.name))) return true;
  }
  return false;
}

async function textFiles(path) {
  const entries = await readdir(path, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await textFiles(child));
    else if (textExtensions.has(extname(entry.name))) files.push(child);
  }
  return files;
}

const failures = [];
for (const path of forbiddenPaths) {
  if (await containsFiles(resolve(root, path))) failures.push(`forbidden path remains: ${path}`);
}
for (const target of scanTargets) {
  const path = resolve(root, target);
  if (!await exists(path)) {
    failures.push(`required scan target is missing: ${target}`);
    continue;
  }
  const files = extname(path) ? [path] : await textFiles(path);
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(source)) failures.push(`${file.slice(root.length + 1)} matches ${pattern}`);
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('No legacy runtime references found in production sources, dependencies, configuration, or build output.\n');
}

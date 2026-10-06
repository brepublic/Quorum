// Fontconfig 2.13 resolves relative font directories against the process cwd.
// Use absolute paths without changing cwd (pairing files may be relative).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(process.argv[2]);
const cache = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME, '.cache'), 'quorum-agent', 'fontconfig');
fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
// Separate mount paths prevent a second instance from changing the first one's fonts.
const id = crypto.createHash('sha256').update(root).digest('hex');
const file = path.join(cache, id + '.conf');
const escaped = path.join(root, 'usr/share/fonts').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const xml = `<?xml version="1.0"?><fontconfig>
<include ignore_missing="yes">/etc/fonts/fonts.conf</include>
<dir>${escaped}</dir><cachedir prefix="xdg">fontconfig</cachedir>
</fontconfig>\n`;
const temporary = file + '.' + process.pid;
fs.writeFileSync(temporary, xml, { mode: 0o600 });
fs.renameSync(temporary, file);
process.stdout.write(file);

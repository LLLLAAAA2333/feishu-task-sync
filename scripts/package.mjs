import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const filename = `Feishu-Sync-${version}-Desktop.zip`;
const files = Object.fromEntries(['main.js', 'manifest.json', 'styles.css'].map(name => [name, readFileSync(resolve(root, 'dist/feishu-sync', name))]));
writeFileSync(resolve(root, 'dist', filename), zipSync(files, { level: 9 }));
const sums = Object.entries(files).map(([name, data]) => createHash('sha256').update(data).digest('hex') + '  ' + name).join('\n');
writeFileSync(resolve(root, 'dist/SHA256SUMS.txt'), sums + '\n');
console.log(resolve(root, 'dist', filename));

import { mkdir, copyFile, access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [vaultArgument, configDirectory = '.obsidian'] = process.argv.slice(2);
if (!vaultArgument) throw new Error('Usage: npm run install-vault -- /absolute/vault/path [config-directory]');
const vault = resolve(vaultArgument);
if (!(await stat(vault)).isDirectory()) throw new Error('The destination vault must already exist.');
if (isAbsolute(configDirectory) || configDirectory.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) {
  throw new Error('The config directory must be relative to the vault.');
}
const target = join(vault, configDirectory, 'plugins', 'feishu-sync');
const files = ['main.js', 'manifest.json', 'styles.css'];
for (const filename of files) await access(join(root, 'dist/feishu-sync', filename), constants.R_OK);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(vault, configDirectory, 'plugin-backups', 'feishu-sync', stamp);
let backedUp = false;
for (const filename of files) {
  try { await access(join(target, filename), constants.F_OK); }
  catch { continue; }
  await mkdir(backup, { recursive: true });
  await copyFile(join(target, filename), join(backup, filename));
  backedUp = true;
}
await mkdir(target, { recursive: true });
for (const filename of files) await copyFile(join(root, 'dist/feishu-sync', filename), join(target, filename));
console.log(JSON.stringify({ installed: target, ...(backedUp ? { backup: relative(vault, backup) } : {}) }));

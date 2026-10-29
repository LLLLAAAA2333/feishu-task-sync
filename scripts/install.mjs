import { mkdir, copyFile, access, stat, readFile, writeFile, rename, cp, mkdtemp } from 'node:fs/promises';
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
const id = 'feishu-task-sync';
const legacyId = 'feishu-sync';
const config = join(vault, configDirectory);
const target = join(config, 'plugins', id);
const legacy = join(config, 'plugins', legacyId);
const files = ['main.js', 'manifest.json', 'styles.css'];
const exists = async filename => {
  try { await access(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const readOptionalJSON = async filename => await exists(filename) ? JSON.parse(await readFile(filename, 'utf8')) : null;
for (const filename of files) await access(join(root, 'dist', id, filename), constants.R_OK);
const manifest = JSON.parse(await readFile(join(root, 'dist', id, 'manifest.json'), 'utf8'));
if (manifest.id !== id) throw new Error('Build the current plugin before installing.');

// Another plugin uses the old ID. Migrate only our own pre-1.5 installation.
const oldManifest = await readOptionalJSON(join(legacy, 'manifest.json'));
const migrate = oldManifest?.id === legacyId && ['JH Wang', 'Vault local tools'].includes(oldManifest.author) && oldManifest.name === '飞书任务联动';
const enabledFile = join(config, 'community-plugins.json');
const hotkeysFile = join(config, 'hotkeys.json');
let enabled, hotkeys;
if (migrate) {
  enabled = await readOptionalJSON(enabledFile);
  hotkeys = await readOptionalJSON(hotkeysFile);
  if (enabled !== null && (!Array.isArray(enabled) || enabled.some(value => typeof value !== 'string'))) {
    throw new Error('community-plugins.json must contain an array of plugin IDs.');
  }
  if (hotkeys !== null && (Array.isArray(hotkeys) || typeof hotkeys !== 'object')) {
    throw new Error('hotkeys.json must contain an object.');
  }
}

let backup;
if (migrate || await exists(target)) {
  const backups = join(config, 'plugin-backups', id);
  await mkdir(backups, { recursive: true });
  backup = await mkdtemp(join(backups, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  if (await exists(target)) await cp(target, join(backup, id), { recursive: true });
  if (migrate) {
    for (const filename of [enabledFile, hotkeysFile]) {
      if (await exists(filename)) await copyFile(filename, join(backup, relative(config, filename)));
    }
  }
}
await mkdir(target, { recursive: true });
for (const filename of files) await copyFile(join(root, 'dist', id, filename), join(target, filename));
if (migrate) {
  if (!(await exists(join(target, 'data.json'))) && await exists(join(legacy, 'data.json'))) {
    await copyFile(join(legacy, 'data.json'), join(target, 'data.json'));
  }
  if (enabled?.includes(legacyId)) {
    await writeFile(enabledFile, JSON.stringify([...new Set(enabled.map(value => value === legacyId ? id : value))], null, 2) + '\n');
  }
  if (hotkeys) {
    let changed = false;
    for (const command of ['open-panel', 'sync-vault']) {
      const oldKey = `${legacyId}:${command}`, newKey = `${id}:${command}`;
      if (!Object.hasOwn(hotkeys, oldKey)) continue;
      // Keep shortcuts already assigned to the new ID as well as the old ones.
      const shortcuts = [...(hotkeys[newKey] || []), ...hotkeys[oldKey]];
      hotkeys[newKey] = shortcuts.filter((value, index) => shortcuts.findIndex(other => JSON.stringify(other) === JSON.stringify(value)) === index);
      delete hotkeys[oldKey];
      changed = true;
    }
    if (changed) await writeFile(hotkeysFile, JSON.stringify(hotkeys, null, 2) + '\n');
  }
  await rename(legacy, join(backup, legacyId));
}
console.log(JSON.stringify({ installed: target, migrated: migrate, ...(backup ? { backup: relative(vault, backup) } : {}) }));

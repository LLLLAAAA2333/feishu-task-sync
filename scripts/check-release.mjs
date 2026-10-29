import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = json('manifest.json');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.version, json('package.json').version);
assert.equal(json('versions.json')[manifest.version], manifest.minAppVersion);
assert.equal(manifest.id, 'feishu-sync');
assert.equal(manifest.isDesktopOnly, true);
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
assert.deepEqual(json('dist/feishu-sync/manifest.json'), manifest);
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, manifest.version, 'Release tag must match manifest.version exactly.');
for (const name of ['README.md', 'LICENSE', 'CHANGELOG.md', 'dist/feishu-sync/main.js', 'dist/feishu-sync/styles.css']) {
  assert.ok(existsSync(resolve(root, name)), 'Missing release file: ' + name);
}
for (const input of Object.keys(json('dist/build-meta.json').inputs)) {
  assert.ok(/^(src|lib|node_modules)\//.test(input), 'Unexpected build input: ' + input);
}
console.log(`Feishu Sync ${manifest.version}: release files and independent build verified.`);

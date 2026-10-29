import { context } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist/feishu-sync');
const watch = process.argv.includes('--watch');
await mkdir(output, { recursive: true });
for (const filename of ['manifest.json', 'styles.css']) {
  await copyFile(resolve(root, filename), resolve(output, filename));
}
const build = await context({
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: resolve(output, 'main.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2021',
  external: ['obsidian', 'electron', '@electron/remote', ...builtinModules],
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  metafile: true,
  banner: { js: '/*! React, React DOM and Scheduler\n' + await readFile(resolve(root, 'node_modules/react/LICENSE'), 'utf8') + '\n*/' },
  footer: { js: 'module.exports = module.exports.default;' },
  logLevel: 'info',
});
if (watch) await build.watch();
else {
  const result = await build.rebuild();
  await writeFile(resolve(root, 'dist/build-meta.json'), JSON.stringify(result.metafile, null, 2));
  await build.dispose();
}

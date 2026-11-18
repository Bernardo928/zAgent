// Build: compila o processo principal, o preload e a interface com esbuild.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist/renderer', { recursive: true });
const copy = () => {
  cpSync('src/renderer/index.html', 'dist/renderer/index.html');
  cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
  cpSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/renderer/xterm.css');
};

const node = {
  bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true,
  external: ['electron', 'node-pty'],
};
const configs = [
  { ...node, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js' },
  { ...node, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js' },
  { entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', bundle: true, platform: 'browser', format: 'iife', target: 'chrome120', sourcemap: true },
];

copy();
if (watch) {
  for (const c of configs) await (await context(c)).watch();
  console.log('esbuild: observando mudanças…');
} else {
  await Promise.all(configs.map((c) => build(c)));
  console.log('build ok');
}

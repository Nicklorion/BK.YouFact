import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    content: 'Src/content/index.js',
    harvester: 'Src/page/harvester.js',
    options: 'Src/options/options.js'
  },
  outdir: 'Dist',
  bundle: true,
  format: 'iife',
  target: 'chrome111',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false
};

await rm('Dist', { recursive: true, force: true });
await mkdir('Dist', { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await cp('Src/manifest.json', 'Dist/manifest.json');
  await cp('Src/options/options.html', 'Dist/options.html');
  console.log('watching — load Dist/ as an unpacked extension');
} else {
  await build(options);
  await cp('Src/manifest.json', 'Dist/manifest.json');
  await cp('Src/options/options.html', 'Dist/options.html');
}

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const define = { __JPARK_VERSION__: JSON.stringify(pkg.version) };

/** The viewer is one self-contained script (three.js included) so exported HTML works offline. */
const viewer = {
  entryPoints: ['src/viewer/main.ts'],
  outfile: 'dist/viewer.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  loader: { '.css': 'text', '.glsl': 'text' },
  legalComments: 'none',
  define,
  logLevel: 'info',
};

const node = {
  entryPoints: ['src/cli.ts', 'src/index.ts'],
  outdir: 'dist',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  packages: 'external',
  define,
  logLevel: 'info',
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(viewer), esbuild.context(node)]);
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  rmSync('dist', { recursive: true, force: true });
  await Promise.all([esbuild.build(viewer), esbuild.build(node)]);
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
  } catch {
    process.exitCode = 1;
  }
}

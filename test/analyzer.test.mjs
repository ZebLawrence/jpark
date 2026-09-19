import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze, renderHtml } from '../dist/index.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Index a graph as { "from -> to": kind } using paths (or ext:<name> for packages). */
function edgeMap(graph) {
  const label = (n) => (n.type === 'external' ? `ext:${n.name}` : n.path || '.');
  const out = new Map();
  for (const e of graph.edges) out.set(`${label(graph.nodes[e.from])} -> ${label(graph.nodes[e.to])}`, e);
  return out;
}
const ext = (graph, name) => graph.nodes.find((n) => n.type === 'external' && n.name === name);

test('javascript monorepo', async (t) => {
  const graph = await analyze(path.join(fixtures, 'mono'), { git: false });
  const edges = edgeMap(graph);
  const has = (key, kind) => {
    assert.ok(edges.has(key), `missing edge: ${key}\nhave:\n  ${[...edges.keys()].join('\n  ')}`);
    if (kind) assert.equal(edges.get(key).kind, kind, `${key} kind`);
  };

  await t.test('respects .gitignore without git', () => {
    const paths = graph.nodes.filter((n) => n.type === 'file').map((n) => n.path);
    assert.ok(!paths.some((p) => p.startsWith('ignored-dir/')), 'ignored-dir/ should be skipped');
    assert.ok(!paths.includes('debug.log'), '*.log should be skipped');
    assert.ok(paths.includes('apps/web/src/main.ts'));
  });

  await t.test('relative, extension-less and .js→.ts imports', () => {
    has('packages/ui/src/index.ts -> packages/ui/src/components/Button.tsx', 'reexport');
    has('packages/ui/src/index.ts -> packages/ui/src/components/Card.tsx', 'reexport');
    has('apps/web/src/lib/index.ts -> apps/web/src/lib/helper.ts', 'import');
  });

  await t.test('import kinds: type-only, dynamic, require', () => {
    has('packages/ui/src/components/Button.tsx -> packages/ui/src/components/Card.tsx', 'type');
    has('apps/web/src/main.ts -> apps/web/src/pages/Home.vue', 'dynamic');
    has('apps/web/src/main.ts -> apps/web/src/lib/legacy.cjs', 'require');
    has('apps/web/src/main.ts -> apps/web/src/lib/in-template.ts', 'require');
  });

  await t.test('tsconfig paths through extends, with JSONC', () => {
    has('apps/web/src/main.ts -> apps/web/src/lib/index.ts');
    has('apps/web/src/pages/Home.vue -> apps/web/src/lib/helper.ts');
  });

  await t.test('workspace packages resolve to source, not to npm', () => {
    has('apps/web/src/main.ts -> packages/ui/src/index.ts');
    has('apps/web/src/main.ts -> packages/ui/src/styles/button.scss');
    assert.equal(ext(graph, '@mono/ui'), undefined);
  });

  await t.test('strings and comments are not imports', () => {
    for (const name of ['commented-out', 'in-a-string', 'not-real']) assert.equal(ext(graph, name), undefined, name);
  });

  await t.test('external packages are classified against the nearest manifest', () => {
    assert.equal(ext(graph, 'react').dep, 'prod');
    assert.equal(ext(graph, 'lodash').dep, 'prod');
    assert.equal(ext(graph, 'vitest').dep, 'dev');
    assert.equal(ext(graph, 'left-pad').dep, 'unlisted');
    assert.equal(ext(graph, 'fs').dep, 'builtin');
    assert.equal(ext(graph, 'path').dep, 'builtin');
    has('apps/web/src/main.ts -> ext:lodash');
    // declared but never imported
    assert.equal(ext(graph, 'prettier').dep, 'dev');
    assert.ok(!graph.edges.some((e) => e.to === ext(graph, 'prettier').id));
  });

  await t.test('unresolvable relative imports are reported, not invented', () => {
    assert.ok(graph.unresolved.some((u) => u.spec === './does-not-exist' && u.from === 'apps/web/src/main.ts'));
  });

  await t.test('scss partials, sass builtins, url() assets, vue <style>', () => {
    has('packages/ui/src/styles/button.scss -> packages/ui/src/styles/_vars.scss', 'style');
    has('packages/ui/src/styles/button.scss -> apps/web/public/logo.svg', 'asset');
    has('packages/ui/src/components/Button.tsx -> packages/ui/src/styles/button.scss');
    has('apps/web/src/pages/Home.vue -> packages/ui/src/styles/button.scss', 'style');
    assert.equal(ext(graph, 'sass').dep, 'builtin');
  });

  await t.test('html references, including root-absolute ones', () => {
    has('apps/web/index.html -> apps/web/src/main.ts', 'import');
    has('apps/web/index.html -> apps/web/public/logo.svg', 'asset');
  });

  await t.test('cycles: found for runtime imports, ignored for type-only ones', () => {
    const cyclePaths = graph.cycles.map((c) => c.map((id) => graph.nodes[id].path).sort());
    assert.deepEqual(cyclePaths, [['apps/web/src/lib/helper.ts', 'apps/web/src/lib/index.ts']]);
    assert.equal(edges.get('apps/web/src/lib/helper.ts -> apps/web/src/lib/index.ts').cycle, true);
    // Button <-> Card is only a cycle through `import type`, which is erased at build time.
    assert.ok(!edges.get('packages/ui/src/components/Card.tsx -> packages/ui/src/components/Button.tsx').cycle);
  });

  await t.test('classification', () => {
    const byPath = new Map(graph.nodes.filter((n) => n.type === 'file').map((n) => [n.path, n]));
    assert.equal(byPath.get('apps/web/src/lib/helper.test.ts').category, 'test');
    assert.equal(byPath.get('packages/ui/src/components/Button.tsx').category, 'markup');
    assert.equal(byPath.get('packages/ui/src/styles/button.scss').category, 'style');
    assert.equal(byPath.get('apps/web/tsconfig.json').category, 'config');
    assert.equal(byPath.get('apps/web/public/logo.svg').category, 'media');
    assert.equal(byPath.get('apps/web/src/main.ts').lines, 15);
  });

  await t.test('stats add up', () => {
    assert.equal(graph.stats.files, graph.nodes.filter((n) => n.type === 'file').length);
    assert.equal(graph.stats.edges, graph.edges.length);
    assert.equal(graph.name, 'mono');
  });
});

test('polyglot repo', async (t) => {
  const graph = await analyze(path.join(fixtures, 'poly'), { git: false });
  const edges = edgeMap(graph);
  const has = (key) => assert.ok(edges.has(key), `missing edge: ${key}\nhave:\n  ${[...edges.keys()].join('\n  ')}`);

  await t.test('python: absolute, relative, package and from-import-module', () => {
    has('pyapp/core/__init__.py -> pyapp/core/engine.py');
    has('pyapp/core/engine.py -> pyapp/utils/strings.py');
    has('pyapp/core/engine.py -> pyapp/core/models.py');
    assert.equal(ext(graph, 'os').dep, 'builtin');
    assert.equal(ext(graph, 'requests').dep, 'prod');
    assert.equal(ext(graph, 'yaml').dep, 'prod', 'yaml is PyYAML');
    assert.equal(ext(graph, 'numpy').dep, 'unlisted');
    assert.equal(ext(graph, 'pytest').dep, 'dev');
    assert.equal(ext(graph, 'fake_module'), undefined, 'docstrings are not imports');
    assert.equal(ext(graph, 'A'), undefined, 'description strings are not dependencies');
  });

  await t.test('go: module-local packages link to folders', () => {
    has('goapp/cmd/main.go -> goapp/internal/store');
    assert.equal(ext(graph, 'fmt').dep, 'builtin');
    assert.equal(ext(graph, 'net').dep, 'builtin');
    assert.equal(ext(graph, 'github.com/gorilla/mux').version, 'v1.8.0');
    assert.equal(ext(graph, 'golang.org/x/sync'), undefined, 'indirect deps are not listed as unused');
  });

  await t.test('rust: mod, use crate::, use super::, qualified paths', () => {
    has('rustapp/src/main.rs -> rustapp/src/config.rs');
    has('rustapp/src/main.rs -> rustapp/src/net/mod.rs');
    has('rustapp/src/main.rs -> rustapp/src/net/client.rs');
    has('rustapp/src/net/mod.rs -> rustapp/src/net/client.rs');
    has('rustapp/src/net/client.rs -> rustapp/src/config.rs');
    assert.equal(ext(graph, 'serde').dep, 'prod');
    assert.equal(ext(graph, 'serde_json').dep, 'prod');
    assert.equal(ext(graph, 'std').dep, 'builtin');
    assert.equal(ext(graph, 'criterion').dep, 'dev');
  });

  await t.test('c: quoted includes resolve by suffix, angle includes are external', () => {
    has('capp/src/main.c -> capp/include/math_utils.h');
    assert.equal(ext(graph, 'openssl').ecosystem, 'c');
    assert.equal(ext(graph, 'libc / libstdc++').dep, 'builtin');
  });
});

test('options', async (t) => {
  await t.test('ignore globs and includeUnusedDeps', async () => {
    const graph = await analyze(path.join(fixtures, 'mono'), { git: false, ignore: ['packages/'], includeUnusedDeps: false });
    assert.ok(!graph.nodes.some((n) => n.type === 'file' && n.path.startsWith('packages/')));
    assert.equal(ext(graph, 'prettier'), undefined);
  });
  await t.test('alias option', async () => {
    const graph = await analyze(path.join(fixtures, 'mono'), { git: false, ignore: ['tsconfig*.json'], alias: { '@': 'apps/web/src' } });
    assert.ok(edgeMap(graph).has('apps/web/src/pages/Home.vue -> apps/web/src/lib/helper.ts'));
  });
  await t.test('rejects a missing root', async () => {
    await assert.rejects(() => analyze(path.join(fixtures, 'nope')), /Not a directory/);
  });
});

test('renderHtml produces one self-contained document', async () => {
  const graph = await analyze(path.join(fixtures, 'mono'), { git: false });
  const html = await renderHtml({ graph });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /id="jpark-graph"/);
  assert.ok(!/<script src=/.test(html), 'viewer must be inlined');
  assert.ok(html.length > 300_000, 'viewer bundle is embedded');
  const json = /<script type="application\/json" id="jpark-graph">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(json).stats.files, graph.stats.files);
});

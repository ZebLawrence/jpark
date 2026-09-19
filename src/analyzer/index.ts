import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnalyzeOptions, DirNode, Edge, FileNode, Graph, GraphStats } from '../types.js';
import { classify, isProbablyText } from './classify.js';
import { Ctx, basename, dirname, type LanguageAnalyzer } from './context.js';
import { createCssAnalyzer } from './languages/css.js';
import { createGoAnalyzer } from './languages/go.js';
import { createHtmlAnalyzer } from './languages/html.js';
import { createJavaScriptAnalyzer } from './languages/javascript.js';
import { createCAnalyzer, createJvmAnalyzer, createRubyAnalyzer } from './languages/misc.js';
import { createPythonAnalyzer } from './languages/python.js';
import { createRustAnalyzer } from './languages/rust.js';
import { walk } from './walk.js';

/** Files larger than this are measured but never parsed. */
const MAX_PARSE_BYTES = 1.5 * 1024 * 1024;
const READ_CONCURRENCY = 48;

export async function analyze(rootDir: string, options: AnalyzeOptions = {}): Promise<Graph> {
  const started = Date.now();
  const root = path.resolve(rootDir);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Not a directory: ${root}`);

  const walked = await walk(root, options);
  const ctx = new Ctx(root, options);

  // ── tree ──
  const rootNode: DirNode = { id: 0, type: 'dir', name: await projectName(root), path: '', parent: -1 };
  ctx.nodes.push(rootNode);
  ctx.dirs.set('', rootNode);
  const ensureDir = (p: string): DirNode => {
    const hit = ctx.dirs.get(p);
    if (hit) return hit;
    const parent = ensureDir(dirname(p));
    const node: DirNode = { id: ctx.nodes.length, type: 'dir', name: basename(p), path: p, parent: parent.id };
    ctx.nodes.push(node);
    ctx.dirs.set(p, node);
    return node;
  };
  for (const f of walked.files) {
    const parent = ensureDir(dirname(f.path));
    const name = basename(f.path);
    const kind = classify(f.path, name);
    const node: FileNode = {
      id: ctx.nodes.length, type: 'file', name, path: f.path, parent: parent.id,
      ext: kind.ext, lang: kind.lang, category: kind.category, size: f.size, lines: 0,
    };
    ctx.nodes.push(node);
    ctx.files.set(f.path, node);
    const list = ctx.byBasename.get(name);
    if (list) list.push(f.path);
    else ctx.byBasename.set(name, [f.path]);
  }

  // ── languages ──
  const js = createJavaScriptAnalyzer();
  const analyzers: LanguageAnalyzer[] = [
    js,
    createCssAnalyzer(() => js.resolver(ctx)),
    createHtmlAnalyzer(() => js.resolver(ctx)),
    createPythonAnalyzer(),
    createGoAnalyzer(),
    createRustAnalyzer(),
    createCAnalyzer(),
    createJvmAnalyzer(),
    createRubyAnalyzer(),
  ];
  const byExt = new Map<string, LanguageAnalyzer>();
  for (const a of analyzers) for (const e of a.exts) if (!byExt.has(e)) byExt.set(e, a);
  const present = new Set([...ctx.files.values()].map((f) => f.ext));
  const active = analyzers.filter((a) => a === js || a.exts.some((e) => present.has(e)));
  await Promise.all(active.map((a) => a.prepare?.(ctx)));

  // ── read + scan ──
  const queue = [...ctx.files.values()];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const file = queue[cursor++];
      if (!isProbablyText(file.category, file.ext)) continue;
      if (file.size > MAX_PARSE_BYTES) {
        file.lines = Math.round(file.size / 40);
        continue;
      }
      let source: string;
      try {
        source = await fs.readFile(path.join(root, file.path), 'utf8');
      } catch {
        continue;
      }
      if (source.indexOf('\0') !== -1 && source.slice(0, 8000).includes('\0')) {
        file.category = 'binary';
        continue;
      }
      file.lines = countLines(source);
      const analyzer = byExt.get(file.ext);
      if (!analyzer) continue;
      try {
        analyzer.analyze(file, source, ctx);
      } catch {
        ctx.miss(file, '(analyzer error)');
      }
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  for (const a of active) a.finish?.(ctx);

  // ── assemble ──
  const edges = [...ctx.edges.values()].sort((a, b) => a.from - b.from || a.to - b.to);
  const cycles = findCycles(ctx.nodes.length, edges, (id) => ctx.nodes[id].type === 'file');

  const languages: GraphStats['languages'] = {};
  let lines = 0;
  let bytes = 0;
  for (const f of ctx.files.values()) {
    const l = (languages[f.lang] ??= { files: 0, lines: 0 });
    l.files++;
    l.lines += f.lines;
    lines += f.lines;
    bytes += f.size;
  }

  return {
    version: 1,
    name: rootNode.name,
    root,
    generatedAt: new Date().toISOString(),
    nodes: ctx.nodes,
    edges,
    cycles,
    unresolved: ctx.unresolved.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
    stats: {
      files: ctx.files.size,
      dirs: ctx.dirs.size,
      externals: ctx.externals.size,
      edges: edges.length,
      lines,
      bytes,
      unresolved: ctx.unresolved.length,
      cycles: cycles.length,
      truncated: walked.truncated,
      scanMs: Date.now() - started,
      languages,
    },
  };
}

async function projectName(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch {
    /* not an npm project */
  }
  return path.basename(root) || root;
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  let i = -1;
  while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
  return s.charCodeAt(s.length - 1) === 10 ? n - 1 : n;
}

/**
 * Iterative Tarjan SCC over runtime file→file edges. Type-only imports are erased at build
 * time, so they do not count toward cycles. Marks `edge.cycle` and returns the components.
 */
function findCycles(nodeCount: number, edges: Edge[], isFile: (id: number) => boolean): number[][] {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    if (e.kind === 'type' || !isFile(e.from) || !isFile(e.to)) continue;
    const list = adj.get(e.from);
    if (list) list.push(e.to);
    else adj.set(e.from, [e.to]);
  }
  const index = new Int32Array(nodeCount).fill(-1);
  const low = new Int32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);
  const comp = new Int32Array(nodeCount).fill(-1);
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;

  for (const start of adj.keys()) {
    if (index[start] !== -1) continue;
    const work: [node: number, next: number][] = [[start, 0]];
    index[start] = low[start] = counter++;
    stack.push(start);
    onStack[start] = 1;
    while (work.length) {
      const frame = work[work.length - 1];
      const [v] = frame;
      const targets = adj.get(v) ?? [];
      if (frame[1] < targets.length) {
        const w = targets[frame[1]++];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = 1;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
        if (low[v] === index[v]) {
          const members: number[] = [];
          let w: number;
          do {
            w = stack.pop()!;
            onStack[w] = 0;
            members.push(w);
          } while (w !== v);
          if (members.length > 1) {
            for (const m of members) comp[m] = out.length;
            out.push(members.sort((a, b) => a - b));
          }
        }
      }
    }
  }
  for (const e of edges) {
    if (e.kind !== 'type' && comp[e.from] !== -1 && comp[e.from] === comp[e.to]) e.cycle = true;
  }
  return out;
}

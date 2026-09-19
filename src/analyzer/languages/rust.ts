import type { DepKind } from '../../types.js';
import { Ctx, dirname, joinPath, type LanguageAnalyzer } from '../context.js';

interface Crate {
  dir: string;
  name?: string;
  deps: Map<string, { kind: DepKind; version?: string }>;
}

/** Expand `a::{b, c::{d, e}}` into flat paths. */
export function expandUse(tree: string): string[] {
  const t = tree.replace(/\s+/g, ' ').trim();
  const open = t.indexOf('{');
  if (open === -1) return [t.split(' as ')[0].trim()];
  let depth = 0;
  let close = -1;
  for (let i = open; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close === -1) return [t.slice(0, open).replace(/::$/, '')];
  const prefix = t.slice(0, open);
  const parts: string[] = [];
  let start = open + 1;
  depth = 0;
  for (let i = open + 1; i <= close; i++) {
    const c = t[i];
    if (c === '{') depth++;
    else if (c === '}' && depth > 0) depth--;
    else if ((c === ',' && depth === 0) || i === close) {
      const piece = t.slice(start, i).trim();
      if (piece) parts.push(piece);
      start = i + 1;
    }
  }
  return parts.flatMap((p) => expandUse(prefix + p));
}

export function createRustAnalyzer(): LanguageAnalyzer {
  const crates = new Map<string, Crate>();
  const crateByName = new Map<string, Crate>();
  const workspaceDeps = new Map<string, { kind: DepKind; version?: string }>();

  const crateFor = (dir: string): Crate | null => {
    let d: string | null = dir;
    while (d != null) {
      const c = crates.get(d);
      if (c) return c;
      d = d === '' ? null : dirname(d);
    }
    return null;
  };

  const moduleFile = (ctx: Ctx, base: string): string | null => {
    for (const c of [`${base}.rs`, `${base}/mod.rs`]) if (ctx.hasFile(c)) return c;
    return null;
  };

  /** Walk `segments` down from `base`, returning the deepest module file that exists. */
  const walkModules = (ctx: Ctx, base: string, segments: string[]): string | null => {
    let best: string | null = null;
    let cur = base;
    for (const seg of segments) {
      cur = cur ? `${cur}/${seg}` : seg;
      const hit = moduleFile(ctx, cur);
      if (hit) best = hit;
      else if (!ctx.hasDir(cur)) break;
    }
    return best;
  };

  return {
    name: 'rust',
    exts: ['rs'],
    async prepare(ctx) {
      for (const f of ctx.filesNamed('Cargo.toml')) {
        const text = (await ctx.readText(f.path)) ?? '';
        const crate: Crate = { dir: dirname(f.path), deps: new Map() };
        let section = '';
        for (const line of text.split(/\r?\n/)) {
          const s = /^\s*\[([^\]]+)\]/.exec(line);
          if (s) {
            section = s[1].trim();
            const inline = /^(?:target\..+\.)?((?:dev-|build-)?dependencies)\.(.+)$/.exec(section);
            if (inline) crate.deps.set(inline[2].replace(/-/g, '_'), { kind: inline[1] === 'dependencies' ? 'prod' : 'dev' });
            continue;
          }
          const kv = /^\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
          if (!kv) continue;
          if (section === 'package' && kv[1] === 'name') crate.name = kv[2].replace(/["']/g, '').trim().replace(/-/g, '_');
          const depSection = /^(?:target\..+\.)?(workspace\.)?((?:dev-|build-)?dependencies)$/.exec(section);
          if (depSection) {
            const version = /^"([^"]+)"/.exec(kv[2])?.[1] ?? /version\s*=\s*"([^"]+)"/.exec(kv[2])?.[1];
            const renamed = /package\s*=\s*"([^"]+)"/.exec(kv[2]);
            const entry = { kind: (depSection[2] === 'dependencies' ? 'prod' : 'dev') as DepKind, version };
            (depSection[1] ? workspaceDeps : crate.deps).set(kv[1].replace(/-/g, '_'), entry);
            void renamed;
          }
        }
        crates.set(crate.dir, crate);
        if (crate.name) crateByName.set(crate.name, crate);
      }
    },
    analyze(file, source, ctx) {
      const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      const dir = dirname(file.path);
      const stem = file.name.replace(/\.rs$/, '');
      const isRootish = stem === 'mod' || stem === 'lib' || stem === 'main' || dir.endsWith('/bin');
      const selfDir = isRootish ? dir : `${dir}/${stem}`;
      const crate = crateFor(dir);
      const srcRoot = crate ? joinPath(crate.dir, 'src')! : dir;

      for (const m of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
        const hit = moduleFile(ctx, `${selfDir}/${m[1]}`) ?? moduleFile(ctx, `${dir}/${m[1]}`);
        if (!hit || !ctx.link(file, hit, 'import')) ctx.miss(file, `mod ${m[1]}`);
      }

      const seenExternal = new Set<string>();
      const external = (name: string) => {
        if (seenExternal.has(name)) return;
        seenExternal.add(name);
        if (name === 'std' || name === 'core' || name === 'alloc' || name === 'proc_macro') {
          ctx.external(file, name, 'cargo', 'builtin');
          return;
        }
        const local = crateByName.get(name);
        if (local && local !== crate) {
          const entry = moduleFile(ctx, `${local.dir}/src/lib`) ?? local.dir;
          ctx.link(file, entry, 'import');
          return;
        }
        const dep = crate?.deps.get(name) ?? workspaceDeps.get(name);
        if (dep) ctx.external(file, name, 'cargo', dep.kind, 'import', dep.version);
      };

      for (const m of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm)) {
        for (const path of expandUse(m[1])) {
          const segs = path.replace(/^::/, '').split('::').map((s) => s.trim()).filter(Boolean);
          if (!segs.length) continue;
          const head = segs[0];
          if (head === 'crate') {
            const hit = walkModules(ctx, srcRoot, segs.slice(1));
            if (hit) ctx.link(file, hit, 'import');
          } else if (head === 'super' || head === 'self') {
            let base = selfDir;
            let i = 0;
            while (segs[i] === 'super') {
              base = dirname(base);
              i++;
            }
            if (segs[i] === 'self') i++;
            const hit = walkModules(ctx, base, segs.slice(i));
            if (hit) ctx.link(file, hit, 'import');
          } else external(head);
        }
      }
      for (const m of src.matchAll(/^\s*extern\s+crate\s+(\w+)/gm)) external(m[1]);
      // Fully-qualified paths used without a `use`, e.g. `serde_json::to_string(..)`.
      if (crate) for (const name of crate.deps.keys()) if (!seenExternal.has(name) && new RegExp(`\\b${name}::`).test(src)) external(name);
    },
    finish(ctx) {
      if (ctx.options.includeUnusedDeps === false) return;
      for (const crate of crates.values()) {
        for (const [name, dep] of crate.deps) if (!crateByName.has(name)) ctx.external(null, name, 'cargo', dep.kind, 'import', dep.version);
      }
    },
  };
}

import { builtinModules } from 'node:module';
import type { DepKind, EdgeKind, FileNode } from '../../types.js';
import { Ctx, dirname, joinPath, type LanguageAnalyzer } from '../context.js';
import { parseJsonc } from '../jsonc.js';
import { scanCss } from './css.js';

export interface JsImport {
  spec: string;
  kind: EdgeKind;
}

// ───────────────────────────── scanning ─────────────────────────────

const IMPORT_CLAUSE = /\s*(type\s+)?(?:[\w$*\s{},]+?\s*from\s*)?(['"])([^'"\n]+)\2/y;
const EXPORT_FROM = /\s*(type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/y;
const CALL_ARG = /\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(['"`])([^'"`\n$]+)\1/y;
const REQUIRE_CALL = /\s*(?:\.resolve\s*)?\(\s*(['"`])([^'"`\n$]+)\1\s*[,)]/y;
const NEW_URL = /\s*\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*,\s*import\.meta\.url/y;

const LINE_IMPORT = /^[ \t]*import\s+(type\s+)?(?:[\w$*\s{},]+?\s*from\s*)?(['"])([^'"\n]+)\2/gm;
const LINE_EXPORT = /^[ \t]*export\s+(type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/gm;

const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

const isIdStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);

/**
 * Find every module specifier in a JS/TS source. `loose` skips the tokenizer and only uses
 * line-anchored matching — for formats like MDX where JS is mixed with prose.
 */
export function scanJs(src: string, loose = false): JsImport[] {
  const found = new Map<string, EdgeKind>();
  const push = (spec: string, kind: EdgeKind) => {
    const prev = found.get(spec);
    if (!prev || (prev === 'type' && kind !== 'type')) found.set(spec, kind);
  };

  if (!loose) tokenScan(src, push);

  // Safety net: a stray backtick inside JSX text can derail any tokenizer that is not a full
  // parser, so top-level statements are also matched line-anchored on the raw source.
  for (const m of src.matchAll(LINE_IMPORT)) push(m[3], m[1] ? 'type' : 'import');
  for (const m of src.matchAll(LINE_EXPORT)) push(m[3], m[1] ? 'type' : 'reexport');

  return Array.from(found, ([spec, kind]) => ({ spec, kind }));
}

function tokenScan(src: string, push: (spec: string, kind: EdgeKind) => void): void {
  const n = src.length;
  let i = 0;
  let lastSig = '';
  let lastWord = '';
  let braceDepth = 0;
  const templateStack: number[] = [];

  /** Scan template literal text starting at `j`; stops after the closing backtick or a `${`. */
  const scanTemplate = (j: number): number => {
    while (j < n) {
      const ch = src.charCodeAt(j);
      if (ch === 92) j += 2;
      else if (ch === 96) return j + 1;
      else if (ch === 36 && src.charCodeAt(j + 1) === 123) {
        templateStack.push(braceDepth);
        braceDepth++;
        return j + 2;
      } else j++;
    }
    return n;
  };

  while (i < n) {
    const code = src.charCodeAt(i);
    // whitespace
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      i++;
      continue;
    }
    const c = src[i];
    if (c === '/') {
      const d = src[i + 1];
      if (d === '/') {
        const e = src.indexOf('\n', i + 2);
        i = e === -1 ? n : e + 1;
        continue;
      }
      if (d === '*') {
        const e = src.indexOf('*/', i + 2);
        i = e === -1 ? n : e + 2;
        continue;
      }
      if (lastSig === '' || REGEX_PRECEDERS.has(lastSig) || (lastSig === 'a' && REGEX_KEYWORDS.has(lastWord))) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\n') break;
          if (ch === '\\') {
            j += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          i = j + 1;
          while (i < n && isIdPart(src.charCodeAt(i))) i++;
          lastSig = ')';
          lastWord = '';
          continue;
        }
      }
      lastSig = '/';
      lastWord = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') j += 2;
        else if (ch === c || ch === '\n') break;
        else j++;
      }
      i = j + 1;
      lastSig = '"';
      lastWord = '';
      continue;
    }
    if (c === '`') {
      i = scanTemplate(i + 1);
      lastSig = '"';
      lastWord = '';
      continue;
    }
    if (c === '{') {
      braceDepth++;
    } else if (c === '}') {
      braceDepth--;
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        i = scanTemplate(i + 1);
        lastSig = '"';
        lastWord = '';
        continue;
      }
    }
    if (isIdStart(code)) {
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      const word = src.slice(i, j);
      const afterDot = lastSig === '.';
      if (!afterDot) {
        if (word === 'import') {
          let m: RegExpExecArray | null;
          CALL_ARG.lastIndex = j;
          IMPORT_CLAUSE.lastIndex = j;
          if ((m = CALL_ARG.exec(src))) push(m[2], 'dynamic');
          else if ((m = IMPORT_CLAUSE.exec(src))) push(m[3], m[1] ? 'type' : 'import');
        } else if (word === 'export') {
          EXPORT_FROM.lastIndex = j;
          const m = EXPORT_FROM.exec(src);
          if (m) push(m[3], m[1] ? 'type' : 'reexport');
        } else if (word === 'require') {
          REQUIRE_CALL.lastIndex = j;
          const m = REQUIRE_CALL.exec(src);
          if (m) push(m[2], 'require');
        } else if (word === 'URL' && lastWord === 'new') {
          NEW_URL.lastIndex = j;
          const m = NEW_URL.exec(src);
          if (m) push(m[2], 'asset');
        }
      }
      lastSig = 'a';
      lastWord = word;
      i = j;
      continue;
    }
    lastSig = c;
    lastWord = '';
    i++;
  }
}

/** Pull the script (and style) bodies out of single-file components. */
export function extractSfc(src: string, ext: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  if (ext === 'astro') {
    const fm = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(src);
    if (fm) scripts.push(fm[1]);
  }
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scripts.push(m[1]);
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styles.push(m[1]);
  return { scripts, styles };
}

// ───────────────────────────── manifests ─────────────────────────────

interface Pkg {
  dir: string;
  name?: string;
  json: any;
  deps: Map<string, { kind: DepKind; version: string }>;
}

interface PathMap {
  /** Directory that `paths` targets and `baseUrl` are relative to. */
  base: string;
  hasBaseUrl: boolean;
  paths: [pattern: string, targets: string[]][];
}

const RESOLVE_EXTS = [
  '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.vue', '.svelte', '.astro',
  '.css', '.scss', '.node',
];
const PLATFORM_INFIXES = ['.web', '.native', '.ios', '.android'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts', '.jsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const OUT_DIRS = /^(dist|lib|build|out|esm|cjs|es|umd|types)\//;

export class JsResolver {
  private pkgs = new Map<string, Pkg>();
  private pkgByName = new Map<string, Pkg>();
  private pkgForDirCache = new Map<string, Pkg | null>();
  private pathMaps = new Map<string, PathMap[]>();
  private pathMapsForDirCache = new Map<string, PathMap[]>();

  constructor(private ctx: Ctx) {}

  async load(): Promise<void> {
    const ctx = this.ctx;
    await Promise.all(
      ctx.filesNamed('package.json').map(async (f) => {
        const json = parseJsonc((await ctx.readText(f.path)) ?? '');
        if (!json || typeof json !== 'object') return;
        const deps = new Map<string, { kind: DepKind; version: string }>();
        const add = (field: string, kind: DepKind) => {
          for (const [name, version] of Object.entries(json[field] ?? {})) {
            if (!deps.has(name)) deps.set(name, { kind, version: String(version) });
          }
        };
        add('dependencies', 'prod');
        add('peerDependencies', 'peer');
        add('optionalDependencies', 'optional');
        add('devDependencies', 'dev');
        const pkg: Pkg = { dir: dirname(f.path), name: typeof json.name === 'string' ? json.name : undefined, json, deps };
        this.pkgs.set(pkg.dir, pkg);
        if (pkg.name && (!this.pkgByName.has(pkg.name) || pkg.dir.length < this.pkgByName.get(pkg.name)!.dir.length)) {
          this.pkgByName.set(pkg.name, pkg);
        }
      }),
    );

    const configs = [...ctx.files.values()].filter((f) => /^(ts|js)config(\..+)?\.json$/.test(f.name));
    await Promise.all(
      configs.map(async (f) => {
        const maps = await this.loadPathMaps(f.path, 0);
        if (!maps.length) return;
        const dir = dirname(f.path);
        const list = this.pathMaps.get(dir) ?? [];
        // Prefer the canonical tsconfig.json over tsconfig.*.json siblings.
        if (/^(ts|js)config\.json$/.test(f.name)) list.unshift(...maps);
        else list.push(...maps);
        this.pathMaps.set(dir, list);
      }),
    );
  }

  /** Path maps contributed by one config file: its own, else whatever it inherits via `extends`. */
  private async loadPathMaps(file: string, depth: number): Promise<PathMap[]> {
    const json = parseJsonc((await this.ctx.readText(file)) ?? '');
    if (!json) return [];
    const dir = dirname(file);
    const co = json.compilerOptions ?? {};
    const out: PathMap[] = [];
    const hasBaseUrl = typeof co.baseUrl === 'string';
    const base = hasBaseUrl ? joinPath(dir, co.baseUrl) ?? dir : dir;
    const ownPaths = co.paths && typeof co.paths === 'object';
    if (ownPaths || hasBaseUrl) {
      const paths = ownPaths
        ? Object.entries(co.paths as Record<string, string[]>).filter(([, v]) => Array.isArray(v))
        : [];
      out.push({ base, hasBaseUrl, paths });
    }
    if (!ownPaths && depth < 6) {
      const parents: unknown[] = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
      for (const ext of parents) {
        if (typeof ext !== 'string' || !ext.startsWith('.')) continue;
        let target = joinPath(dir, ext);
        if (target == null) continue;
        if (!this.ctx.hasFile(target) && this.ctx.hasFile(target + '.json')) target += '.json';
        if (this.ctx.hasFile(target)) out.push(...(await this.loadPathMaps(target, depth + 1)));
      }
    }
    return out;
  }

  pkgForDir(dir: string): Pkg | null {
    const cached = this.pkgForDirCache.get(dir);
    if (cached !== undefined) return cached;
    let d: string | null = dir;
    let found: Pkg | null = null;
    while (d != null) {
      const p = this.pkgs.get(d);
      if (p) {
        found = p;
        break;
      }
      d = d === '' ? null : dirname(d);
    }
    this.pkgForDirCache.set(dir, found);
    return found;
  }

  private pathMapsForDir(dir: string): PathMap[] {
    const cached = this.pathMapsForDirCache.get(dir);
    if (cached) return cached;
    const out: PathMap[] = [];
    let d: string | null = dir;
    while (d != null) {
      const maps = this.pathMaps.get(d);
      if (maps) out.push(...maps);
      d = d === '' ? null : dirname(d);
    }
    this.pathMapsForDirCache.set(dir, out);
    return out;
  }

  /** Resolve a path-ish module id (no extension required) to a scanned file. */
  tryFile(p: string | null): string | null {
    if (p == null) return null;
    const ctx = this.ctx;
    if (ctx.hasFile(p)) return p;
    for (const ext of RESOLVE_EXTS) if (ctx.hasFile(p + ext)) return p + ext;
    const dot = p.lastIndexOf('.');
    if (dot > p.lastIndexOf('/')) {
      const swaps = JS_TO_TS[p.slice(dot)];
      if (swaps) for (const s of swaps) if (ctx.hasFile(p.slice(0, dot) + s)) return p.slice(0, dot) + s;
    }
    if (ctx.hasDir(p)) {
      for (const ext of RESOLVE_EXTS) if (ctx.hasFile(`${p}/index${ext}`)) return `${p}/index${ext}`;
      const nested = this.pkgs.get(p);
      if (nested) return this.packageEntry(nested, '');
    }
    for (const infix of PLATFORM_INFIXES) {
      for (const ext of ['.ts', '.tsx', '.js', '.jsx']) if (ctx.hasFile(p + infix + ext)) return p + infix + ext;
    }
    return null;
  }

  /** Map a build artefact referenced by package.json back to its source file. */
  private fromBuildTarget(pkg: Pkg, target: string): string | null {
    const t = target.replace(/^\.\//, '');
    const bare = t.replace(/(\.d)?\.[cm]?[jt]sx?$/, '');
    const candidates = [t, bare];
    if (OUT_DIRS.test(t)) {
      const rest = bare.replace(OUT_DIRS, '');
      candidates.push(`src/${rest}`, rest, `lib/${rest}`);
    }
    for (const c of candidates) {
      const hit = this.tryFile(joinPath(pkg.dir, c));
      if (hit) return hit;
    }
    return null;
  }

  private packageEntry(pkg: Pkg, subpath: string): string | null {
    const { json } = pkg;
    const targets: string[] = [];
    const key = subpath ? `./${subpath}` : '.';
    const exp = json.exports;
    if (typeof exp === 'string' && !subpath) targets.push(exp);
    else if (exp && typeof exp === 'object') {
      const isSubpathMap = Object.keys(exp).some((k) => k.startsWith('.'));
      if (!isSubpathMap) {
        if (!subpath) collectStrings(exp, targets);
      } else {
        for (const [pattern, value] of Object.entries(exp)) {
          const star = matchStar(pattern, key);
          if (star == null) continue;
          const found: string[] = [];
          collectStrings(value, found);
          for (const f of found) targets.push(f.replace('*', star));
        }
      }
    }
    if (!subpath) {
      for (const field of ['source', 'module', 'main', 'types', 'typings', 'browser']) {
        if (typeof json[field] === 'string') targets.push(json[field]);
      }
    }
    for (const t of targets) {
      const hit = this.fromBuildTarget(pkg, t);
      if (hit) return hit;
    }
    const fallbacks = subpath ? [subpath, `src/${subpath}`, `lib/${subpath}`] : ['src/index', 'index', 'lib/index', 'src/main'];
    for (const f of fallbacks) {
      const hit = this.tryFile(joinPath(pkg.dir, f));
      if (hit) return hit;
    }
    return null;
  }

  /** Classify a bare package name against the manifests above `dir`. */
  private classify(name: string, dir: string): { kind: DepKind; version?: string } {
    let pkg = this.pkgForDir(dir);
    if (!pkg) return { kind: this.pkgs.size ? 'unlisted' : 'prod' };
    while (pkg) {
      const hit = pkg.deps.get(name) ?? pkg.deps.get(`@types/${name.replace(/^@/, '').replace('/', '__')}`);
      if (hit) return hit;
      pkg = pkg.dir === '' ? null : this.pkgForDir(dirname(pkg.dir));
    }
    return { kind: 'unlisted' };
  }

  resolve(file: FileNode, rawSpec: string, kind: EdgeKind): void {
    const ctx = this.ctx;
    let spec = rawSpec.slice(rawSpec.lastIndexOf('!') + 1).replace(/[?#].*$/, '');
    if (!spec || /^(https?:|data:|blob:|file:)/.test(spec)) return;
    const dir = dirname(file.path);
    const link = (p: string | null) => !!p && ctx.link(file, p, kind);

    if (spec.startsWith('.')) {
      if (!link(this.tryFile(joinPath(dir, spec)))) ctx.miss(file, rawSpec);
      return;
    }
    if (spec.startsWith('/')) {
      const pkgDir = this.pkgForDir(dir)?.dir ?? '';
      const rel = spec.slice(1);
      const hit =
        this.tryFile(joinPath(pkgDir, `public/${rel}`)) ??
        this.tryFile(joinPath(pkgDir, rel)) ??
        this.tryFile(joinPath(pkgDir, `static/${rel}`)) ??
        this.tryFile(rel);
      if (!link(hit)) ctx.miss(file, rawSpec);
      return;
    }
    if (/^(node|bun|deno|cloudflare):/.test(spec)) {
      const name = spec.startsWith('node:') ? spec.slice(5).split('/')[0] : spec;
      ctx.external(file, name, 'npm', 'builtin', kind);
      return;
    }
    if (/^[a-z-]+:/i.test(spec)) return; // virtual:…, npm:…, jsr:…

    // user aliases
    for (const [alias, target] of Object.entries(ctx.options.alias ?? {})) {
      if (spec === alias || spec.startsWith(alias + '/')) {
        if (link(this.tryFile(joinPath(target.replace(/^\.?\//, ''), spec.slice(alias.length + 1))))) return;
      }
    }

    // tsconfig / jsconfig paths
    for (const map of this.pathMapsForDir(dir)) {
      for (const [pattern, targets] of map.paths) {
        const star = matchStar(pattern, spec);
        if (star == null) continue;
        for (const t of targets) if (link(this.tryFile(joinPath(map.base, t.replace('*', star))))) return;
      }
      if (map.hasBaseUrl && link(this.tryFile(joinPath(map.base, spec)))) return;
    }

    const own = this.pkgForDir(dir);

    // package.json "imports" (#internal)
    if (spec.startsWith('#') && own?.json.imports) {
      for (const [pattern, value] of Object.entries(own.json.imports)) {
        const star = matchStar(pattern, spec);
        if (star == null) continue;
        const found: string[] = [];
        collectStrings(value, found);
        for (const f of found) if (link(this.fromBuildTarget(own, f.replace('*', star)))) return;
      }
    }

    const name = packageName(spec);
    const subpath = spec.slice(name.length + 1);

    // workspace package (or a self-reference)
    const ws = this.pkgByName.get(name);
    if (ws) {
      this.classify(name, dir);
      if (link(this.packageEntry(ws, subpath))) return;
      if (ctx.link(file, ws.dir, kind)) return;
    }

    if (BUILTINS.has(spec) || BUILTINS.has(name)) {
      const declared = own?.deps.has(name);
      if (!declared) {
        ctx.external(file, name, 'npm', 'builtin', kind);
        return;
      }
    }

    const declared = this.classify(name, dir);
    if (declared.kind === 'unlisted') {
      // Bundler-style aliases nobody told us about: @/x, ~/x, $lib/x, src/x …
      const pkgDir = own?.dir ?? '';
      const m = /^(@|~|~~|@@|\$lib|\$src|@src|@app|src|app)\/(.*)$/.exec(spec);
      const guesses: string[] = [];
      if (m) {
        const head = m[1] === '$lib' ? ['src/lib'] : m[1] === 'app' || m[1] === '@app' ? ['app', 'src/app', 'src'] : ['src', '', 'app'];
        for (const h of head) guesses.push(h ? `${h}/${m[2]}` : m[2]);
        if (m[1] === 'src' || m[1] === 'app') guesses.unshift(spec);
      } else if (ctx.hasDir(joinPath(pkgDir, spec.split('/')[0]) ?? '\0') || ctx.hasDir(joinPath(pkgDir, `src/${spec.split('/')[0]}`) ?? '\0')) {
        guesses.push(spec, `src/${spec}`);
      }
      for (const g of guesses) if (link(this.tryFile(joinPath(pkgDir, g)))) return;
      if (m || !NPM_NAME.test(name) || /^[$#~]/.test(spec)) {
        ctx.miss(file, rawSpec);
        return;
      }
    }
    ctx.external(file, name, 'npm', declared.kind, kind, declared.version);
  }

  /** Register manifest dependencies that no scanned file imports. */
  declareUnused(): void {
    for (const pkg of this.pkgs.values()) {
      for (const [name, { kind, version }] of pkg.deps) {
        if (this.pkgByName.has(name) || name.startsWith('@types/')) continue;
        this.ctx.external(null, name, 'npm', kind, 'import', version);
      }
    }
  }
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Match `key` against a pattern with at most one `*`; returns the captured part, or null. */
function matchStar(pattern: string, key: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === key ? '' : null;
  const head = pattern.slice(0, star);
  const tail = pattern.slice(star + 1);
  if (key.length >= head.length + tail.length && key.startsWith(head) && key.endsWith(tail)) {
    return key.slice(head.length, key.length - tail.length);
  }
  return null;
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectStrings(v, out);
}

// ───────────────────────────── analyzer ─────────────────────────────

const SFC = new Set(['vue', 'svelte', 'astro']);

export function createJavaScriptAnalyzer(): LanguageAnalyzer & { resolver(ctx: Ctx): JsResolver } {
  let resolver: JsResolver | null = null;
  return {
    name: 'javascript',
    exts: ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'd.ts', 'vue', 'svelte', 'astro', 'mdx'],
    resolver(ctx) {
      return (resolver ??= new JsResolver(ctx));
    },
    async prepare(ctx) {
      resolver = new JsResolver(ctx);
      await resolver.load();
    },
    analyze(file, source, ctx) {
      const r = resolver!;
      if (SFC.has(file.ext)) {
        const { scripts, styles } = extractSfc(source, file.ext);
        for (const s of scripts) for (const imp of scanJs(s)) r.resolve(file, imp.spec, imp.kind);
        for (const s of styles) for (const imp of scanCss(s)) if (imp.kind === 'style') r.resolve(file, toRelative(imp.spec), 'style');
        for (const m of source.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["']/gi)) r.resolve(file, toRelative(m[1]), 'import');
        return;
      }
      for (const imp of scanJs(source, file.ext === 'mdx')) r.resolve(file, imp.spec, imp.kind);
    },
    finish(ctx) {
      if (ctx.options.includeUnusedDeps !== false) resolver?.declareUnused();
    },
  };
}

function toRelative(spec: string): string {
  return /^(\.|\/|@|~|[a-z-]+:)/i.test(spec) ? spec : `./${spec}`;
}

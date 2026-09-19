import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WalkedFile {
  /** Posix path relative to the root. */
  path: string;
  size: number;
}

export interface WalkResult {
  files: WalkedFile[];
  truncated: boolean;
  usedGit: boolean;
}

/** Directories that are never interesting, even when git is unavailable. */
const ALWAYS_IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules']);

/** Used only when there is no git index to tell us what the project ignores. */
const FALLBACK_IGNORED_DIRS = new Set([
  'dist', 'build', 'out', 'target', 'coverage', 'vendor', 'bower_components', '__pycache__', 'venv', 'env',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache', '.venv', '.tox', '.mypy_cache',
  '.pytest_cache', '.gradle', '.idea', '.terraform', 'Pods', 'DerivedData',
]);

const ALWAYS_IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Compile one gitignore-syntax pattern, relative to `base` (posix, '' = root). */
export function compileIgnore(pattern: string, base = ''): IgnoreRule | null {
  let p = pattern.replace(/(?<!\\)\s+$/, '');
  if (!p || p.startsWith('#')) return null;
  let negate = false;
  if (p.startsWith('!')) {
    negate = true;
    p = p.slice(1);
  }
  let dirOnly = false;
  if (p.endsWith('/')) {
    dirOnly = true;
    p = p.slice(0, -1);
  }
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += '[' + p.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/^!/, '^') + ']';
        i = end;
      }
    } else if (c === '\\' && i + 1 < p.length) {
      re += escapeRe(p[++i]);
    } else re += escapeRe(c);
  }
  const prefix = base ? escapeRe(base) + '/' : '';
  const full = anchored ? `^${prefix}${re}(?:/|$)` : `^${prefix}(?:.*/)?${re}(?:/|$)`;
  return { re: new RegExp(full), negate, dirOnly };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) {
      // A dir-only rule still ignores files *inside* a matching directory.
      const m = rule.re.exec(relPath);
      if (m && m[0].endsWith('/')) ignored = !rule.negate;
      continue;
    }
    if (rule.re.test(relPath)) ignored = !rule.negate;
  }
  return ignored;
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function statAll(root: string, rels: string[], limit = 64): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  let i = 0;
  async function worker() {
    while (i < rels.length) {
      const rel = rels[i++];
      try {
        const st = await fs.lstat(path.join(root, rel));
        if (st.isFile()) out.push({ path: rel, size: st.size });
      } catch {
        /* deleted but still in the index */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, rels.length || 1) }, worker));
  return out;
}

async function walkGit(root: string, extra: IgnoreRule[], maxFiles: number): Promise<WalkResult | null> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') return null;
  const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed == null) return null;
  let rels = listed.split('\0').filter(Boolean);
  rels = rels.filter((rel) => {
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    if (ALWAYS_IGNORED_FILES.has(name)) return false;
    for (let i = 0; i < parts.length - 1; i++) if (ALWAYS_IGNORED_DIRS.has(parts[i])) return false;
    return !isIgnored(extra, rel, false);
  });
  const truncated = rels.length > maxFiles;
  if (truncated) rels = rels.slice(0, maxFiles);
  return { files: await statAll(root, rels), truncated, usedGit: true };
}

async function walkFs(root: string, extra: IgnoreRule[], maxFiles: number): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  let truncated = false;

  async function visit(rel: string, inherited: IgnoreRule[]): Promise<void> {
    if (truncated) return;
    const abs = path.join(root, rel);
    let rules = inherited;
    try {
      const text = await fs.readFile(path.join(abs, '.gitignore'), 'utf8');
      const own = text.split(/\r?\n/).map((l) => compileIgnore(l, rel)).filter((r): r is IgnoreRule => !!r);
      if (own.length) rules = inherited.concat(own);
    } catch {
      /* no .gitignore here */
    }
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ALWAYS_IGNORED_DIRS.has(e.name) || FALLBACK_IGNORED_DIRS.has(e.name)) continue;
        if (isIgnored(rules, childRel, true)) continue;
        await visit(childRel, rules);
      } else if (e.isFile()) {
        if (ALWAYS_IGNORED_FILES.has(e.name) || isIgnored(rules, childRel, false)) continue;
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        try {
          const st = await fs.stat(path.join(root, childRel));
          files.push({ path: childRel, size: st.size });
        } catch {
          /* raced with a delete */
        }
      }
    }
  }

  await visit('', extra);
  return { files, truncated, usedGit: false };
}

export async function walk(
  root: string,
  opts: { ignore?: string[]; git?: boolean; maxFiles?: number } = {},
): Promise<WalkResult> {
  const extra = (opts.ignore ?? []).map((p) => compileIgnore(p)).filter((r): r is IgnoreRule => !!r);
  const maxFiles = opts.maxFiles ?? 25000;
  const result = (opts.git !== false && (await walkGit(root, extra, maxFiles))) || (await walkFs(root, extra, maxFiles));
  result.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return result;
}

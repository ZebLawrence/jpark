import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AnalyzeOptions, DepKind, DirNode, Ecosystem, Edge, EdgeKind, ExternalNode, FileNode, GraphNode, Unresolved,
} from '../types.js';

const DEP_RANK: Record<DepKind, number> = { builtin: 6, prod: 5, peer: 4, optional: 3, dev: 2, unlisted: 1 };

/** Shared state handed to every language analyzer. */
export class Ctx {
  readonly nodes: GraphNode[] = [];
  readonly files = new Map<string, FileNode>();
  readonly dirs = new Map<string, DirNode>();
  readonly externals = new Map<string, ExternalNode>();
  readonly edges = new Map<string, Edge>();
  readonly unresolved: Unresolved[] = [];
  /** basename -> paths, for languages that resolve by path suffix (C includes, JVM imports). */
  readonly byBasename = new Map<string, string[]>();
  private textCache = new Map<string, Promise<string | null>>();

  constructor(
    readonly root: string,
    readonly options: AnalyzeOptions,
  ) {}

  hasFile(p: string): boolean {
    return this.files.has(p);
  }

  hasDir(p: string): boolean {
    return this.dirs.has(p);
  }

  /** Read a repo file as text (cached) — for manifests; sources are streamed by the analyzer. */
  readText(rel: string): Promise<string | null> {
    let hit = this.textCache.get(rel);
    if (!hit) {
      hit = fs.readFile(path.join(this.root, rel), 'utf8').catch(() => null);
      this.textCache.set(rel, hit);
    }
    return hit;
  }

  /** All scanned files whose basename is one of `names`. */
  filesNamed(...names: string[]): FileNode[] {
    const out: FileNode[] = [];
    for (const n of names) for (const p of this.byBasename.get(n) ?? []) out.push(this.files.get(p)!);
    return out;
  }

  /** Files whose path ends with `/suffix` (or equals it), nearest to `from` first. */
  findBySuffix(suffix: string, from: string): string | null {
    const base = suffix.slice(suffix.lastIndexOf('/') + 1);
    const candidates = (this.byBasename.get(base) ?? []).filter((p) => p === suffix || p.endsWith('/' + suffix));
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    let best = candidates[0];
    let bestScore = -1;
    for (const c of candidates) {
      const score = commonPrefixLength(c, from);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  /** Add an edge to a file or directory path. Returns false when the path is unknown. */
  link(from: FileNode, toPath: string, kind: EdgeKind): boolean {
    const target = this.files.get(toPath) ?? this.dirs.get(toPath);
    if (!target) return false;
    if (target.id === from.id) return true;
    this.addEdge(from.id, target.id, kind);
    return true;
  }

  external(
    from: FileNode | null,
    name: string,
    ecosystem: Ecosystem,
    dep: DepKind,
    kind: EdgeKind = 'import',
    version?: string,
  ): ExternalNode {
    const key = `${ecosystem}:${name}`;
    let node = this.externals.get(key);
    if (!node) {
      node = { id: this.nodes.length, type: 'external', name, ecosystem, dep };
      if (version) node.version = version;
      this.nodes.push(node);
      this.externals.set(key, node);
    } else {
      if (DEP_RANK[dep] > DEP_RANK[node.dep]) node.dep = dep;
      if (version && !node.version) node.version = version;
    }
    if (from) this.addEdge(from.id, node.id, kind);
    return node;
  }

  miss(from: FileNode, spec: string): void {
    if (this.unresolved.length < 5000) this.unresolved.push({ from: from.path, spec });
  }

  private addEdge(from: number, to: number, kind: EdgeKind): void {
    const key = `${from}>${to}`;
    const existing = this.edges.get(key);
    if (!existing) this.edges.set(key, { from, to, kind });
    else if (existing.kind === 'type' && kind !== 'type') existing.kind = kind;
  }
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

export interface LanguageAnalyzer {
  name: string;
  /** Lower-case extensions (without dot) this analyzer wants to see. */
  exts: string[];
  /** Runs once, before any file is analyzed — load manifests here. */
  prepare?(ctx: Ctx): Promise<void>;
  analyze(file: FileNode, source: string, ctx: Ctx): void;
  /** Runs once after all files — e.g. to register declared-but-unused dependencies. */
  finish?(ctx: Ctx): void;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Join + normalize posix paths. Returns null when the result escapes the root. */
export function joinPath(base: string, rel: string): string | null {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

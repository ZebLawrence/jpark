/**
 * The graph format shared by the analyzer (Node) and the viewer (browser).
 * Node ids are indexes into `Graph.nodes`.
 */

export type Category =
  | 'code'
  | 'test'
  | 'markup'
  | 'style'
  | 'data'
  | 'config'
  | 'doc'
  | 'media'
  | 'binary'
  | 'other';

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'gem' | 'jvm' | 'c' | 'other';

/** How an external dependency is declared in the nearest manifest. */
export type DepKind = 'prod' | 'dev' | 'peer' | 'optional' | 'builtin' | 'unlisted';

export type EdgeKind =
  | 'import' // static import / include / use
  | 'reexport' // export ... from
  | 'require' // CommonJS require
  | 'dynamic' // import()
  | 'type' // type-only import
  | 'style' // @import / @use
  | 'asset'; // url(), <img src>, new URL(..., import.meta.url)

export interface DirNode {
  id: number;
  type: 'dir';
  name: string;
  /** Posix path relative to the scan root; '' for the root itself. */
  path: string;
  parent: number;
}

export interface FileNode {
  id: number;
  type: 'file';
  name: string;
  path: string;
  parent: number;
  ext: string;
  lang: string;
  category: Category;
  size: number;
  lines: number;
}

export interface ExternalNode {
  id: number;
  type: 'external';
  name: string;
  ecosystem: Ecosystem;
  dep: DepKind;
  version?: string;
}

export type GraphNode = DirNode | FileNode | ExternalNode;

export interface Edge {
  from: number;
  /** A file, a directory (package-style imports, e.g. Go) or an external. */
  to: number;
  kind: EdgeKind;
  /** True when this edge is part of an import cycle. */
  cycle?: boolean;
}

export interface GraphStats {
  files: number;
  dirs: number;
  externals: number;
  edges: number;
  lines: number;
  bytes: number;
  unresolved: number;
  cycles: number;
  truncated: boolean;
  scanMs: number;
  languages: Record<string, { files: number; lines: number }>;
}

export interface Unresolved {
  from: string;
  spec: string;
}

export interface Graph {
  version: 1;
  name: string;
  /** Absolute path of the scan root on the machine that produced the graph. */
  root: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: Edge[];
  /** Strongly connected components with more than one file (import cycles). */
  cycles: number[][];
  unresolved: Unresolved[];
  stats: GraphStats;
}

export interface AnalyzeOptions {
  /** Extra ignore globs (gitignore syntax), on top of .gitignore. */
  ignore?: string[];
  /** Use `git ls-files` when the root is inside a git work tree. Default true. */
  git?: boolean;
  /** Hard cap on scanned files. Default 25000. */
  maxFiles?: number;
  /** Import alias map, e.g. { "@": "src" }. Merged with tsconfig paths. */
  alias?: Record<string, string>;
  /** Include manifest dependencies that are never imported. Default true. */
  includeUnusedDeps?: boolean;
}

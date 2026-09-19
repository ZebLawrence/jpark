import type { DirNode, ExternalNode, FileNode, Graph, GraphNode } from '../types.js';

/** Adjacency + containment lookups over a Graph, computed once per load. */
export class GraphIndex {
  readonly out: number[][];
  readonly inc: number[][];
  readonly childDirs: number[][];
  readonly childFiles: number[][];
  /** Pre-order interval per node; a node is inside a dir iff its `enter` falls in the dir's [enter, exit). */
  readonly enter: Int32Array;
  readonly exit: Int32Array;
  readonly filesBelow: Int32Array;
  readonly linesBelow: Float64Array;
  readonly depth: Int32Array;
  readonly dirs: DirNode[] = [];
  readonly files: FileNode[] = [];
  readonly externals: ExternalNode[] = [];
  readonly byPath = new Map<string, GraphNode>();

  constructor(readonly graph: Graph) {
    const n = graph.nodes.length;
    this.out = Array.from({ length: n }, () => []);
    this.inc = Array.from({ length: n }, () => []);
    this.childDirs = Array.from({ length: n }, () => []);
    this.childFiles = Array.from({ length: n }, () => []);
    this.enter = new Int32Array(n).fill(-1);
    this.exit = new Int32Array(n).fill(-1);
    this.filesBelow = new Int32Array(n);
    this.linesBelow = new Float64Array(n);
    this.depth = new Int32Array(n);

    for (const node of graph.nodes) {
      if (node.type === 'dir') {
        this.dirs.push(node);
        if (node.parent >= 0) this.childDirs[node.parent].push(node.id);
        this.byPath.set(node.path, node);
      } else if (node.type === 'file') {
        this.files.push(node);
        this.childFiles[node.parent].push(node.id);
        this.byPath.set(node.path, node);
      } else {
        this.externals.push(node);
        this.byPath.set(`ext:${node.ecosystem}:${node.name}`, node);
      }
    }
    const byName = (a: number, b: number) => {
      const x = graph.nodes[a].name.toLowerCase();
      const y = graph.nodes[b].name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    };
    for (const list of this.childDirs) list.sort(byName);
    for (const list of this.childFiles) list.sort(byName);

    graph.edges.forEach((e, i) => {
      this.out[e.from].push(i);
      this.inc[e.to].push(i);
    });

    let clock = 0;
    const visit = (dir: number, depth: number) => {
      this.enter[dir] = clock++;
      this.depth[dir] = depth;
      for (const f of this.childFiles[dir]) {
        this.enter[f] = clock++;
        this.exit[f] = clock;
        this.depth[f] = depth + 1;
        this.filesBelow[dir]++;
        this.linesBelow[dir] += (graph.nodes[f] as FileNode).lines;
      }
      for (const d of this.childDirs[dir]) {
        visit(d, depth + 1);
        this.filesBelow[dir] += this.filesBelow[d];
        this.linesBelow[dir] += this.linesBelow[d];
      }
      this.exit[dir] = clock;
    };
    if (this.dirs.length) visit(0, 0);
  }

  node(id: number): GraphNode {
    return this.graph.nodes[id];
  }

  isInside(id: number, dir: number): boolean {
    const t = this.enter[id];
    return t >= this.enter[dir] && t < this.exit[dir];
  }

  /** Stable identity across re-scans. */
  keyOf(node: GraphNode): string {
    return node.type === 'external' ? `ext:${node.ecosystem}:${node.name}` : node.path;
  }

  ancestors(id: number): number[] {
    const chain: number[] = [];
    let cur = this.graph.nodes[id];
    while (cur && cur.type !== 'external' && cur.parent >= 0) {
      chain.unshift(cur.parent);
      cur = this.graph.nodes[cur.parent];
    }
    return chain;
  }
}

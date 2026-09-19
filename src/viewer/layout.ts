import type { ExternalNode, FileNode } from '../types.js';
import type { GraphIndex } from './graphIndex.js';

export const CELL_W = 2.3;
export const CELL_D = 2.1;
export const PAD = 0.9;
export const PED_H = 0.4;
const SIBLING_GAP = 2.6;
const MIN_W = 4.2;
const MIN_D = 3.6;
/** Width : depth the whole landscape aims for; rows of child folders wrap to get there. */
const TARGET_ASPECT = 2.3;

export interface DirBox {
  id: number;
  x: number;
  z: number;
  w: number;
  d: number;
  level: number;
  /** 0..1 — inherited from the top-level folder so whole subtrees share a tint. */
  hue: number;
  labelHeight: number;
}

export interface FilePos {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Height of the block (or diameter, for spheres). */
  h: number;
}

export interface ExtPos {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
  importers: number;
}

/** A ground-level wire of the directory tree. `dir` owns it (for tinting). */
export interface Connector {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  dir: number;
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Layout {
  dirs: Map<number, DirBox>;
  files: Map<number, FilePos>;
  externals: Map<number, ExtPos>;
  connectors: Connector[];
  bounds: Bounds;
  /** Bounds of the directory tree alone (without the external-dependency bay). */
  treeBounds: Bounds;
}

export function fileHeight(f: FileNode): number {
  const lines = f.lines > 0 ? f.lines : f.size / 60;
  return 0.35 + Math.log2(1 + lines / 12) * 0.62;
}

interface Row {
  kids: number[];
  w: number;
  d: number;
  /** Room in front of the row for its folder names and the bus wire. */
  apron: number;
}

interface Measure {
  w: number;
  d: number;
  ownW: number;
  ownD: number;
  cols: number;
  labelHeight: number;
  rows: Row[];
  blockW: number;
}

/**
 * The FSN arrangement: the root pedestal sits at the front, every directory's children are laid
 * out behind it, and each subtree owns a private rectangle of ground. Unlike the 1993 original,
 * long rows of children wrap into shelves so big repos stay roughly landscape-shaped instead of
 * becoming one endless horizon.
 */
export function computeLayout(index: GraphIndex): Layout {
  const dirs = new Map<number, DirBox>();
  const files = new Map<number, FilePos>();
  const connectors: Connector[] = [];
  const measures = new Map<number, Measure>();

  const measure = (id: number, limit: number): Measure => {
    const n = index.childFiles[id].length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.7)));
    const fileRows = Math.max(1, Math.ceil(n / cols));
    const ownW = Math.max(MIN_W, cols * CELL_W + PAD * 2);
    const ownD = Math.max(MIN_D, fileRows * CELL_D + PAD * 2);
    const labelHeight = Math.min(4.5, 0.95 + Math.log2(1 + index.filesBelow[id] / 12) * 0.34);

    const kids = index.childDirs[id];
    const kidMeasures = kids.map((k) => measure(k, limit));
    const rows: Row[] = [];
    if (kids.length) {
      let row: Row = { kids: [], w: 0, d: 0, apron: 0 };
      kids.forEach((kid, i) => {
        const k = kidMeasures[i];
        const next = row.kids.length ? row.w + SIBLING_GAP + k.w : k.w;
        if (row.kids.length && next > limit) {
          rows.push(row);
          row = { kids: [], w: 0, d: 0, apron: 0 };
        }
        row.w = row.kids.length ? row.w + SIBLING_GAP + k.w : k.w;
        row.d = Math.max(row.d, k.d);
        row.apron = Math.max(row.apron, k.labelHeight + 3.4);
        row.kids.push(kid);
      });
      rows.push(row);
    }
    const blockW = rows.reduce((m, r) => Math.max(m, r.w), 0) + (rows.length > 1 ? 3 : 0);
    const blockD = rows.reduce((sum, r) => sum + r.apron + r.d, 0);
    const m: Measure = { w: Math.max(ownW, blockW), d: ownD + blockD, ownW, ownD, cols, labelHeight, rows, blockW };
    measures.set(id, m);
    return m;
  };

  const place = (id: number, cx: number, frontZ: number, level: number, hue: number) => {
    const m = measures.get(id)!;
    dirs.set(id, { id, x: cx, z: frontZ - m.ownD / 2, w: m.ownW, d: m.ownD, level, hue, labelHeight: m.labelHeight });

    // files: alphabetical, row 0 nearest the viewer
    const gridW = m.cols * CELL_W;
    index.childFiles[id].forEach((fid, i) => {
      const col = i % m.cols;
      const row = Math.floor(i / m.cols);
      files.set(fid, {
        id: fid,
        x: cx - gridW / 2 + (col + 0.5) * CELL_W,
        y: PED_H,
        z: frontZ - PAD - (row + 0.5) * CELL_D - 0.18,
        h: fileHeight(index.node(fid) as FileNode),
      });
    });

    if (!m.rows.length) return;
    const wrapped = m.rows.length > 1;
    const spineX = cx - m.blockW / 2 + 0.6;
    let rowTop = frontZ - m.ownD;
    let sibling = 0;
    const total = index.childDirs[id].length;
    const buses: number[] = [];
    for (const row of m.rows) {
      const busZ = rowTop - 1.6;
      const rowFront = rowTop - row.apron;
      buses.push(busZ);
      let cursor = cx - row.w / 2 + (wrapped ? 1.5 : 0);
      let minX = wrapped ? spineX : cx;
      let maxX = wrapped && buses.length > 1 ? spineX : cx;
      for (const kid of row.kids) {
        const k = measures.get(kid)!;
        const kx = cursor + k.w / 2;
        const childHue = level === 0 ? (0.5 + (sibling / Math.max(1, total)) * 0.9) % 1 : hue;
        place(kid, kx, rowFront, level + 1, childHue);
        connectors.push({ x1: kx, z1: busZ, x2: kx, z2: rowFront, dir: kid });
        minX = Math.min(minX, kx);
        maxX = Math.max(maxX, kx);
        cursor += k.w + SIBLING_GAP;
        sibling++;
      }
      connectors.push({ x1: minX, z1: busZ, x2: maxX, z2: busZ, dir: id });
      rowTop = rowFront - row.d;
    }
    connectors.push({ x1: cx, z1: frontZ - m.ownD, x2: cx, z2: buses[0], dir: id });
    if (wrapped) connectors.push({ x1: spineX, z1: buses[0], x2: spineX, z2: buses[buses.length - 1], dir: id });
  };

  if (index.dirs.length) {
    // One global wrap width, found by bisection: wider limit -> flatter, more classic FSN tree.
    let root = measure(0, Infinity);
    if (root.w / root.d > TARGET_ASPECT) {
      let lo = 30;
      let hi = root.w;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        const m = measure(0, mid);
        if (m.w / m.d > TARGET_ASPECT) hi = mid;
        else lo = mid;
      }
      root = measure(0, hi);
    }
    place(0, 0, root.ownD / 2, 0, 0.5);
  }

  const treeBounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const b of dirs.values()) {
    treeBounds.minX = Math.min(treeBounds.minX, b.x - b.w / 2);
    treeBounds.maxX = Math.max(treeBounds.maxX, b.x + b.w / 2);
    treeBounds.minZ = Math.min(treeBounds.minZ, b.z - b.d / 2);
    treeBounds.maxZ = Math.max(treeBounds.maxZ, b.z + b.d / 2);
  }
  if (!dirs.size) Object.assign(treeBounds, { minX: -5, maxX: 5, minZ: -5, maxZ: 5 });

  // ── external dependencies: terraced arcs "off-shore", in front of the root ──
  const externals = new Map<number, ExtPos>();
  const importers = new Map<number, number>();
  for (const e of index.externals) importers.set(e.id, index.inc[e.id].length);
  const ordered = [...index.externals].sort(
    (a: ExternalNode, b: ExternalNode) => importers.get(b.id)! - importers.get(a.id)! || (a.name < b.name ? -1 : 1),
  );
  const origin = { x: 0, z: treeBounds.maxZ + 10 };
  const SWEEP = (150 * Math.PI) / 180;
  let ring = 0;
  let placed = 0;
  while (placed < ordered.length) {
    const radius = 20 + ring * 9.5;
    const capacity = Math.max(3, Math.floor((radius * SWEEP) / 7.5));
    const count = Math.min(capacity, ordered.length - placed);
    for (let i = 0; i < count; i++) {
      const ext = ordered[placed + i];
      // centre-out: 0, +1, -1, +2, -2 … so the most-used packages sit in the middle
      const slot = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      const theta = (slot / Math.max(1, capacity - 1)) * SWEEP;
      const n = importers.get(ext.id)!;
      externals.set(ext.id, {
        id: ext.id,
        x: origin.x + Math.sin(theta) * radius,
        y: 7 + ring * 2.2 + (n ? Math.min(5, Math.log2(1 + n) * 0.8) : 0),
        z: origin.z + Math.cos(theta) * radius,
        r: n ? 0.75 + Math.log2(1 + n) * 0.42 : 0.5,
        importers: n,
      });
    }
    placed += count;
    ring++;
  }

  const bounds = { ...treeBounds };
  for (const e of externals.values()) {
    bounds.minX = Math.min(bounds.minX, e.x - e.r);
    bounds.maxX = Math.max(bounds.maxX, e.x + e.r);
    bounds.maxZ = Math.max(bounds.maxZ, e.z + e.r);
  }
  return { dirs, files, externals, connectors, bounds, treeBounds };
}

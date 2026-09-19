import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DodecahedronGeometry, DoubleSide, Group, HalfFloatType,
  HemisphereLight, IcosahedronGeometry, InstancedMesh, LineBasicMaterial, LineSegments, Mesh, MeshStandardMaterial,
  Object3D, OctahedronGeometry, PerspectiveCamera, PlaneGeometry, Raycaster, Scene, ShaderMaterial, SphereGeometry,
  TetrahedronGeometry, Vector2, Vector3, WebGLRenderTarget, WebGLRenderer,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { FileNode, Graph } from '../types.js';
import { ArcBatch, ArcKind, ArcState, ArcStyle, type ArcSpec } from './arcs.js';
import { GraphIndex } from './graphIndex.js';
import { LabelLayer, type LabelSpec } from './labels.js';
import { CELL_W, PED_H, computeLayout, type Layout } from './layout.js';
import { CATEGORY_SHAPE, DEP_COLOR, DEP_SHAPE, UI, hslToHex, langColor, type Shape } from './theme.js';

export type EdgeMode = 'all' | 'focus' | 'folders' | 'off';

export interface ViewOptions {
  edgeMode: EdgeMode;
  externals: boolean;
  labels: boolean;
  bloom: boolean;
  /** Follow imports transitively when highlighting a selection. */
  transitive: boolean;
  cyclesOnly: boolean;
  spotlightLang: string | null;
}

export interface WorldEvents {
  onSelect(id: number | null): void;
  onHover(id: number | null, x: number, y: number): void;
  onFocusDir(id: number): void;
}

interface NodeBody {
  x: number;
  y: number;
  z: number;
  /** Half extents. */
  rx: number;
  ry: number;
  rz: number;
  mesh: InstancedMesh;
  instance: number;
  color: Color;
}

interface Flight {
  fromPos: Vector3;
  fromTarget: Vector3;
  toPos: Vector3;
  toTarget: Vector3;
  start: number;
  duration: number;
  lift: number;
}

const tmpObj = new Object3D();
const tmpColor = new Color();
const WHITE = new Color('#ffffff');

function unitGeometry(shape: Shape | 'icosa' | 'dodeca'): BufferGeometry {
  let g: BufferGeometry;
  switch (shape) {
    case 'box': g = new BoxGeometry(1, 1, 1); break;
    case 'slab': g = new BoxGeometry(1, 1, 1); break;
    case 'cylinder': g = new CylinderGeometry(0.5, 0.5, 1, 20); break;
    case 'pyramid': g = new ConeGeometry(0.7, 1, 4).rotateY(Math.PI / 4); break;
    case 'hex': g = new CylinderGeometry(0.56, 0.56, 1, 6); break;
    case 'prism': g = new CylinderGeometry(0.64, 0.64, 1, 3); break;
    case 'octa': g = new OctahedronGeometry(0.5); break;
    case 'tetra': g = new TetrahedronGeometry(0.62); break;
    case 'sphere': g = new SphereGeometry(0.5, 18, 12); break;
    case 'icosa': g = new IcosahedronGeometry(1, 0); break;
    case 'dodeca': g = new DodecahedronGeometry(1, 0); break;
  }
  if (shape !== 'icosa' && shape !== 'dodeca') {
    // base on y = 0, exactly one unit tall, so instance scale.y is the block height
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    g.translate(0, -bb.min.y, 0);
    g.scale(1, 1 / (bb.max.y - bb.min.y), 1);
  }
  return (g.index ? g.toNonIndexed() : g).deleteAttribute('uv');
}

/** Standard material + per-instance glow and a floor-to-top brightness ramp. */
function blockMaterial(glow: number, ramp: boolean): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ roughness: 0.42, metalness: 0.18, flatShading: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRamp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvRamp = ${ramp ? 'position.y' : '1.0'};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRamp;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.5, 1.12, vRamp);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance += vColor.rgb * ${glow.toFixed(2)} * mix(0.35, 1.0, vRamp);\n#endif`,
      );
  };
  return m;
}

export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(50, 1, 0.5, 20000);
  readonly controls: MapControls;
  index!: GraphIndex;
  layout!: Layout;
  options: ViewOptions = {
    edgeMode: 'all', externals: true, labels: true, bloom: true, transitive: false, cyclesOnly: false, spotlightLang: null,
  };

  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private content = new Group();
  private bodies = new Map<number, NodeBody>();
  private pickables: InstancedMesh[] = [];
  private externalObjects: Object3D[] = [];
  private labelLayers: LabelLayer[] = [];
  private externalLabels: LabelLayer | null = null;
  private arcs: ArcBatch | null = null;
  private folderArcs: ArcBatch | null = null;
  private folderArcEnds: [from: number, to: number][] = [];
  private outlines: LineSegments | null = null;
  private beacon: Mesh;
  private marker: LineSegments;
  private ground: Mesh;
  private raycaster = new Raycaster();
  private pointer = new Vector2();
  private pointerPx = { x: 0, y: 0 };
  private pointerDirty = false;
  private pointerInside = false;
  private downAt: { x: number; y: number; t: number } | null = null;
  private keys = new Set<string>();
  private flight: Flight | null = null;
  private lastFrame = performance.now();
  private focusTimer = 0;
  private focusDir = 0;
  private extent = 100;
  private disposed = false;
  selected: number | null = null;
  hovered: number | null = null;

  constructor(
    private container: HTMLElement,
    graph: Graph,
    private events: WorldEvents,
  ) {
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(UI.bg);
    container.appendChild(renderer.domElement);
    renderer.domElement.className = 'jp-canvas';
    this.renderer = renderer;

    const target = new WebGLRenderTarget(4, 4, { samples: 4, type: HalfFloatType });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(4, 4), 0.5, 0.5, 0.42);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new HemisphereLight('#a8e4ff', '#03131b', 1.0));
    const key = new DirectionalLight('#ffffff', 1.7);
    key.position.set(-0.45, 1, 0.65);
    const rim = new DirectionalLight('#27d7d0', 0.8);
    rim.position.set(0.6, 0.35, -1);
    this.scene.add(key, rim);

    this.ground = this.makeGround();
    this.scene.add(this.ground, this.makeSky(), this.content);

    this.beacon = this.makeBeacon();
    this.marker = this.makeMarker();
    this.scene.add(this.beacon, this.marker);

    const controls = new MapControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.zoomToCursor = true;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 2.5;
    controls.zoomSpeed = 1.6;
    controls.panSpeed = 1.2;
    controls.rotateSpeed = 0.6;
    this.controls = controls;

    this.bind();
    this.resize();
    this.load(graph, true);
    renderer.setAnimationLoop(() => this.frame());
  }

  // ───────────────────────────── scene furniture ─────────────────────────────

  private makeGround(): Mesh {
    const mat = new ShaderMaterial({
      uniforms: {
        uBase: { value: new Color(UI.ground) },
        uMinor: { value: new Color(UI.grid) },
        uMajor: { value: new Color(UI.gridMajor) },
        uFade: { value: 600 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBase; uniform vec3 uMinor; uniform vec3 uMajor; uniform float uFade;
        varying vec3 vWorld;
        float grid(vec2 p, float cell) {
          vec2 c = p / cell;
          vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(g.x, g.y), 1.0);
        }
        void main() {
          float d = distance(cameraPosition, vWorld);
          float minor = grid(vWorld.xz, 5.0) * exp(-d / (uFade * 0.35));
          float major = grid(vWorld.xz, 50.0) * exp(-d / (uFade * 1.6));
          vec3 col = uBase + uMinor * minor * 0.75 + uMajor * major * 0.9;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mesh = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    mesh.position.y = -0.02;
    mesh.renderOrder = -1;
    return mesh;
  }

  private makeSky(): Mesh {
    const mat = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          float h = normalize(vDir).y;
          vec3 horizon = vec3(0.016, 0.085, 0.11);
          vec3 zenith = vec3(0.004, 0.012, 0.022);
          vec3 col = mix(horizon, zenith, smoothstep(0.0, 0.42, h));
          col = mix(col, vec3(0.008, 0.024, 0.035), smoothstep(0.0, -0.08, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mesh = new Mesh(new SphereGeometry(1, 24, 16), mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2;
    return mesh;
  }

  private makeBeacon(): Mesh {
    const geo = new CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
    const mat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      uniforms: { uColor: { value: new Color('#7ff6ff') }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vY;
        void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime; varying float vY;
        void main() {
          float a = pow(1.0 - vY, 2.6) * (0.13 + 0.04 * sin(uTime * 3.0 - vY * 30.0));
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    const mesh = new Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 6;
    return mesh;
  }

  private makeMarker(): LineSegments {
    const p: number[] = [];
    const c = [-1, 1];
    // 12 edges of a unit cube centred on the origin
    for (const a of c) for (const b of c) {
      p.push(-1, a, b, 1, a, b, a, -1, b, a, 1, b, a, b, -1, a, b, 1);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(p), 3));
    const lines = new LineSegments(geo, new LineBasicMaterial({ color: '#d9feff', transparent: true, depthTest: false }));
    lines.visible = false;
    lines.renderOrder = 7;
    return lines;
  }

  // ───────────────────────────── building the landscape ─────────────────────────────

  /** (Re)build everything that depends on the graph. Camera and selection survive a reload. */
  load(graph: Graph, first = false): void {
    const keepKey = this.selected != null ? this.index.keyOf(this.index.node(this.selected)) : null;
    this.clearContent();
    this.index = new GraphIndex(graph);
    this.layout = computeLayout(this.index);
    const { index, layout } = this;
    const b = layout.bounds;
    this.extent = Math.max(60, b.maxX - b.minX, b.maxZ - b.minZ);
    this.ground.scale.setScalar(this.extent * 8 + 4000);
    this.ground.position.set((b.minX + b.maxX) / 2, -0.02, (b.minZ + b.maxZ) / 2);
    (this.ground.material as ShaderMaterial).uniforms.uFade.value = Math.max(500, this.extent * 1.2);
    this.controls.maxDistance = this.extent * 3 + 200;

    this.buildPedestals();
    this.buildFiles();
    this.buildExternals();
    this.buildArcs();
    this.buildLabels();

    this.selected = null;
    this.hovered = null;
    const again = keepKey != null ? index.byPath.get(keepKey) : undefined;
    if (first) this.overview(false, true);
    this.applyOptions();
    this.select(again ? again.id : null, false);
  }

  private clearContent(): void {
    for (const l of this.labelLayers) l.dispose();
    this.labelLayers = [];
    this.externalLabels = null;
    this.arcs?.dispose();
    this.folderArcs?.dispose();
    this.arcs = this.folderArcs = null;
    this.content.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.content.clear();
    this.bodies.clear();
    this.pickables = [];
    this.externalObjects = [];
    this.outlines = null;
  }

  private instanced(
    geo: BufferGeometry,
    mat: MeshStandardMaterial,
    items: { id: number; x: number; y: number; z: number; sx: number; sy: number; sz: number; ry?: number; color: string }[],
    bodyHalf: (i: number) => [number, number, number],
  ): InstancedMesh {
    const mesh = new InstancedMesh(geo, mat, items.length);
    const ids = new Int32Array(items.length);
    items.forEach((it, i) => {
      tmpObj.position.set(it.x, it.y, it.z);
      tmpObj.rotation.set(0, it.ry ?? 0, 0);
      tmpObj.scale.set(it.sx, it.sy, it.sz);
      tmpObj.updateMatrix();
      mesh.setMatrixAt(i, tmpObj.matrix);
      const color = new Color(it.color);
      mesh.setColorAt(i, color);
      ids[i] = it.id;
      const [rx, ry, rz] = bodyHalf(i);
      this.bodies.set(it.id, { x: it.x, y: it.y + ry, z: it.z, rx, ry, rz, mesh, instance: i, color });
    });
    mesh.userData.ids = ids;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.content.add(mesh);
    this.pickables.push(mesh);
    return mesh;
  }

  private dirColor(hue: number, level: number, l: number, s = 0.62): string {
    return hslToHex(hue, level === 0 ? 0.1 : s, l);
  }

  private buildPedestals(): void {
    const { layout } = this;
    const boxes = [...layout.dirs.values()];
    const items = boxes.map((d) => ({
      id: d.id, x: d.x, y: 0, z: d.z, sx: d.w, sy: PED_H, sz: d.d, color: this.dirColor(d.hue, d.level, 0.2),
    }));
    this.instanced(unitGeometry('box'), blockMaterial(0.2, false), items, (i) => [boxes[i].w / 2, PED_H / 2, boxes[i].d / 2]);

    // glowing rims + the tree of connectors on the ground
    const pos: number[] = [];
    const col: number[] = [];
    const push = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, c: Color) => {
      pos.push(x1, y1, z1, x2, y2, z2);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    for (const d of boxes) {
      const rim = tmpColor.set(this.dirColor(d.hue, d.level, 0.58, 0.85)).clone();
      const x0 = d.x - d.w / 2, x1 = d.x + d.w / 2, z0 = d.z - d.d / 2, z1 = d.z + d.d / 2;
      for (const y of [PED_H + 0.01, 0.01]) {
        const c = y > 0.1 ? rim : rim.clone().multiplyScalar(0.45);
        push(x0, y, z0, x1, y, z0, c); push(x1, y, z0, x1, y, z1, c);
        push(x1, y, z1, x0, y, z1, c); push(x0, y, z1, x0, y, z0, c);
      }
    }
    for (const c of layout.connectors) {
      const d = layout.dirs.get(c.dir)!;
      const wire = tmpColor.set(this.dirColor(d.hue, d.level, 0.5, 0.8)).clone().multiplyScalar(0.55);
      push(c.x1, 0.03, c.z1, c.x2, 0.03, c.z2, wire);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
    this.outlines = new LineSegments(geo, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    this.outlines.frustumCulled = false;
    this.content.add(this.outlines);
  }

  private buildFiles(): void {
    const { index, layout } = this;
    const byShape = new Map<Shape, { node: FileNode; foot: [number, number]; height: number }[]>();
    for (const f of index.files) {
      const p = layout.files.get(f.id);
      if (!p) continue;
      const shape = CATEGORY_SHAPE[f.category];
      let foot: [number, number] = [1.15, 1.15];
      let height = p.h;
      if (shape === 'slab') {
        foot = [1.6, 1.2];
        height = 0.14 + p.h * 0.22;
      } else if (shape === 'sphere') {
        const d = Math.min(1.7, 0.7 + Math.log2(1 + f.size / 30000) * 0.22);
        foot = [d, d];
        height = d;
      } else if (shape === 'octa' || shape === 'tetra') {
        foot = [1.25, 1.25];
        height = Math.max(0.9, p.h * 0.85);
      } else if (shape === 'pyramid') {
        height = Math.max(0.9, p.h);
      }
      p.h = height;
      const list = byShape.get(shape) ?? [];
      list.push({ node: f, foot, height });
      byShape.set(shape, list);
    }
    for (const [shape, list] of byShape) {
      const items = list.map(({ node, foot, height }) => {
        const p = layout.files.get(node.id)!;
        return { id: node.id, x: p.x, y: p.y, z: p.z, sx: foot[0], sy: height, sz: foot[1], color: langColor(node.lang) };
      });
      this.instanced(unitGeometry(shape), blockMaterial(0.5, true), items, (i) => [list[i].foot[0] / 2, list[i].height / 2, list[i].foot[1] / 2]);
    }
  }

  private buildExternals(): void {
    const { index, layout } = this;
    const byShape = new Map<string, typeof index.externals>();
    for (const e of index.externals) {
      const key = DEP_SHAPE[e.dep];
      const list = byShape.get(key) ?? [];
      list.push(e);
      byShape.set(key, list);
    }
    for (const [shape, list] of byShape) {
      const geo = shape === 'octa' ? new OctahedronGeometry(1)
        : shape === 'tetra' ? new TetrahedronGeometry(1.15)
        : unitGeometry(shape as 'icosa' | 'dodeca');
      const items = list.map((e) => {
        const p = layout.externals.get(e.id)!;
        const unused = p.importers === 0;
        const color = tmpColor.set(DEP_COLOR[e.dep]).multiplyScalar(unused ? 0.32 : 1).getHexString();
        return { id: e.id, x: p.x, y: p.y - p.r, z: p.z, sx: p.r, sy: p.r, sz: p.r, ry: (e.id * 1.7) % Math.PI, color: `#${color}` };
      });
      // geometry is centred, so lift the instance to its centre and fix the body accordingly
      const mesh = this.instanced(geo, blockMaterial(0.75, false), items.map((it, i) => ({ ...it, y: it.y + layout.externals.get(list[i].id)!.r })), (i) => {
        const r = layout.externals.get(list[i].id)!.r;
        return [r, 0, r];
      });
      list.forEach((e) => {
        const body = this.bodies.get(e.id)!;
        const r = layout.externals.get(e.id)!.r;
        body.ry = r;
      });
      this.externalObjects.push(mesh);
    }
    // tethers down to the water line
    const pos: number[] = [];
    for (const p of layout.externals.values()) pos.push(p.x, 0, p.z, p.x, p.y - p.r * 1.1, p.z);
    if (pos.length) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      const tethers = new LineSegments(geo, new LineBasicMaterial({ color: '#3a2c12', transparent: true, opacity: 0.9 }));
      tethers.frustumCulled = false;
      this.content.add(tethers);
      this.externalObjects.push(tethers);
    }
  }

  private anchor(id: number): [number, number, number] {
    const b = this.bodies.get(id)!;
    const node = this.index.node(id);
    return node.type === 'external' ? [b.x, b.y, b.z] : [b.x, b.y + b.ry, b.z];
  }

  private buildArcs(): void {
    const { index } = this;
    const graph = index.graph;
    const specs: ArcSpec[] = graph.edges.map((e) => ({
      from: this.anchor(e.from),
      to: this.anchor(e.to),
      kind: e.cycle ? ArcKind.Cycle : index.node(e.to).type === 'external' ? ArcKind.External : ArcKind.Internal,
      style: e.kind === 'type' ? ArcStyle.Dashed : e.kind === 'dynamic' ? ArcStyle.Dotted : ArcStyle.Solid,
      fade: Math.min(1, 2.6 / Math.sqrt(index.inc[e.to].length)),
    }));
    this.arcs = new ArcBatch(this.content, specs);
    this.arcs.dim = specs.length > 6000 ? 0.05 : specs.length > 1500 ? 0.09 : 0.17;

    // folder-level bundles
    const bundles = new Map<string, { from: number; to: number; count: number }>();
    for (const e of graph.edges) {
      const from = (index.node(e.from) as FileNode).parent;
      const target = index.node(e.to);
      const to = target.type === 'file' ? target.parent : target.id;
      if (from === to) continue;
      const key = `${from}>${to}`;
      const hit = bundles.get(key);
      if (hit) hit.count++;
      else bundles.set(key, { from, to, count: 1 });
    }
    const list = [...bundles.values()];
    this.folderArcEnds = list.map((b) => [b.from, b.to]);
    this.folderArcs = new ArcBatch(
      this.content,
      list.map((b) => ({
        from: this.anchor(b.from),
        to: this.anchor(b.to),
        kind: index.node(b.to).type === 'external' ? ArcKind.External : ArcKind.Internal,
        style: ArcStyle.Solid,
        weight: Math.min(3, 1 + Math.log2(b.count) * 0.5),
      })),
    );
    this.folderArcs.dim = list.length > 3000 ? 0.1 : 0.3;
  }

  private buildLabels(): void {
    const { index, layout } = this;
    const dirSpecs: LabelSpec[] = [];
    for (const d of layout.dirs.values()) {
      const c = tmpColor.set(this.dirColor(d.hue, d.level, 0.62, 0.75));
      dirSpecs.push({
        text: index.node(d.id).name + (d.level === 0 ? '' : '/'),
        x: d.x, y: 0.04, z: d.z + d.d / 2 + 0.5 + d.labelHeight / 2,
        height: d.labelHeight, maxWidth: Math.max(d.w + 2.4, d.labelHeight * 4),
        color: [c.r, c.g, c.b],
        fadeFar: 260 + d.labelHeight * 330,
      });
    }
    this.labelLayers.push(new LabelLayer(this.content, dirSpecs, 52));

    const fileSpecs: LabelSpec[] = [];
    const MAX_FILE_LABELS = 9000;
    for (const f of index.files) {
      if (fileSpecs.length >= MAX_FILE_LABELS) break;
      const p = layout.files.get(f.id)!;
      const body = this.bodies.get(f.id)!;
      fileSpecs.push({
        text: f.name, x: p.x, y: PED_H + 0.025, z: p.z + body.rz + 0.27,
        height: 0.3, maxWidth: CELL_W - 0.18, color: [0.5, 0.66, 0.7], fadeFar: 95,
      });
    }
    this.labelLayers.push(new LabelLayer(this.content, fileSpecs, 32));

    const extSpecs: LabelSpec[] = [];
    for (const e of index.externals) {
      const p = layout.externals.get(e.id)!;
      const c = tmpColor.set(DEP_COLOR[e.dep]).lerp(WHITE, 0.25).multiplyScalar(p.importers ? 0.8 : 0.42);
      extSpecs.push({
        text: e.name, x: p.x, y: p.y - p.r - 0.75, z: p.z, height: p.importers ? 0.95 : 0.7, maxWidth: 8.5,
        color: [c.r, c.g, c.b], billboard: true, fadeFar: 420,
      });
    }
    this.externalLabels = new LabelLayer(this.content, extSpecs, 34);
    this.labelLayers.push(this.externalLabels);
  }

  // ───────────────────────────── options, selection, highlighting ─────────────────────────────

  setOptions(patch: Partial<ViewOptions>): void {
    Object.assign(this.options, patch);
    this.applyOptions();
  }

  private applyOptions(): void {
    const o = this.options;
    for (const obj of this.externalObjects) obj.visible = o.externals;
    for (const l of this.labelLayers) l.visible = o.labels;
    if (this.externalLabels) this.externalLabels.visible = o.labels && o.externals;
    if (this.arcs) this.arcs.visible = o.edgeMode === 'all' || o.edgeMode === 'focus';
    if (this.folderArcs) this.folderArcs.visible = o.edgeMode === 'folders';
    this.refresh();
  }

  /** Nodes whose edges should light up for the current selection/hover, and in which direction. */
  private highlightSets(id: number): { outgoing: Set<number>; incoming: Set<number>; related: Set<number> } {
    const { index } = this;
    const graph = index.graph;
    const node = index.node(id);
    const outgoing = new Set<number>();
    const incoming = new Set<number>();
    const related = new Set<number>([id]);
    if (node.type === 'dir') {
      graph.edges.forEach((e, i) => {
        const a = index.isInside(e.from, id);
        const b = index.node(e.to).type !== 'external' && index.isInside(e.to, id);
        if (a && !b) {
          outgoing.add(i);
          related.add(e.to);
        } else if (!a && b) {
          incoming.add(i);
          related.add(e.from);
        }
      });
      return { outgoing, incoming, related };
    }
    const walk = (start: number, adj: number[][], pick: (i: number) => number, into: Set<number>) => {
      const seen = new Set([start]);
      let frontier = [start];
      while (frontier.length) {
        const next: number[] = [];
        for (const n of frontier) {
          for (const ei of adj[n]) {
            into.add(ei);
            const other = pick(ei);
            related.add(other);
            if (this.options.transitive && !seen.has(other)) {
              seen.add(other);
              next.push(other);
            }
          }
        }
        frontier = next;
      }
    };
    walk(id, index.out, (i) => graph.edges[i].to, outgoing);
    walk(id, index.inc, (i) => graph.edges[i].from, incoming);
    return { outgoing, incoming, related };
  }

  /** Recompute arc states and block colors from selection + hover + options. */
  refresh(): void {
    if (!this.arcs || !this.folderArcs) return;
    const { index, options: o } = this;
    const graph = index.graph;
    const focusId = this.selected ?? this.hovered;
    const sets = focusId != null ? this.highlightSets(focusId) : null;
    const hard = this.selected != null; // hover previews never mute the rest

    graph.edges.forEach((e, i) => {
      let state: ArcState = o.edgeMode === 'focus' ? ArcState.Hidden : ArcState.Normal;
      if (sets) {
        if (sets.outgoing.has(i)) state = ArcState.Outgoing;
        else if (sets.incoming.has(i)) state = ArcState.Incoming;
        else if (hard && o.edgeMode !== 'focus') state = ArcState.Muted;
      }
      if (!o.externals && index.node(e.to).type === 'external') state = ArcState.Hidden;
      if (o.cyclesOnly && !e.cycle) state = ArcState.Hidden;
      this.arcs!.setState(i, state);
    });
    this.arcs.commit();

    const focusNode = focusId != null ? index.node(focusId) : null;
    const focusDir = focusNode ? (focusNode.type === 'file' ? focusNode.parent : focusNode.id) : null;
    this.folderArcEnds.forEach(([from, to], i) => {
      let state: ArcState = ArcState.Normal;
      if (focusDir != null && focusNode) {
        const isDir = focusNode.type === 'dir';
        const a = isDir ? index.isInside(from, focusDir) : from === focusDir;
        const toNode = index.node(to);
        const b = toNode.type === 'external' ? to === focusDir : isDir ? index.isInside(to, focusDir) : to === focusDir;
        if (a && !b) state = ArcState.Outgoing;
        else if (b && !a) state = ArcState.Incoming;
        else if (hard) state = ArcState.Muted;
      }
      if (!o.externals && index.node(to).type === 'external') state = ArcState.Hidden;
      this.folderArcs!.setState(i, state);
    });
    this.folderArcs.commit();

    // block colors
    const selSets = hard ? sets : null;
    const selNode = this.selected != null ? index.node(this.selected) : null;
    const touched = new Set<InstancedMesh>();
    for (const [id, body] of this.bodies) {
      const node = index.node(id);
      let k = 1;
      if (node.type !== 'dir') {
        if (selSets && selNode) {
          const inside = selNode.type === 'dir' && node.type === 'file' && index.isInside(id, selNode.id);
          k = selSets.related.has(id) || inside ? 1 : 0.2;
        }
        if (o.spotlightLang && node.type === 'file' && node.lang !== o.spotlightLang) k = Math.min(k, 0.12);
      } else if (selNode && selNode.type === 'dir') {
        k = index.isInside(id, selNode.id) ? 1.5 : 0.75;
      }
      tmpColor.copy(body.color).multiplyScalar(k);
      const isDir = node.type === 'dir';
      if (id === this.selected) isDir ? tmpColor.multiplyScalar(1.7).lerp(WHITE, 0.06) : tmpColor.lerp(WHITE, 0.5);
      else if (id === this.hovered) isDir ? tmpColor.multiplyScalar(1.6) : tmpColor.lerp(WHITE, 0.3);
      body.mesh.setColorAt(body.instance, tmpColor);
      touched.add(body.mesh);
    }
    for (const m of touched) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  select(id: number | null, fly = false): void {
    this.selected = id;
    this.refresh();
    const body = id != null ? this.bodies.get(id) : null;
    this.beacon.visible = this.marker.visible = !!body;
    if (body && id != null) {
      const isDir = this.index.node(id).type === 'dir';
      const r = Math.max(body.rx, body.rz);
      this.marker.position.set(body.x, body.y, body.z);
      this.marker.scale.set(body.rx + 0.12, body.ry + 0.12, body.rz + 0.12);
      this.beacon.position.set(body.x, body.y + body.ry, body.z);
      const br = isDir ? 0.9 : Math.min(r * 0.8, 1.1);
      this.beacon.scale.set(br, isDir ? 60 : 40, br);
      if (fly) this.flyToNode(id);
    }
    this.events.onSelect(id);
  }

  private setHover(id: number | null): void {
    if (id === this.hovered) return;
    this.hovered = id;
    this.renderer.domElement.style.cursor = id != null ? 'pointer' : '';
    this.refresh();
  }

  // ───────────────────────────── camera ─────────────────────────────

  private viewDirection(minElevation = 0.42, maxElevation = 1.05): Vector3 {
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.7, 1);
    const flat = Math.hypot(dir.x, dir.z) || 1e-6;
    const elevation = Math.min(maxElevation, Math.max(minElevation, Math.atan2(dir.y, flat)));
    const azX = dir.x / flat;
    const azZ = dir.z / flat;
    return new Vector3(azX * Math.cos(elevation), Math.sin(elevation), azZ * Math.cos(elevation));
  }

  flyTo(target: Vector3, distance: number, duration = 950): void {
    const toPos = target.clone().addScaledVector(this.viewDirection(), distance);
    const travel = this.controls.target.distanceTo(target);
    this.flight = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      toPos,
      toTarget: target.clone(),
      start: performance.now(),
      duration: Math.min(2200, duration + travel * 1.6),
      lift: Math.min(travel * 0.22, 160),
    };
  }

  flyToNode(id: number): void {
    const body = this.bodies.get(id);
    if (!body) return;
    const node = this.index.node(id);
    const r = Math.hypot(body.rx, body.rz);
    const dist = node.type === 'dir' ? Math.max(30, r * 2.5 + 16) : node.type === 'external' ? 16 + body.rx * 4 : 24 + body.ry * 3;
    this.flyTo(new Vector3(body.x, body.y, body.z), dist);
  }

  overview(animate = true, intro = false): void {
    const b = this.layout.treeBounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2 + (this.options.externals && this.layout.externals.size ? 10 : 0);
    const w = b.maxX - b.minX + 20;
    const d = b.maxZ - b.minZ + 50;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = Math.max(w / 2 / Math.tan(hfov / 2), (d * 0.62) / 2 / Math.tan(vfov / 2), 30) * 1.32;
    const target = new Vector3(cx, 0, cz);
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.set(cx, dist * 0.62, cz + dist * 0.78);
      if (intro) {
        const end = this.camera.position.clone();
        this.camera.position.set(cx, dist * 1.5, cz + dist * 1.9);
        this.flight = {
          fromPos: this.camera.position.clone(), fromTarget: target.clone(), toPos: end, toTarget: target.clone(),
          start: performance.now() + 150, duration: 2000, lift: 0,
        };
      }
      return;
    }
    const dir = new Vector3(0, 0.62, 0.78).normalize();
    this.flight = {
      fromPos: this.camera.position.clone(), fromTarget: this.controls.target.clone(),
      toPos: target.clone().addScaledVector(dir, dist), toTarget: target,
      start: performance.now(), duration: 1300, lift: 0,
    };
  }

  /** Walk the tree with the arrow keys, FSN style. */
  navigate(direction: 'parent' | 'child' | 'prev' | 'next'): void {
    const { index } = this;
    let cur = this.selected ?? this.focusDir;
    const node = index.node(cur);
    if (node.type === 'external') return;
    if (node.type === 'file') cur = node.parent;
    const dir = index.node(cur);
    if (dir.type !== 'dir') return;
    let next: number | undefined;
    if (direction === 'parent') next = dir.parent >= 0 ? dir.parent : undefined;
    else if (direction === 'child') next = index.childDirs[cur][Math.floor((index.childDirs[cur].length - 1) / 2)];
    else if (dir.parent >= 0) {
      const sibs = index.childDirs[dir.parent];
      next = sibs[sibs.indexOf(cur) + (direction === 'next' ? 1 : -1)];
    }
    if (next != null) this.select(next, true);
  }

  /** Slide the camera so it looks at (x, z), keeping its current angle and height. */
  panTo(x: number, z: number): void {
    this.flight = null;
    const dx = x - this.controls.target.x;
    const dz = z - this.controls.target.z;
    this.controls.target.x += dx;
    this.controls.target.z += dz;
    this.camera.position.x += dx;
    this.camera.position.z += dz;
  }

  get currentFocusDir(): number {
    return this.focusDir;
  }

  // ───────────────────────────── input ─────────────────────────────

  private pick(): number | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets = this.options.externals ? this.pickables : this.pickables.filter((m) => !this.externalObjects.includes(m));
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      if (h.instanceId == null) continue;
      return (h.object.userData.ids as Int32Array)[h.instanceId];
    }
    return null;
  }

  private bind(): void {
    const el = this.renderer.domElement;
    const setPointer = (e: PointerEvent | MouseEvent) => {
      const r = el.getBoundingClientRect();
      this.pointerPx = { x: e.clientX, y: e.clientY };
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    el.addEventListener('pointermove', (e) => {
      setPointer(e);
      this.pointerInside = true;
      this.pointerDirty = e.buttons === 0;
    });
    el.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.setHover(null);
      this.events.onHover(null, 0, 0);
    });
    el.addEventListener('pointerdown', (e) => {
      setPointer(e);
      this.flight = null;
      this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    el.addEventListener('wheel', () => (this.flight = null), { passive: true });
    el.addEventListener('pointerup', (e) => {
      const d = this.downAt;
      this.downAt = null;
      if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 600) return;
      setPointer(e);
      const id = this.pick();
      if (id == null) return void this.select(null);
      // folders are destinations: one click flies there. Files and packages just get selected.
      this.select(id, this.index.node(id).type === 'dir');
    });
    el.addEventListener('dblclick', (e) => {
      setPointer(e);
      const id = this.pick();
      if (id != null) this.select(id, true);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', () => this.keys.clear());
  }

  private onKey = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if ('wasdqerf'.includes(k) && k.length === 1) {
      if (e.type === 'keydown') {
        this.keys.add(k);
        this.flight = null;
      } else this.keys.delete(k);
    }
    if (e.key === 'Shift') e.type === 'keydown' ? this.keys.add('shift') : this.keys.delete('shift');
  };

  private resize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    // Centre the scene in the space the left HUD panel leaves free.
    if (w > 900) this.camera.setViewOffset(w, h, -115, 0, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
  };

  // ───────────────────────────── frame loop ─────────────────────────────

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const { camera, controls } = this;

    if (this.flight) {
      const f = this.flight;
      const raw = Math.min(1, Math.max(0, (now - f.start) / f.duration));
      const k = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      camera.position.lerpVectors(f.fromPos, f.toPos, k);
      camera.position.y += Math.sin(Math.PI * k) * f.lift;
      controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (raw >= 1) this.flight = null;
    }

    if (this.keys.size) {
      const offset = camera.position.clone().sub(controls.target);
      const dist = offset.length();
      const speed = (this.keys.has('shift') ? 3.2 : 1.2) * Math.max(6, dist) * dt;
      const fwd = new Vector3(-offset.x, 0, -offset.z).normalize();
      const right = new Vector3(-fwd.z, 0, fwd.x);
      const move = new Vector3();
      if (this.keys.has('w')) move.add(fwd);
      if (this.keys.has('s')) move.sub(fwd);
      if (this.keys.has('d')) move.add(right);
      if (this.keys.has('a')) move.sub(right);
      if (move.lengthSq()) {
        move.normalize().multiplyScalar(speed);
        camera.position.add(move);
        controls.target.add(move);
      }
      const spin = (this.keys.has('q') ? 1 : 0) - (this.keys.has('e') ? 1 : 0);
      if (spin) {
        offset.applyAxisAngle(new Vector3(0, 1, 0), spin * dt * 1.4);
        camera.position.copy(controls.target).add(offset);
      }
      const dolly = (this.keys.has('f') ? 1 : 0) - (this.keys.has('r') ? 1 : 0);
      if (dolly) {
        const scaled = camera.position.clone().sub(controls.target).multiplyScalar(1 + dolly * dt * 1.5);
        if (scaled.length() > controls.minDistance && scaled.length() < controls.maxDistance) {
          camera.position.copy(controls.target).add(scaled);
        }
      }
    }

    controls.update();
    const range = camera.position.distanceTo(controls.target);
    camera.near = Math.max(0.2, Math.min(range, camera.position.y + 1) * 0.03);
    camera.far = Math.max(3000, this.extent * 8 + range * 4);
    camera.updateProjectionMatrix();

    if (this.pointerDirty && this.pointerInside && !this.flight) {
      this.pointerDirty = false;
      const id = this.pick();
      this.setHover(id);
      this.events.onHover(id, this.pointerPx.x, this.pointerPx.y);
    }

    this.focusTimer -= dt;
    if (this.focusTimer <= 0) {
      this.focusTimer = 0.25;
      let best = 0;
      let bestD = Infinity;
      const t = controls.target;
      for (const d of this.layout.dirs.values()) {
        const dx = Math.max(0, Math.abs(t.x - d.x) - d.w / 2);
        const dz = Math.max(0, Math.abs(t.z - d.z) - d.d / 2);
        const dd = dx * dx + dz * dz;
        if (dd < bestD) {
          bestD = dd;
          best = d.id;
        }
      }
      if (best !== this.focusDir) {
        this.focusDir = best;
        this.events.onFocusDir(best);
      }
    }

    const time = now / 1000;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const pr = this.renderer.getPixelRatio();
    this.arcs?.update(time, size.x, size.y, pr);
    this.folderArcs?.update(time, size.x, size.y, pr);
    (this.beacon.material as ShaderMaterial).uniforms.uTime.value = time;

    if (this.options.bloom) this.composer.render(dt);
    else this.renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    this.clearContent();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

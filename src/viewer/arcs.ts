import {
  AdditiveBlending, BufferAttribute, Color, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, Mesh,
  ShaderMaterial, Vector2, type Group,
} from 'three';
import { ARC } from './theme.js';

export const enum ArcState {
  Hidden = -1,
  Normal = 0,
  /** Leaves the selection: "this imports that". */
  Outgoing = 1,
  /** Arrives at the selection: "that imports this". */
  Incoming = 2,
  /** Something else is selected. */
  Muted = 3,
}

export const enum ArcKind {
  Internal = 0,
  External = 1,
  Cycle = 2,
}

export const enum ArcStyle {
  Solid = 0,
  /** type-only imports */
  Dashed = 1,
  /** dynamic import() */
  Dotted = 2,
}

export interface ArcSpec {
  from: [number, number, number];
  to: [number, number, number];
  kind: ArcKind;
  style: ArcStyle;
  /** Ribbon width multiplier (folder arcs scale with the number of imports they bundle). */
  weight?: number;
  /** 0..1 brightness of the idle arc — hubs with huge fan-in are attenuated so they do not burn out. */
  fade?: number;
}

const SEGMENTS = 40;

const VERT = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec4 aInfo;   // state, kind + style * 10, apex height, arc length
attribute vec3 aMisc;   // seed, weight, idle fade
uniform vec2 uResolution;
uniform float uWidth;
uniform float uHiWidth;
varying float vT;
varying float vSide;
varying float vState;
varying float vKind;
varying float vStyle;
varying float vLen;
varying float vSeed;
varying float vIdle;

vec3 curve(float t) {
  vec3 p = mix(aStart, aEnd, t);
  p.y += 4.0 * aInfo.z * t * (1.0 - t);   // ballistic: linear travel + parabolic lift
  return p;
}

void main() {
  float t = position.x;
  float side = position.y;
  vT = t;
  vSide = side;
  vState = aInfo.x;
  float ks = aInfo.y;
  vStyle = floor(ks / 10.0 + 0.01);
  vKind = ks - vStyle * 10.0;
  vLen = aInfo.w;
  vSeed = aMisc.x;
  vIdle = aMisc.z;
  if (aInfo.x < -0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float dt = t < 0.5 ? 0.012 : -0.012;
  vec4 c0 = projectionMatrix * modelViewMatrix * vec4(curve(t), 1.0);
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4(curve(t + dt), 1.0);
  if (c0.w > 0.0 && c1.w > 0.0) {
    vec2 s0 = c0.xy / c0.w * uResolution;
    vec2 s1 = c1.xy / c1.w * uResolution;
    vec2 dir = (s1 - s0) * sign(dt);
    float len = length(dir);
    if (len > 1e-4) {
      dir /= len;
      float hi = step(0.5, aInfo.x) * (1.0 - step(2.5, aInfo.x));
      float width = mix(uWidth, uHiWidth, hi) * aMisc.y;
      c0.xy += vec2(-dir.y, dir.x) * side * width / uResolution * c0.w;
    }
  }
  gl_Position = c0;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uDim;
uniform float uMuted;
uniform vec3 uInternal;
uniform vec3 uExternal;
uniform vec3 uCycle;
uniform vec3 uOutgoing;
uniform vec3 uIncoming;
varying float vT;
varying float vSide;
varying float vState;
varying float vKind;
varying float vStyle;
varying float vLen;
varying float vSeed;
varying float vIdle;

void main() {
  vec3 base = vKind < 0.5 ? uInternal : (vKind < 1.5 ? uExternal : uCycle);
  vec3 color = base;
  float alpha = uDim * vIdle;
  float speed = 0.22;
  if (vState > 2.5) {
    alpha = uMuted;
  } else if (vState > 1.5) {
    color = mix(uIncoming, base, 0.18);
    alpha = 0.95;
    speed = 0.5;
  } else if (vState > 0.5) {
    color = vKind > 0.5 ? mix(base, vec3(1.0), 0.12) : uOutgoing;
    alpha = 0.95;
    speed = 0.5;
  }
  if (vKind > 1.5 && vState < 2.5) alpha = max(alpha, 0.5);

  // dashes / dots for type-only and dynamic imports
  if (vStyle > 0.5) {
    float period = vStyle > 1.5 ? 0.9 : 2.2;
    float duty = vStyle > 1.5 ? 0.35 : 0.6;
    if (fract(vT * vLen / period) > duty) discard;
  }

  // packets of light travelling importer -> imported
  float packets = max(1.0, floor(vLen / 26.0));
  float phase = fract(vT * packets - uTime * speed - vSeed);
  float head = smoothstep(0.72, 1.0, phase) * (1.0 - smoothstep(0.985, 1.0, phase));
  float glow = 0.42 + 1.9 * head;

  // soft ribbon edges, brighter near the launch point, fading ends
  float edge = 1.0 - smoothstep(0.15, 1.0, abs(vSide));
  float ends = smoothstep(0.0, 0.03, vT) * (1.0 - smoothstep(0.97, 1.0, vT));
  float along = mix(1.0, 0.62, vT);
  gl_FragColor = vec4(color * glow * along, alpha * edge * ends);
}`;

/** Every import in the repo as one instanced draw call; per-arc state lives in a tiny attribute. */
export class ArcBatch {
  readonly mesh: Mesh;
  readonly count: number;
  private info: InstancedBufferAttribute;
  private material: ShaderMaterial;

  constructor(parent: Group, specs: ArcSpec[]) {
    this.count = specs.length;
    const geo = new InstancedBufferGeometry();
    const verts = new Float32Array((SEGMENTS + 1) * 2 * 3);
    const index: number[] = [];
    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS;
      verts.set([t, -1, 0, t, 1, 0], s * 6);
      if (s < SEGMENTS) {
        const a = s * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geo.setAttribute('position', new BufferAttribute(verts, 3));
    geo.setIndex(index);

    const n = specs.length;
    const start = new Float32Array(n * 3);
    const end = new Float32Array(n * 3);
    const info = new Float32Array(n * 4);
    const misc = new Float32Array(n * 3);
    specs.forEach((a, i) => {
      start.set(a.from, i * 3);
      end.set(a.to, i * 3);
      const dx = a.to[0] - a.from[0];
      const dy = a.to[1] - a.from[1];
      const dz = a.to[2] - a.from[2];
      const dist = Math.hypot(dx, dy, dz);
      const seed = ((Math.sin(i * 12.9898 + dx * 0.37) * 43758.5453) % 1 + 1) % 1;
      const apex = Math.min(140, Math.max(2.2, dist * 0.3)) * (0.88 + seed * 0.24);
      // rough arc length of the parabola, for dash spacing and packet count
      const length = Math.sqrt(dist * dist + (16 / 3) * apex * apex);
      info.set([ArcState.Normal, a.kind + a.style * 10, apex, length], i * 4);
      misc.set([seed, a.weight ?? 1, a.fade ?? 1], i * 3);
    });
    geo.setAttribute('aStart', new InstancedBufferAttribute(start, 3));
    geo.setAttribute('aEnd', new InstancedBufferAttribute(end, 3));
    this.info = new InstancedBufferAttribute(info, 4);
    geo.setAttribute('aInfo', this.info);
    geo.setAttribute('aMisc', new InstancedBufferAttribute(misc, 3));
    geo.instanceCount = n;

    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new Vector2(1, 1) },
        uWidth: { value: 1.4 },
        uHiWidth: { value: 3.2 },
        uDim: { value: 0.16 },
        uMuted: { value: 0.012 },
        uInternal: { value: new Color(ARC.internal) },
        uExternal: { value: new Color(ARC.external) },
        uCycle: { value: new Color(ARC.cycle) },
        uOutgoing: { value: new Color(ARC.outgoing) },
        uIncoming: { value: new Color(ARC.incoming) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    this.mesh = new Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    parent.add(this.mesh);
  }

  setState(i: number, state: ArcState): void {
    (this.info.array as Float32Array)[i * 4] = state;
  }

  commit(): void {
    this.info.needsUpdate = true;
  }

  update(time: number, width: number, height: number, pixelRatio: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uResolution.value.set(width, height);
    u.uWidth.value = 2.1 * pixelRatio;
    u.uHiWidth.value = 3.8 * pixelRatio;
  }

  /** Base brightness of unselected arcs — lower for hairball-sized graphs. */
  set dim(v: number) {
    this.material.uniforms.uDim.value = v;
  }

  set visible(v: boolean) {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

import {
  DataTexture, DoubleSide, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter, LinearMipmapLinearFilter,
  Mesh, PlaneGeometry, RedFormat, ShaderMaterial, UnsignedByteType, type Group,
} from 'three';

export interface LabelSpec {
  text: string;
  x: number;
  y: number;
  z: number;
  /** World-space cap on text height and width; the label shrinks to satisfy both. */
  height: number;
  maxWidth: number;
  color: [number, number, number];
  /** Lies flat on the ground facing +z (FSN style), or always faces the camera. */
  billboard?: boolean;
  /** Distance at which the label has fully faded out. Defaults to a multiple of its height. */
  fadeFar?: number;
}

const ATLAS = 2048;

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec2 aSize;
attribute vec4 aUv;
attribute vec4 aColor;
attribute vec2 aFade;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
void main() {
  vec4 mv;
  if (aColor.a > 0.5) {
    mv = modelViewMatrix * vec4(aPos, 1.0);
    mv.xy += position.xy * aSize;
  } else {
    mv = modelViewMatrix * vec4(aPos + vec3(position.x * aSize.x, 0.0, -position.y * aSize.y), 1.0);
  }
  vUv = vec2(mix(aUv.x, aUv.z, position.x + 0.5), mix(aUv.w, aUv.y, position.y + 0.5));
  vColor = aColor.rgb;
  vFade = 1.0 - smoothstep(aFade.x, aFade.y, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vColor;
varying float vFade;
void main() {
  float a = texture2D(uMap, vUv).r * vFade * uOpacity;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a);
}`;

/**
 * Thousands of text labels in a handful of draw calls: glyph runs are rasterised once into
 * single-channel atlases and drawn as instanced quads that fade out with distance.
 */
export class LabelLayer {
  private meshes: Mesh[] = [];
  private materials: ShaderMaterial[] = [];

  constructor(parent: Group, specs: LabelSpec[], fontPx: number, renderOrder = 5) {
    if (!specs.length) return;
    const rowH = Math.ceil(fontPx * 1.3);
    const font = `600 ${fontPx}px ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace`;
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS;
    canvas.height = ATLAS;
    const g = canvas.getContext('2d', { willReadFrequently: true })!;

    let batch: { spec: LabelSpec; u0: number; v0: number; u1: number; v1: number; aspect: number }[] = [];
    let x = 0;
    let y = 0;
    const reset = () => {
      g.clearRect(0, 0, ATLAS, ATLAS);
      g.font = font;
      g.textBaseline = 'middle';
      g.fillStyle = '#fff';
      x = 0;
      y = 0;
    };
    const flush = () => {
      if (!batch.length) return;
      const rgba = g.getImageData(0, 0, ATLAS, ATLAS).data;
      const alpha = new Uint8Array(ATLAS * ATLAS);
      for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = rgba[j];
      const tex = new DataTexture(alpha, ATLAS, ATLAS, RedFormat, UnsignedByteType);
      tex.generateMipmaps = true;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.anisotropy = 8;
      tex.needsUpdate = true;

      const geo = new InstancedBufferGeometry();
      const quad = new PlaneGeometry(1, 1);
      geo.index = quad.index;
      geo.setAttribute('position', quad.getAttribute('position'));
      const n = batch.length;
      const pos = new Float32Array(n * 3);
      const size = new Float32Array(n * 2);
      const uv = new Float32Array(n * 4);
      const color = new Float32Array(n * 4);
      const fade = new Float32Array(n * 2);
      batch.forEach((b, i) => {
        const s = b.spec;
        let h = s.height;
        let w = h * b.aspect;
        if (w > s.maxWidth) {
          w = s.maxWidth;
          h = w / b.aspect;
        }
        pos.set([s.x, s.y, s.z], i * 3);
        size.set([w, h], i * 2);
        uv.set([b.u0, b.v0, b.u1, b.v1], i * 4);
        color.set([s.color[0], s.color[1], s.color[2], s.billboard ? 1 : 0], i * 4);
        const far = s.fadeFar ?? Math.max(40, h * 360);
        fade.set([far * 0.55, far], i * 2);
      });
      geo.setAttribute('aPos', new InstancedBufferAttribute(pos, 3));
      geo.setAttribute('aSize', new InstancedBufferAttribute(size, 2));
      geo.setAttribute('aUv', new InstancedBufferAttribute(uv, 4));
      geo.setAttribute('aColor', new InstancedBufferAttribute(color, 4));
      geo.setAttribute('aFade', new InstancedBufferAttribute(fade, 2));
      geo.instanceCount = n;

      const mat = new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uMap: { value: tex }, uOpacity: { value: 1 } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = renderOrder;
      parent.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(mat);
      batch = [];
    };

    reset();
    for (const spec of specs) {
      const text = spec.text.length > 48 ? `${spec.text.slice(0, 47)}…` : spec.text;
      const w = Math.min(ATLAS - 4, Math.ceil(g.measureText(text).width) + 6);
      if (x + w > ATLAS) {
        x = 0;
        y += rowH;
      }
      if (y + rowH > ATLAS) {
        flush();
        reset();
      }
      g.fillText(text, x + 3, y + rowH / 2 + 1, w - 4);
      batch.push({ spec, u0: x / ATLAS, v0: y / ATLAS, u1: (x + w) / ATLAS, v1: (y + rowH) / ATLAS, aspect: w / rowH });
      x += w + 2;
    }
    flush();
  }

  set visible(v: boolean) {
    for (const m of this.meshes) m.visible = v;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const mat of this.materials) {
      (mat.uniforms.uMap.value as DataTexture).dispose();
      mat.dispose();
    }
  }
}

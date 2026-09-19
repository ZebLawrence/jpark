import type { Category, DepKind } from '../types.js';

/** Form encodes what a file *is*; color encodes the language it is written in. */
export type Shape = 'box' | 'cylinder' | 'pyramid' | 'hex' | 'octa' | 'slab' | 'sphere' | 'prism' | 'tetra';

export const CATEGORY_SHAPE: Record<Category, Shape> = {
  code: 'box',
  test: 'prism',
  markup: 'cylinder',
  style: 'pyramid',
  config: 'hex',
  data: 'octa',
  doc: 'slab',
  media: 'sphere',
  binary: 'tetra',
  other: 'tetra',
};

export const CATEGORY_LABEL: Record<Category, string> = {
  code: 'source code',
  test: 'tests',
  markup: 'components / markup',
  style: 'stylesheets',
  config: 'config',
  data: 'data',
  doc: 'docs',
  media: 'media',
  binary: 'binary',
  other: 'other',
};

export const SHAPE_GLYPH: Record<Shape, string> = {
  box: '■', prism: '◣', cylinder: '◍', pyramid: '▲', hex: '⬢', octa: '◆', slab: '▬', sphere: '●', tetra: '◢',
};

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3d9bff', TSX: '#38d6ff', JavaScript: '#ffd83d', JSX: '#ffb53d', Python: '#5aa2ff', Jupyter: '#ff8b3d',
  Go: '#2ee6e0', Rust: '#ff8a5c', Java: '#e0913a', Kotlin: '#b07bff', Scala: '#e0483a', Groovy: '#5fc3c9',
  C: '#9fb2c2', 'C++': '#ff5f9e', 'Objective-C': '#6a9cff', 'C#': '#4fd65a', 'F#': '#c07bff', Ruby: '#ff4d4d',
  PHP: '#8a93e0', Swift: '#ff7a45', Dart: '#2ed3c6', Lua: '#5a6bff', Perl: '#3aa6c9', R: '#4aa0ff', Julia: '#b56be0',
  Elixir: '#a06be0', Erlang: '#d9508f', Haskell: '#8f7fd1', Clojure: '#e0605a', Elm: '#70c8e0', Zig: '#f0a441',
  Nim: '#ffe06b', Solidity: '#b0b0b0', Shell: '#9ff05a', PowerShell: '#4a8fd6', Batch: '#c8f05a', SQL: '#f0b83d',
  GLSL: '#7de0a8', WGSL: '#7de0c8', Protobuf: '#e0a87d', GraphQL: '#ff4fb5', Prisma: '#7d9be0',
  Terraform: '#9b7dff', HCL: '#9b7dff',
  HTML: '#ff6a3d', Vue: '#4fe09a', Svelte: '#ff5a2e', Astro: '#ff7de0', Handlebars: '#f0923d', EJS: '#c0d64a',
  Pug: '#c99a6b', ERB: '#ff6a6a', Twig: '#c8e04a', Nunjucks: '#5ac26b', Liquid: '#8ad0e0', XML: '#5ad08a',
  CSS: '#b57bff', SCSS: '#ff7dc0', Sass: '#ff7dc0', Less: '#6a8fe0', Stylus: '#ff8a70',
  JSON: '#8aa0ad', YAML: '#e05a70', TOML: '#c9805a', INI: '#c9c29a', Env: '#f0e05a', Config: '#a8b3ba',
  Lockfile: '#55636b', CSV: '#4ac26b', Data: '#6b8a99', Docker: '#4aa8e0', Make: '#7ab84a', CMake: '#e06a6a',
  Markdown: '#e8eef2', MDX: '#ffd27d', reStructuredText: '#c9d3d9', Text: '#aab6bd', AsciiDoc: '#d97d9b', TeX: '#6bbf7d',
  PDF: '#e05a4a', Image: '#ff9ed2', SVG: '#ffc46b', Video: '#ff7da0', Audio: '#c49bff', '3D Model': '#7de0ff',
  Font: '#d6c9ff', Archive: '#8a7d6b', WebAssembly: '#8a7dff', Binary: '#6b7680',
};

function hashHue(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) / 360;
}

export function hslToHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? hslToHex(hashHue(lang), 0.7, 0.62);
}

export const DEP_COLOR: Record<DepKind, string> = {
  prod: '#ffb02e',
  dev: '#a78bfa',
  peer: '#ff6fb5',
  optional: '#ffd98a',
  builtin: '#6f93ad',
  unlisted: '#ff4d4d',
};

export const DEP_LABEL: Record<DepKind, string> = {
  prod: 'dependency',
  dev: 'devDependency',
  peer: 'peerDependency',
  optional: 'optionalDependency',
  builtin: 'runtime built-in',
  unlisted: 'not in any manifest',
};

export const DEP_SHAPE: Record<DepKind, 'icosa' | 'octa' | 'dodeca' | 'tetra'> = {
  prod: 'icosa',
  dev: 'octa',
  peer: 'tetra',
  optional: 'tetra',
  builtin: 'dodeca',
  unlisted: 'icosa',
};

export const ARC = {
  internal: '#19d3c5',
  external: '#ff9d1e',
  cycle: '#ff2d46',
  outgoing: '#3cf2ff',
  incoming: '#ff4fd8',
};

export const UI = {
  bg: '#02060a',
  ground: '#03090e',
  grid: '#0b3b46',
  gridMajor: '#11606e',
};

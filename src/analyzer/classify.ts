import type { Category } from '../types.js';

interface Kind {
  lang: string;
  category: Category;
}

const k = (lang: string, category: Category): Kind => ({ lang, category });

const BY_EXT: Record<string, Kind> = {
  // code
  ts: k('TypeScript', 'code'), mts: k('TypeScript', 'code'), cts: k('TypeScript', 'code'),
  tsx: k('TSX', 'markup'), jsx: k('JSX', 'markup'),
  js: k('JavaScript', 'code'), mjs: k('JavaScript', 'code'), cjs: k('JavaScript', 'code'),
  py: k('Python', 'code'), pyi: k('Python', 'code'), ipynb: k('Jupyter', 'data'),
  go: k('Go', 'code'), rs: k('Rust', 'code'),
  java: k('Java', 'code'), kt: k('Kotlin', 'code'), kts: k('Kotlin', 'code'), scala: k('Scala', 'code'), groovy: k('Groovy', 'code'),
  c: k('C', 'code'), h: k('C', 'code'), cc: k('C++', 'code'), cpp: k('C++', 'code'), cxx: k('C++', 'code'),
  hpp: k('C++', 'code'), hh: k('C++', 'code'), hxx: k('C++', 'code'), m: k('Objective-C', 'code'), mm: k('Objective-C', 'code'),
  cs: k('C#', 'code'), fs: k('F#', 'code'), vb: k('Visual Basic', 'code'),
  rb: k('Ruby', 'code'), php: k('PHP', 'code'), swift: k('Swift', 'code'), dart: k('Dart', 'code'),
  lua: k('Lua', 'code'), pl: k('Perl', 'code'), r: k('R', 'code'), jl: k('Julia', 'code'),
  ex: k('Elixir', 'code'), exs: k('Elixir', 'code'), erl: k('Erlang', 'code'), hs: k('Haskell', 'code'),
  clj: k('Clojure', 'code'), cljs: k('Clojure', 'code'), elm: k('Elm', 'code'), zig: k('Zig', 'code'), nim: k('Nim', 'code'),
  sol: k('Solidity', 'code'), sh: k('Shell', 'code'), bash: k('Shell', 'code'), zsh: k('Shell', 'code'), fish: k('Shell', 'code'),
  ps1: k('PowerShell', 'code'), bat: k('Batch', 'code'), sql: k('SQL', 'code'),
  glsl: k('GLSL', 'code'), vert: k('GLSL', 'code'), frag: k('GLSL', 'code'), wgsl: k('WGSL', 'code'),
  proto: k('Protobuf', 'code'), graphql: k('GraphQL', 'code'), gql: k('GraphQL', 'code'), prisma: k('Prisma', 'code'),
  tf: k('Terraform', 'config'), hcl: k('HCL', 'config'),
  // markup / components
  html: k('HTML', 'markup'), htm: k('HTML', 'markup'), vue: k('Vue', 'markup'), svelte: k('Svelte', 'markup'),
  astro: k('Astro', 'markup'), hbs: k('Handlebars', 'markup'), ejs: k('EJS', 'markup'), pug: k('Pug', 'markup'),
  erb: k('ERB', 'markup'), twig: k('Twig', 'markup'), njk: k('Nunjucks', 'markup'), liquid: k('Liquid', 'markup'),
  xml: k('XML', 'data'), xsl: k('XML', 'data'),
  // style
  css: k('CSS', 'style'), scss: k('SCSS', 'style'), sass: k('Sass', 'style'), less: k('Less', 'style'),
  styl: k('Stylus', 'style'), pcss: k('CSS', 'style'),
  // data / config
  json: k('JSON', 'data'), jsonc: k('JSON', 'config'), json5: k('JSON', 'config'), geojson: k('JSON', 'data'),
  yaml: k('YAML', 'config'), yml: k('YAML', 'config'), toml: k('TOML', 'config'), ini: k('INI', 'config'),
  env: k('Env', 'config'), conf: k('Config', 'config'), cfg: k('Config', 'config'), properties: k('Config', 'config'),
  editorconfig: k('Config', 'config'), lock: k('Lockfile', 'data'),
  map: k('Source Map', 'data'), snap: k('Snapshot', 'data'), flow: k('Flow', 'code'),
  csv: k('CSV', 'data'), tsv: k('CSV', 'data'), parquet: k('Data', 'binary'), sqlite: k('Data', 'binary'), db: k('Data', 'binary'),
  // docs
  md: k('Markdown', 'doc'), mdx: k('MDX', 'doc'), markdown: k('Markdown', 'doc'), rst: k('reStructuredText', 'doc'),
  txt: k('Text', 'doc'), adoc: k('AsciiDoc', 'doc'), tex: k('TeX', 'doc'), pdf: k('PDF', 'binary'),
  // media
  png: k('Image', 'media'), jpg: k('Image', 'media'), jpeg: k('Image', 'media'), gif: k('Image', 'media'),
  webp: k('Image', 'media'), avif: k('Image', 'media'), ico: k('Image', 'media'), bmp: k('Image', 'media'),
  svg: k('SVG', 'media'), mp4: k('Video', 'media'), webm: k('Video', 'media'), mov: k('Video', 'media'),
  mp3: k('Audio', 'media'), wav: k('Audio', 'media'), ogg: k('Audio', 'media'), flac: k('Audio', 'media'),
  glb: k('3D Model', 'media'), gltf: k('3D Model', 'media'), obj: k('3D Model', 'media'), fbx: k('3D Model', 'media'),
  woff: k('Font', 'media'), woff2: k('Font', 'media'), ttf: k('Font', 'media'), otf: k('Font', 'media'), eot: k('Font', 'media'),
  // binary
  zip: k('Archive', 'binary'), gz: k('Archive', 'binary'), tar: k('Archive', 'binary'), tgz: k('Archive', 'binary'),
  jar: k('Archive', 'binary'), wasm: k('WebAssembly', 'binary'), so: k('Binary', 'binary'), dylib: k('Binary', 'binary'),
  dll: k('Binary', 'binary'), exe: k('Binary', 'binary'), bin: k('Binary', 'binary'), node: k('Binary', 'binary'),
  pyc: k('Binary', 'binary'), class: k('Binary', 'binary'), o: k('Binary', 'binary'), a: k('Binary', 'binary'),
};

const BY_NAME: Record<string, Kind> = {
  dockerfile: k('Docker', 'config'), makefile: k('Make', 'config'), 'cmakelists.txt': k('CMake', 'config'),
  gemfile: k('Ruby', 'config'), rakefile: k('Ruby', 'config'), procfile: k('Config', 'config'),
  jenkinsfile: k('Groovy', 'config'), license: k('Text', 'doc'), licence: k('Text', 'doc'),
  'go.mod': k('Go', 'config'), 'go.sum': k('Lockfile', 'data'), 'cargo.toml': k('TOML', 'config'),
  'package.json': k('JSON', 'config'), 'package-lock.json': k('Lockfile', 'data'), 'tsconfig.json': k('JSON', 'config'),
  'jsconfig.json': k('JSON', 'config'), 'pnpm-lock.yaml': k('Lockfile', 'data'), 'yarn.lock': k('Lockfile', 'data'),
  'bun.lockb': k('Lockfile', 'binary'), 'composer.json': k('JSON', 'config'),
};

const TEST_RE = /(^|[/._-])(tests?|specs?|__tests__|__mocks__|e2e|cypress|playwright)([/._-]|$)/i;
const TEST_FILE_RE = /(\.|_|-)(test|spec|stories|e2e)\.[a-z0-9]+$|^test_[^/]+\.py$|_test\.(go|py|rb)$/i;
const CONFIG_FILE_RE = /(^\.[^/]+rc(\.[a-z]+)?$)|(\.config\.[cm]?[jt]s$)|(^\.(git|npm|docker|eslint|prettier)ignore$)|(^\.gitattributes$)/i;

export function extOf(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.d.ts')) return 'd.ts';
  const i = lower.lastIndexOf('.');
  // Dotfiles like ".env" or ".editorconfig": treat the whole tail as the ext.
  if (i <= 0) return i === 0 ? lower.slice(1) : '';
  return lower.slice(i + 1);
}

export function classify(path: string, name: string): Kind & { ext: string } {
  const ext = extOf(name);
  const lower = name.toLowerCase();
  let kind = BY_NAME[lower] ?? BY_EXT[ext === 'd.ts' ? 'ts' : ext];
  if (!kind && lower.startsWith('.env')) kind = k('Env', 'config');
  if (!kind && lower.startsWith('dockerfile')) kind = k('Docker', 'config');
  if (!kind) kind = k(ext ? ext.toUpperCase() : 'Other', 'other');
  let category = kind.category;
  if (category === 'code' || category === 'markup') {
    if (CONFIG_FILE_RE.test(name)) category = 'config';
    else if (TEST_FILE_RE.test(name) || TEST_RE.test(path.slice(0, path.length - name.length))) category = 'test';
  } else if (category === 'data' && CONFIG_FILE_RE.test(name)) {
    category = 'config';
  }
  return { lang: kind.lang, category, ext };
}

const TEXT_CATEGORIES = new Set<Category>(['code', 'test', 'markup', 'style', 'data', 'config', 'doc', 'other']);

/** Whether it is worth reading the file to count lines / scan imports. */
export function isProbablyText(category: Category, ext: string): boolean {
  if (ext === 'svg') return true;
  return TEXT_CATEGORIES.has(category);
}

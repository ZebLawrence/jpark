import type { EdgeKind } from '../../types.js';
import { dirname, joinPath, type LanguageAnalyzer } from '../context.js';
import type { JsResolver } from './javascript.js';

export interface CssImport {
  spec: string;
  kind: EdgeKind;
}

const AT_IMPORT = /@(?:import|use|forward|require|reference|plugin|config)\s+(?:\([^)]*\)\s*)?([^;{]+)[;{]?/g;
const STRINGS = /(?:url\(\s*)?(['"])([^'"\n]+)\1|url\(\s*([^'")\s]+)\s*\)/g;
const URL_FN = /url\(\s*(?:(['"])([^'"\n]+)\1|([^'")\s]+))\s*\)/g;
const COMPOSES = /composes\s*:[^;]*?\sfrom\s+(['"])([^'"\n]+)\1/g;

export function scanCss(source: string): CssImport[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out: CssImport[] = [];
  const styleSpans: [number, number][] = [];
  for (const m of src.matchAll(AT_IMPORT)) {
    styleSpans.push([m.index!, m.index! + m[0].length]);
    for (const s of m[1].matchAll(STRINGS)) out.push({ spec: s[2] ?? s[3], kind: 'style' });
  }
  for (const m of src.matchAll(COMPOSES)) out.push({ spec: m[2], kind: 'style' });
  for (const m of src.matchAll(URL_FN)) {
    const at = m.index!;
    if (styleSpans.some(([a, b]) => at >= a && at < b)) continue;
    out.push({ spec: m[2] ?? m[3], kind: 'asset' });
  }
  return out;
}

const STYLE_EXTS = ['', '.scss', '.sass', '.less', '.css', '.styl', '.pcss'];

export function createCssAnalyzer(getResolver: () => JsResolver): LanguageAnalyzer {
  return {
    name: 'css',
    exts: ['css', 'scss', 'sass', 'less', 'styl', 'pcss'],
    analyze(file, source, ctx) {
      const dir = dirname(file.path);
      for (const { spec: raw, kind } of scanCss(source)) {
        const spec = raw.replace(/[?#].*$/, '');
        if (!spec || /^(https?:|data:|\/\/|#|%|var\()/.test(spec) || spec.includes('#{') || spec.includes('${')) continue;
        if (/^(sass|less):/.test(spec)) {
          ctx.external(file, spec.split(':')[0], 'npm', 'builtin', 'style');
          continue;
        }
        // Stylesheet-relative first: `@import "vars"` means ./vars, ./_vars.scss, ./vars/_index.scss …
        if (!spec.startsWith('~') && !spec.startsWith('/')) {
          const target = joinPath(dir, spec);
          if (target != null) {
            const slash = target.lastIndexOf('/');
            const partial = `${target.slice(0, slash + 1)}_${target.slice(slash + 1)}`;
            let hit: string | null = null;
            for (const base of [target, partial, `${target}/index`, `${target}/_index`]) {
              for (const ext of STYLE_EXTS) {
                if (ctx.hasFile(base + ext)) {
                  hit = base + ext;
                  break;
                }
              }
              if (hit) break;
            }
            if (hit) {
              ctx.link(file, hit, kind);
              continue;
            }
          }
          if (spec.startsWith('.') || kind === 'asset') {
            ctx.miss(file, raw);
            continue;
          }
        }
        // Aliases, workspace packages and npm packages go through the JS resolver.
        getResolver().resolve(file, spec.replace(/^~(?!\/)/, ''), kind);
      }
    },
  };
}

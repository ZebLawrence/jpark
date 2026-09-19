import { dirname, joinPath, type LanguageAnalyzer } from '../context.js';
import { scanCss } from './css.js';
import { scanJs, type JsResolver } from './javascript.js';

const REF = /<(script|link|img|source|video|audio|iframe|embed|object|use|image)\b[^>]*?\s(?:src|href|data|xlink:href|poster)\s*=\s*(["'])([^"'\n]+)\2/gi;
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const INLINE_STYLE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

export function createHtmlAnalyzer(getResolver: () => JsResolver): LanguageAnalyzer {
  return {
    name: 'html',
    exts: ['html', 'htm'],
    analyze(file, source, ctx) {
      const src = source.replace(/<!--[\s\S]*?-->/g, '');
      const dir = dirname(file.path);
      const r = getResolver();
      for (const m of src.matchAll(REF)) {
        const tag = m[1].toLowerCase();
        const spec = m[3].trim().replace(/[?#].*$/, '');
        if (!spec || /^([a-z][a-z0-9+.-]*:|\/\/|#|\{|<)/i.test(spec)) continue;
        const kind = tag === 'script' ? 'import' : tag === 'link' && /\.(css|scss|less)$/i.test(spec) ? 'style' : 'asset';
        if (spec.startsWith('/')) r.resolve(file, spec, kind);
        else if (!ctx.link(file, joinPath(dir, decodeURI(spec)) ?? '\0', kind)) r.resolve(file, `./${spec}`, kind);
      }
      for (const m of src.matchAll(INLINE_SCRIPT)) for (const imp of scanJs(m[1])) r.resolve(file, imp.spec, imp.kind);
      for (const m of src.matchAll(INLINE_STYLE)) {
        for (const imp of scanCss(m[1])) {
          if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(imp.spec)) continue;
          r.resolve(file, /^[./~@]/.test(imp.spec) ? imp.spec : `./${imp.spec}`, imp.kind);
        }
      }
    },
  };
}

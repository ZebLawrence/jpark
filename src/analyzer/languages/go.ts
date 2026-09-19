import type { DepKind } from '../../types.js';
import { dirname, joinPath, type LanguageAnalyzer } from '../context.js';

export function scanGo(source: string): string[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm)) out.push(m[1]);
  for (const block of src.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/^\s*(?:[\w.]+\s+)?"([^"\n]+)"/gm)) out.push(m[1]);
  }
  return out;
}

export function createGoAnalyzer(): LanguageAnalyzer {
  const modules: { path: string; dir: string }[] = [];
  const requires = new Map<string, { kind: DepKind; version: string; indirect: boolean }>();

  return {
    name: 'go',
    exts: ['go'],
    async prepare(ctx) {
      for (const f of ctx.filesNamed('go.mod')) {
        const text = (await ctx.readText(f.path)) ?? '';
        const mod = /^\s*module\s+(\S+)/m.exec(text);
        if (mod) modules.push({ path: mod[1], dir: dirname(f.path) });
        for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.~-]+\.[\w.~-]+\/\S+)\s+(v\S+)(.*)$/gm)) {
          requires.set(m[1], { kind: 'prod', version: m[2], indirect: /indirect/.test(m[3]) });
        }
      }
      modules.sort((a, b) => b.path.length - a.path.length);
    },
    analyze(file, source, ctx) {
      for (const spec of scanGo(source)) {
        if (spec === 'C') continue;
        const mod = modules.find((m) => spec === m.path || spec.startsWith(m.path + '/'));
        if (mod) {
          const target = joinPath(mod.dir, spec.slice(mod.path.length + 1)) ?? '';
          if (!ctx.link(file, target, 'import')) ctx.miss(file, spec);
          continue;
        }
        const first = spec.split('/')[0];
        if (!first.includes('.')) {
          ctx.external(file, first, 'go', 'builtin');
          continue;
        }
        let name = [...requires.keys()].filter((r) => spec === r || spec.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0];
        if (!name) name = spec.split('/').slice(0, /^(gopkg\.in|go\.uber\.org)$/.test(first) ? 2 : 3).join('/');
        const req = requires.get(name);
        ctx.external(file, name, 'go', req ? 'prod' : modules.length ? 'unlisted' : 'prod', 'import', req?.version);
      }
    },
    finish(ctx) {
      if (ctx.options.includeUnusedDeps === false) return;
      for (const [name, r] of requires) if (!r.indirect) ctx.external(null, name, 'go', 'prod', 'import', r.version);
    },
  };
}

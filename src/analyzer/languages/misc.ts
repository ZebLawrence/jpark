import type { DepKind } from '../../types.js';
import { dirname, joinPath, type LanguageAnalyzer } from '../context.js';

/** C / C++ / Objective-C: `#include "local.h"` and `#include <lib/header.h>`. */
export function createCAnalyzer(): LanguageAnalyzer {
  return {
    name: 'c',
    exts: ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm'],
    analyze(file, source, ctx) {
      const dir = dirname(file.path);
      for (const m of source.matchAll(/^[ \t]*#[ \t]*(?:include|import)[ \t]*([<"])([^>"\n]+)[>"]/gm)) {
        const spec = m[2].trim();
        const local = joinPath(dir, spec);
        if (local != null && ctx.link(file, local, 'import')) continue;
        const bySuffix = ctx.findBySuffix(spec.replace(/^(\.\.?\/)+/, ''), file.path);
        if (bySuffix && ctx.link(file, bySuffix, 'import')) continue;
        if (m[1] === '"') ctx.miss(file, spec);
        else if (spec.includes('/')) ctx.external(file, spec.split('/')[0], 'c', 'prod');
        else ctx.external(file, 'libc / libstdc++', 'c', 'builtin');
      }
    },
  };
}

/** Java / Kotlin / Scala / Groovy: package imports resolved by path suffix. */
export function createJvmAnalyzer(): LanguageAnalyzer {
  const BUILTIN = /^(java|javax|jdk|kotlin|kotlinx|scala|groovy|android|androidx|sun)\./;
  return {
    name: 'jvm',
    exts: ['java', 'kt', 'kts', 'scala', 'groovy'],
    analyze(file, source, ctx) {
      const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of src.matchAll(/^[ \t]*import\s+(?:static\s+)?([\w.]+?)(\.\*|\.\{[^}]*\})?\s*(?:;|$|\sas\s)/gm)) {
        const fq = m[1];
        const parts = fq.split('.');
        let linked = false;
        // Try the full name, then progressively shorter ones (static members, nested classes).
        for (let n = parts.length; n >= 2 && !linked; n--) {
          const rel = parts.slice(0, n).join('/');
          for (const ext of ['java', 'kt', 'scala', 'groovy']) {
            const hit = ctx.findBySuffix(`${rel}.${ext}`, file.path);
            if (hit) {
              linked = ctx.link(file, hit, 'import');
              break;
            }
          }
          if (!linked && m[2]) {
            const pkgDir = [...ctx.dirs.keys()].find((d) => d === rel || d.endsWith('/' + rel));
            if (pkgDir) linked = ctx.link(file, pkgDir, 'import');
          }
        }
        if (linked) continue;
        if (BUILTIN.test(fq + '.')) ctx.external(file, parts[0] === 'android' || parts[0] === 'androidx' ? parts[0] : `${parts[0]} stdlib`, 'jvm', 'builtin');
        else ctx.external(file, parts.slice(0, /^(com|org|io|net|dev|me|co)$/.test(parts[0]) ? 3 : 2).join('.'), 'jvm', 'prod');
      }
    },
  };
}

/** Ruby: require_relative, plus require resolved against lib/ or treated as a gem. */
export function createRubyAnalyzer(): LanguageAnalyzer {
  const gems = new Map<string, DepKind>();
  let hasGemfile = false;
  const STD = new Set('json yaml set date time fileutils pathname securerandom digest net/http uri open3 optparse logger erb csv tempfile socket stringio benchmark bigdecimal forwardable ostruct English open-uri timeout zlib base64 singleton observer pp psych rbconfig shellwords tmpdir'.split(' '));
  return {
    name: 'ruby',
    exts: ['rb', 'rake', 'gemspec'],
    async prepare(ctx) {
      for (const f of ctx.filesNamed('Gemfile')) {
        hasGemfile = true;
        let kind: DepKind = 'prod';
        for (const line of ((await ctx.readText(f.path)) ?? '').split(/\r?\n/)) {
          if (/^\s*group\b/.test(line)) kind = /development|test/.test(line) ? 'dev' : 'prod';
          else if (/^\s*end\b/.test(line)) kind = 'prod';
          const m = /^\s*gem\s+["']([^"']+)["']/.exec(line);
          if (m) gems.set(m[1], kind);
        }
      }
    },
    analyze(file, source, ctx) {
      const dir = dirname(file.path);
      const src = source.replace(/^=begin[\s\S]*?^=end/gm, '').replace(/#.*$/gm, '');
      for (const m of src.matchAll(/^\s*(require_relative|require|load)\s*\(?\s*["']([^"'\n#]+)["']/gm)) {
        const spec = m[2];
        if (m[1] !== 'require' || spec.startsWith('.')) {
          const target = joinPath(dir, spec);
          if (target == null || !(ctx.link(file, target, 'require') || ctx.link(file, `${target}.rb`, 'require'))) ctx.miss(file, spec);
          continue;
        }
        const hit = ctx.findBySuffix(`${spec}.rb`, file.path);
        if (hit && /(^|\/)(lib|app|src)\//.test(hit) && ctx.link(file, hit, 'require')) continue;
        if (STD.has(spec)) ctx.external(file, spec, 'gem', 'builtin', 'require');
        else {
          const gem = spec.split('/')[0];
          const kind = gems.get(gem) ?? gems.get(gem.replace(/_/g, '-')) ?? (hasGemfile ? 'unlisted' : 'prod');
          ctx.external(file, gem, 'gem', kind, 'require');
        }
      }
    },
    finish(ctx) {
      if (ctx.options.includeUnusedDeps === false) return;
      for (const [name, kind] of gems) ctx.external(null, name, 'gem', kind);
    },
  };
}

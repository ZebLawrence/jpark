#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from './analyzer/index.js';
import { renderHtml } from './html.js';
import { serve } from './server.js';
import type { AnalyzeOptions, Graph } from './types.js';

declare const __JPARK_VERSION__: string;

const HELP = `
  jpark — "It's a UNIX system! I know this!"
  Fly through any codebase in 3D: folders as a landscape, imports as ballistic arcs.

  Usage
    jpark [dir]                  scan, serve the viewer with live reload, open the browser
    jpark export [dir]           write one self-contained HTML file (share it, attach it to CI)
    jpark json [dir]             write the raw dependency graph as JSON

  Options
    -o, --out <file>             output path for export/json      (jpark.html / jpark-graph.json)
    -p, --port <n>               port for the viewer              (4747, next free one if taken)
        --host <addr>            interface to bind                (127.0.0.1)
    -i, --ignore <glob>          extra ignore pattern, gitignore syntax — repeatable
    -a, --alias <from=to>        import alias, e.g. -a @=src — repeatable
        --max-files <n>          stop scanning after n files      (25000)
        --no-git                 walk the disk instead of asking git which files matter
        --no-unused              hide manifest dependencies nothing imports
        --no-open                do not open the browser
        --no-watch               do not re-scan on file changes
    -v, --version
    -h, --help

  Config (optional): .jparkrc.json or a "jpark" key in package.json — { "ignore": [], "alias": {} }
`;

interface Config {
  ignore?: string[];
  alias?: Record<string, string>;
  maxFiles?: number;
}

async function loadConfig(root: string): Promise<Config> {
  for (const [file, pick] of [
    ['.jparkrc.json', (j: any) => j],
    ['package.json', (j: any) => j?.jpark],
  ] as const) {
    try {
      const cfg = pick(JSON.parse(await readFile(path.join(root, file), 'utf8')));
      if (cfg && typeof cfg === 'object') return cfg;
    } catch {
      /* optional */
    }
  }
  return {};
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* headless box — the URL is printed anyway */
  }
}

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` }
  : { dim: (s: string) => s, cyan: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s };

function summarize(g: Graph): string {
  const s = g.stats;
  const langs = Object.entries(s.languages).sort((a, b) => b[1].lines - a[1].lines).slice(0, 5).map(([l]) => l).join(', ');
  const lines = [
    `  ${c.cyan(g.name)}  ${c.dim(g.root)}`,
    `  ${s.files.toLocaleString()} files · ${s.dirs.toLocaleString()} dirs · ${s.lines.toLocaleString()} lines · ${s.edges.toLocaleString()} imports · ${s.externals.toLocaleString()} external deps  ${c.dim(`(${s.scanMs} ms)`)}`,
  ];
  if (langs) lines.push(c.dim(`  ${langs}`));
  if (s.cycles) lines.push(c.yellow(`  ${s.cycles} import cycle${s.cycles === 1 ? '' : 's'}`));
  if (s.truncated) lines.push(c.yellow('  file limit reached — raise it with --max-files'));
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      ignore: { type: 'string', short: 'i', multiple: true },
      alias: { type: 'string', short: 'a', multiple: true },
      'max-files': { type: 'string' },
      'no-git': { type: 'boolean' },
      'no-unused': { type: 'boolean' },
      'no-open': { type: 'boolean' },
      'no-watch': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void console.log(HELP);
  if (values.version) return void console.log(__JPARK_VERSION__);

  let command = 'serve';
  if (['serve', 'export', 'json'].includes(positionals[0])) command = positionals.shift()!;
  const root = path.resolve(positionals[0] ?? '.');
  const config = await loadConfig(root);

  const alias: Record<string, string> = { ...config.alias };
  for (const pair of values.alias ?? []) {
    const eq = pair.indexOf('=');
    if (eq > 0) alias[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const options: AnalyzeOptions = {
    ignore: [...(config.ignore ?? []), ...(values.ignore ?? [])],
    alias,
    git: !values['no-git'],
    maxFiles: values['max-files'] ? Number(values['max-files']) : config.maxFiles,
    includeUnusedDeps: !values['no-unused'],
  };

  console.log(c.dim('\n  scanning…'));
  const graph = await analyze(root, options);
  console.log(summarize(graph));

  if (command === 'json') {
    const out = path.resolve(values.out ?? 'jpark-graph.json');
    await writeFile(out, JSON.stringify(graph));
    console.log(`\n  ${c.green('wrote')} ${out}\n`);
    return;
  }
  if (command === 'export') {
    const out = path.resolve(values.out ?? 'jpark.html');
    await writeFile(out, await renderHtml({ graph }));
    console.log(`\n  ${c.green('wrote')} ${out}  ${c.dim('— self-contained, works offline')}\n`);
    return;
  }

  const server = await serve(root, {
    ...options,
    graph,
    port: values.port ? Number(values.port) : undefined,
    host: values.host,
    watch: !values['no-watch'],
    onRescan: (g) => console.log(c.dim(`  re-scanned · ${g.stats.files} files · ${g.stats.edges} imports`)),
  });
  console.log(`\n  ${c.green('➜')}  ${c.cyan(server.url)}   ${c.dim('ctrl-c to quit')}\n`);
  if (!values['no-open']) openBrowser(server.url);
  const stop = () => void server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(`\n  jpark: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

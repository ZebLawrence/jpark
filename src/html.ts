import { readFile } from 'node:fs/promises';
import type { Graph } from './types.js';

/** The pre-bundled browser viewer (three.js included) that ships next to this module. */
export function viewerScript(): Promise<string> {
  return readFile(new URL('./viewer.js', import.meta.url), 'utf8');
}

export interface RenderOptions {
  /** Inline this graph into the page. Without it the page fetches ./graph.json. */
  graph?: Graph;
  /** Inline the viewer bundle instead of loading ./viewer.js. Default: true when `graph` is given. */
  inlineViewer?: boolean;
  /** Subscribe to ./events for live reload (used by the dev server). */
  live?: boolean;
  title?: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Render the viewer page. With `graph` set the result is a single self-contained HTML file. */
export async function renderHtml(options: RenderOptions = {}): Promise<string> {
  const { graph, live = false } = options;
  const inlineViewer = options.inlineViewer ?? !!graph;
  const title = options.title ?? (graph ? `${graph.name} — jpark` : 'jpark');
  const data = graph
    ? `<script type="application/json" id="jpark-graph">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>`
    : '';
  const script = inlineViewer
    ? `<script>${(await viewerScript()).replace(/<\/script/gi, '<\\/script')}</script>`
    : '<script src="./viewer.js"></script>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2302060a'/%3E%3Cpath d='M2 12 Q8 -2 14 12' stroke='%2335f0e0' fill='none' stroke-width='1.6'/%3E%3Crect x='1' y='11' width='3' height='3' fill='%233d9bff'/%3E%3Crect x='12' y='11' width='3' height='3' fill='%23ffb02e'/%3E%3C/svg%3E">
<title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%;background:#02060a;overflow:hidden}</style>
</head>
<body data-live="${live ? '1' : '0'}">
${data}
${script}
</body>
</html>
`;
}

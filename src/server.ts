import { watch, type FSWatcher } from 'node:fs';
import http from 'node:http';
import { analyze } from './analyzer/index.js';
import { renderHtml, viewerScript } from './html.js';
import type { AnalyzeOptions, Graph } from './types.js';

export interface ServeOptions extends AnalyzeOptions {
  port?: number;
  host?: string;
  /** Re-scan and push to connected viewers when files change. Default true. */
  watch?: boolean;
  /** Reuse an already-computed graph for the first response. */
  graph?: Graph;
  onRescan?(graph: Graph): void;
}

export interface JparkServer {
  url: string;
  port: number;
  graph(): Graph;
  close(): Promise<void>;
}

const WATCH_IGNORE = /(^|[\\/])(\.git|node_modules|dist|build|out|coverage|\.next|\.turbo|\.cache|target|__pycache__)([\\/]|$)/;

export async function serve(root: string, options: ServeOptions = {}): Promise<JparkServer> {
  let graph = options.graph ?? (await analyze(root, options));
  let fingerprint = fingerprintOf(graph);
  const clients = new Set<http.ServerResponse>();

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    try {
      if (url === '/' || url === '/index.html') {
        send(res, 200, 'text/html; charset=utf-8', await renderHtml({ live: true, title: `${graph.name} — jpark` }));
      } else if (url === '/viewer.js') {
        send(res, 200, 'text/javascript; charset=utf-8', await viewerScript());
      } else if (url === '/graph.json') {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(graph));
      } else if (url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('retry: 1500\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else send(res, 404, 'text/plain', 'not found');
    } catch (err) {
      send(res, 500, 'text/plain', String(err));
    }
  });

  const host = options.host ?? '127.0.0.1';
  const port = await listen(server, options.port ?? 4747, host);

  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  let scanning = false;
  let dirty = false;
  const rescan = async () => {
    if (scanning) {
      dirty = true;
      return;
    }
    scanning = true;
    try {
      const next = await analyze(root, options);
      const fp = fingerprintOf(next);
      if (fp !== fingerprint) {
        graph = next;
        fingerprint = fp;
        options.onRescan?.(graph);
        for (const c of clients) c.write('event: graph\ndata: {}\n\n');
      }
    } catch {
      /* a half-written file — the next change event will retry */
    } finally {
      scanning = false;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(rescan, 450);
  };
  if (options.watch !== false) {
    try {
      watcher = watch(graph.root, { recursive: true }, (_event, file) => {
        if (file && WATCH_IGNORE.test(String(file))) return;
        schedule();
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      /* recursive watch is unavailable on this platform — live reload is simply off */
    }
  }

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  return {
    url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`,
    port,
    graph: () => graph,
    close: () =>
      new Promise((resolve) => {
        if (timer) clearTimeout(timer);
        clearInterval(heartbeat);
        watcher?.close();
        for (const c of clients) c.end();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function send(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function listen(server: http.Server, port: number, host: string, attempts = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempts > 0) {
        listen(server, port + 1, host, attempts - 1).then(resolve, reject);
      } else reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(port);
    });
  });
}

/** Cheap change detector: everything except timestamps and timings. */
function fingerprintOf(g: Graph): string {
  let h = 0;
  const s = JSON.stringify([g.nodes, g.edges]);
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
}

import type { Graph } from '../types.js';
import { Hud } from './hud.js';
import { CSS } from './style.js';
import { World } from './world.js';

declare const __JPARK_VERSION__: string;

async function fetchGraph(): Promise<Graph> {
  const inline = document.getElementById('jpark-graph');
  if (inline?.textContent) return JSON.parse(inline.textContent);
  const res = await fetch('./graph.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not load graph.json (${res.status})`);
  return res.json();
}

async function boot(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'jp-root';
  document.body.appendChild(root);

  const splash = document.createElement('div');
  splash.className = 'jp-boot';
  splash.innerHTML = `<span class="jp-cursor">ACCESSING FILE SYSTEM </span>`;
  root.appendChild(splash);

  try {
    const graph = await fetchGraph();
    const hud = new Hud(root);
    const world = new World(root, graph, {
      onSelect: (id) => hud.showSelection(id),
      onHover: (id, x, y) => hud.showTip(id, x, y),
      onFocusDir: (id) => world.selected == null && hud.showCrumbs(id),
    });
    root.appendChild(hud.root);
    hud.attach(world);
    Object.assign(window, { jpark: { world, hud, version: __JPARK_VERSION__ } });
    requestAnimationFrame(() => splash.classList.add('done'));
    setTimeout(() => splash.remove(), 900);

    if (document.body.dataset.live === '1' && 'EventSource' in window) {
      const events = new EventSource('./events');
      events.addEventListener('graph', async () => {
        try {
          world.load(await fetchGraph());
          hud.setGraph();
          hud.showSelection(world.selected);
          hud.toast('file system changed — re-scanned');
        } catch {
          /* server is restarting; the next event will catch up */
        }
      });
    }
  } catch (err) {
    splash.classList.add('err');
    splash.textContent = `jpark could not start\n\n${err instanceof Error ? err.message : String(err)}`;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else void boot();

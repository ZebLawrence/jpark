import type { Edge, ExternalNode, FileNode, Graph, GraphNode } from '../types.js';
import type { GraphIndex } from './graphIndex.js';
import { ARC, CATEGORY_LABEL, CATEGORY_SHAPE, DEP_COLOR, DEP_LABEL, SHAPE_GLYPH, hslToHex, langColor } from './theme.js';
import type { EdgeMode, World } from './world.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => n.toLocaleString('en-US');
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const REGISTRY: Record<string, (n: string) => string> = {
  npm: (n) => `https://www.npmjs.com/package/${n}`,
  pypi: (n) => `https://pypi.org/project/${n}/`,
  cargo: (n) => `https://crates.io/crates/${n}`,
  gem: (n) => `https://rubygems.org/gems/${n}`,
  go: (n) => `https://pkg.go.dev/${n}`,
};

const MODES: [EdgeMode, string][] = [['all', 'all'], ['focus', 'focus'], ['folders', 'dirs'], ['off', 'off']];

export class Hud {
  readonly root: HTMLElement;
  private world!: World;
  private index!: GraphIndex;
  private graph!: Graph;
  private el: Record<string, HTMLElement> = {};
  private results: GraphNode[] = [];
  private active = 0;
  private searchPool: { node: GraphNode; name: string; path: string }[] = [];
  private mapStatic: HTMLCanvasElement | null = null;
  private mapView = { scale: 1, ox: 0, oz: 0 };
  private toastTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'jp-hud';
    this.root.innerHTML = `
      <div class="jp-vignette"></div><div class="jp-scan"></div>
      <div class="jp-top">
        <div class="jp-panel jp-brand"><b>JPARK</b><span data-el="name"></span></div>
        <div class="jp-panel jp-stats" data-el="stats"></div>
        <div class="jp-spacer"></div>
        <div class="jp-panel jp-search">
          <input data-el="search" type="text" spellcheck="false" autocomplete="off" placeholder="search files · folders · packages      /">
          <ul class="jp-panel jp-results" data-el="results"></ul>
        </div>
      </div>
      <aside class="jp-panel jp-left" data-el="left"></aside>
      <aside class="jp-panel jp-info" data-el="info"></aside>
      <div class="jp-bottom">
        <div class="jp-panel jp-crumbs" data-el="crumbs"></div>
        <div class="jp-hint"><b>click</b> folder to fly · <b>drag</b> pan · <b>right-drag</b> orbit · <b>scroll</b> zoom · <b>WASD</b> move · <b>?</b> keys</div>
      </div>
      <div class="jp-panel jp-minimap"><canvas data-el="map" width="492" height="312"></canvas></div>
      <div class="jp-panel jp-tip" data-el="tip"></div>
      <div class="jp-panel jp-toast" data-el="toast"></div>
      <div class="jp-help" data-el="help"><div class="jp-panel">
        <h3>FLIGHT MANUAL</h3>
        <div class="jp-keys">
          <kbd>click</kbd><span>select · folders: fly there</span><kbd>dbl-click</kbd><span>fly to anything</span>
          <kbd>drag</kbd><span>pan</span><kbd>right-drag</kbd><span>orbit</span>
          <kbd>scroll</kbd><span>zoom to cursor</span><kbd>W A S D</kbd><span>move (shift = fast)</span>
          <kbd>Q E</kbd><span>rotate</span><kbd>R F</kbd><span>closer / further</span>
          <kbd>← →</kbd><span>sibling folder</span><kbd>↑ ↓</kbd><span>into child / up to parent</span>
          <kbd>space</kbd><span>fly to selection</span><kbd>H</kbd><span>overview</span>
          <kbd>/</kbd><span>search</span><kbd>esc</kbd><span>deselect</span>
          <kbd>1 2 3 4</kbd><span>arcs: all / focus / dirs / off</span><kbd>T</kbd><span>transitive imports</span>
          <kbd>X</kbd><span>external packages</span><kbd>C</kbd><span>cycles only</span>
          <kbd>L</kbd><span>labels</span><kbd>B</kbd><span>bloom</span>
        </div>
      </div></div>`;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((n) => (this.el[n.dataset.el!] = n));
  }

  attach(world: World): void {
    this.world = world;
    this.setGraph();
    this.bind();
    const tick = () => {
      this.drawMap();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Call after world.load() — refreshes everything derived from the graph. */
  setGraph(): void {
    this.index = this.world.index;
    this.graph = this.index.graph;
    const g = this.graph;
    const s = g.stats;
    this.el.name.textContent = `fsn://${g.name}`;
    document.title = `${g.name} — jpark`;
    const stat = (v: string, l: string, cls = '') => `<div class="jp-stat ${cls}"><b>${v}</b><span>${l}</span></div>`;
    this.el.stats.innerHTML =
      stat(fmt(s.files), 'files') + stat(fmt(s.dirs), 'folders') + stat(fmt(s.lines), 'lines') + stat(fmt(s.edges), 'imports') +
      stat(fmt(s.externals), 'packages') + (s.cycles ? stat(fmt(s.cycles), s.cycles === 1 ? 'cycle' : 'cycles', 'warn') : '');
    this.searchPool = g.nodes
      .filter((n) => n.type !== 'dir' || n.parent >= 0)
      .map((node) => ({ node, name: node.name.toLowerCase(), path: (node.type === 'external' ? node.name : node.path).toLowerCase() }));
    this.renderLeft();
    this.renderMapStatic();
    this.showCrumbs(this.world.selected ?? this.world.currentFocusDir);
    if (this.graph.edges.length > 4000 && this.world.options.edgeMode === 'all') this.setMode('focus');
  }

  // ───────────────────────────── left panel ─────────────────────────────

  private renderLeft(): void {
    const o = this.world.options;
    const langs = Object.entries(this.graph.stats.languages).sort((a, b) => b[1].files - a[1].files);
    const shown = langs.slice(0, 10);
    const cats = new Map<string, number>();
    for (const f of this.index.files) cats.set(f.category, (cats.get(f.category) ?? 0) + 1);
    const deps = new Map<string, number>();
    for (const e of this.index.externals) deps.set(e.dep, (deps.get(e.dep) ?? 0) + 1);
    const toggle = (key: string, label: string, on: boolean, kbd: string) =>
      `<div class="jp-toggle ${on ? 'on' : ''}" data-toggle="${key}"><i></i>${label}<kbd>${kbd}</kbd></div>`;

    this.el.left.innerHTML = `
      <div class="jp-h">import arcs</div>
      <div class="jp-seg">${MODES.map(([m, l], i) => `<button data-mode="${m}" class="${o.edgeMode === m ? 'on' : ''}" title="key ${i + 1}">${l}</button>`).join('')}</div>
      <div class="jp-toggles">
        ${toggle('externals', 'packages', o.externals, 'X')}${toggle('transitive', 'transitive', o.transitive, 'T')}
        ${toggle('labels', 'labels', o.labels, 'L')}${toggle('cyclesOnly', 'cycles', o.cyclesOnly, 'C')}
        ${toggle('bloom', 'bloom', o.bloom, 'B')}
      </div>
      <div class="jp-legend jp-arcs-legend" style="margin-top:8px">
        <div><b style="color:${ARC.internal}"></b><span>import</span></div>
        <div><b style="color:${ARC.external}"></b><span>→ package</span></div>
        <div><b style="color:${ARC.outgoing}"></b><span>selection imports</span></div>
        <div><b style="color:${ARC.incoming}"></b><span>imports selection</span></div>
        ${this.graph.stats.cycles ? `<div><b style="color:${ARC.cycle}"></b><span>import cycle</span></div>` : ''}
      </div>
      <div class="jp-h">shape = kind</div>
      <div class="jp-legend">${[...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) =>
        `<div><i>${SHAPE_GLYPH[CATEGORY_SHAPE[c as keyof typeof CATEGORY_SHAPE]]}</i><span>${CATEGORY_LABEL[c as keyof typeof CATEGORY_LABEL]}</span><em>${fmt(n)}</em></div>`).join('')}
        <div><i>↕</i><span>height = lines of code</span></div>
      </div>
      <div class="jp-h">color = language <span>click to spotlight</span></div>
      <div class="jp-legend">${shown.map(([l, v]) =>
        `<div data-lang="${esc(l)}" class="${o.spotlightLang === l ? 'on' : ''}"><i style="color:${langColor(l)}">■</i><span>${esc(l)}</span><em>${fmt(v.files)}</em></div>`).join('')}
        ${langs.length > shown.length ? `<div><i></i><span style="color:var(--jp-dim)">+ ${langs.length - shown.length} more</span></div>` : ''}
      </div>
      ${deps.size ? `<div class="jp-h">packages</div><div class="jp-legend">${[...deps.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) =>
        `<div><i style="color:${DEP_COLOR[d as keyof typeof DEP_COLOR]}">⬢</i><span>${DEP_LABEL[d as keyof typeof DEP_LABEL]}</span><em>${fmt(n)}</em></div>`).join('')}
        <div><i style="color:#555">⬢</i><span style="color:var(--jp-dim)">dim = never imported</span></div></div>` : ''}`;
  }

  private setMode(mode: EdgeMode): void {
    this.world.setOptions({ edgeMode: mode });
    this.renderLeft();
  }

  private toggle(key: 'externals' | 'transitive' | 'labels' | 'cyclesOnly' | 'bloom'): void {
    this.world.setOptions({ [key]: !this.world.options[key] });
    this.renderLeft();
    const names = { externals: 'packages', transitive: 'transitive imports', labels: 'labels', cyclesOnly: 'cycles only', bloom: 'bloom' };
    this.toast(`${names[key]} ${this.world.options[key] ? 'on' : 'off'}`);
  }

  toast(text: string): void {
    const t = this.el.toast;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 1200);
  }

  // ───────────────────────────── selection inspector ─────────────────────────────

  private glyph(node: GraphNode): string {
    if (node.type === 'dir') return '<i style="color:#35f0e0">▰</i>';
    if (node.type === 'external') return `<i style="color:${DEP_COLOR[node.dep]}">⬢</i>`;
    return `<i style="color:${langColor(node.lang)}">${SHAPE_GLYPH[CATEGORY_SHAPE[node.category]]}</i>`;
  }

  private row(node: GraphNode, note = ''): string {
    const label = node.type === 'external' ? node.name : node.path || node.name;
    return `<li data-id="${node.id}" title="${esc(label)}">${this.glyph(node)}<span>&lrm;${esc(label)}</span>${note ? `<em>${esc(note)}</em>` : ''}</li>`;
  }

  private listSection(title: string, cls: string, rows: string[], limit = 40): string {
    if (!rows.length) return '';
    const more = rows.length > limit ? `<div class="jp-more">+ ${rows.length - limit} more</div>` : '';
    return `<div class="jp-h ${cls}">${title} <span>${rows.length}</span></div><ul class="jp-list">${rows.slice(0, limit).join('')}</ul>${more}`;
  }

  showSelection(id: number | null): void {
    if (!this.world) return;
    const info = this.el.info;
    if (id == null) {
      info.classList.remove('open');
      this.showCrumbs(this.world.currentFocusDir);
      return;
    }
    const { index, graph } = this;
    const node = index.node(id);
    const kindNote = (e: Edge) => (e.cycle ? 'cycle' : e.kind === 'import' ? '' : e.kind);
    let html = `<button class="jp-close" data-act="close" title="esc">×</button>`;

    if (node.type === 'file') {
      const out = index.out[id].map((i) => graph.edges[i]);
      const inc = index.inc[id].map((i) => graph.edges[i]);
      const internal = out.filter((e) => index.node(e.to).type !== 'external');
      const external = out.filter((e) => index.node(e.to).type === 'external');
      const cycle = graph.cycles.find((c) => c.includes(id));
      html += `<h2>${this.glyph(node)}${esc(node.name)}</h2><div class="jp-path">${esc(node.path)}</div>
        <div class="jp-meta"><b>${esc(node.lang)}</b> · ${CATEGORY_LABEL[node.category]} · <b>${fmt(node.lines)}</b> lines · ${bytes(node.size)}</div>
        <div class="jp-actions"><button class="jp-btn" data-act="fly">fly to</button><a class="jp-btn" href="vscode://file${encodeURI(`${graph.root}/${node.path}`)}">open in editor</a><button class="jp-btn" data-act="copy" data-copy="${esc(node.path)}">copy path</button></div>`;
      html += this.listSection('imports', 'jp-out', internal.map((e) => this.row(index.node(e.to), kindNote(e))));
      html += this.listSection('packages', 'jp-ext', external.map((e) => this.row(index.node(e.to), kindNote(e))));
      html += this.listSection('imported by', 'jp-in', inc.map((e) => this.row(index.node(e.from), kindNote(e))));
      if (cycle) html += this.listSection('import cycle', 'jp-cyc', cycle.filter((m) => m !== id).map((m) => this.row(index.node(m))));
      if (!out.length && !inc.length) html += `<div class="jp-more" style="margin-top:10px">no imports in or out — an island.</div>`;
    } else if (node.type === 'dir') {
      const outTo = new Map<number, number>();
      const inFrom = new Map<number, number>();
      const pkgs = new Map<number, number>();
      for (const e of graph.edges) {
        const a = index.isInside(e.from, id);
        const target = index.node(e.to);
        if (target.type === 'external') {
          if (a) pkgs.set(e.to, (pkgs.get(e.to) ?? 0) + 1);
          continue;
        }
        const b = index.isInside(e.to, id);
        if (a && !b) {
          const key = target.type === 'file' ? target.parent : target.id;
          outTo.set(key, (outTo.get(key) ?? 0) + 1);
        } else if (b && !a) {
          const key = (index.node(e.from) as FileNode).parent;
          inFrom.set(key, (inFrom.get(key) ?? 0) + 1);
        }
      }
      const ranked = (m: Map<number, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => this.row(index.node(k), `×${n}`));
      html += `<h2>${this.glyph(node)}${esc(node.name)}/</h2><div class="jp-path">${esc(node.path || '(repository root)')}</div>
        <div class="jp-meta"><b>${fmt(index.filesBelow[id])}</b> files · <b>${fmt(index.linesBelow[id])}</b> lines · ${index.childDirs[id].length} subfolders</div>
        <div class="jp-actions"><button class="jp-btn" data-act="fly">fly to</button>${node.parent >= 0 ? `<button class="jp-btn" data-id="${node.parent}">↑ parent</button>` : ''}<button class="jp-btn" data-act="copy" data-copy="${esc(node.path)}">copy path</button></div>`;
      html += this.listSection('depends on folders', 'jp-out', ranked(outTo), 25);
      html += this.listSection('used by folders', 'jp-in', ranked(inFrom), 25);
      html += this.listSection('packages', 'jp-ext', ranked(pkgs), 25);
      html += this.listSection('subfolders', '', index.childDirs[id].map((d) => this.row(index.node(d), `${fmt(index.filesBelow[d])} files`)), 25);
    } else {
      const ext = node as ExternalNode;
      const inc = index.inc[id].map((i) => graph.edges[i]);
      const url = REGISTRY[ext.ecosystem]?.(ext.name);
      html += `<h2>${this.glyph(ext)}${esc(ext.name)}</h2>
        <div class="jp-meta"><span class="jp-tag" style="color:${DEP_COLOR[ext.dep]}">${DEP_LABEL[ext.dep]}</span>${esc(ext.ecosystem)}${ext.version ? ` · <b>${esc(ext.version)}</b>` : ''}</div>
        <div class="jp-actions"><button class="jp-btn" data-act="fly">fly to</button>${url && ext.dep !== 'builtin' ? `<a class="jp-btn" target="_blank" rel="noopener" href="${esc(url)}">registry ↗</a>` : ''}</div>`;
      html += this.listSection('imported by', 'jp-in', inc.map((e) => this.row(index.node(e.from), kindNote(e))), 60);
      if (!inc.length) html += `<div class="jp-more" style="margin-top:10px">declared in a manifest, but nothing scanned imports it.</div>`;
    }
    info.innerHTML = html;
    info.classList.add('open');
    info.scrollTop = 0;
    this.showCrumbs(id);
  }

  showCrumbs(id: number): void {
    if (!this.world) return;
    const node = this.index.node(id);
    if (!node) return;
    if (node.type === 'external') {
      this.el.crumbs.innerHTML = `<a>packages</a><s>/</s><a data-id="${id}">${esc(node.name)}</a>`;
      return;
    }
    const chain = [...this.index.ancestors(id), id];
    this.el.crumbs.innerHTML = chain
      .map((c) => `<a data-id="${c}">${esc(this.index.node(c).name)}</a>`)
      .join('<s>/</s>');
  }

  showTip(id: number | null, x: number, y: number): void {
    const tip = this.el.tip;
    if (!this.world) return;
    if (id == null) return void (tip.style.display = 'none');
    const node = this.index.node(id);
    const inN = this.index.inc[id].length;
    const outN = this.index.out[id].length;
    let sub = '';
    if (node.type === 'file') sub = `${node.lang} · ${fmt(node.lines)} lines · <span class="jp-out">${outN} out</span> · <span class="jp-in">${inN} in</span>`;
    else if (node.type === 'dir') sub = `${fmt(this.index.filesBelow[id])} files · ${fmt(this.index.linesBelow[id])} lines`;
    else sub = `${DEP_LABEL[node.dep]}${node.version ? ` · ${esc(node.version)}` : ''} · <span class="jp-in">${inN} importers</span>`;
    tip.innerHTML = `<b>${esc(node.type === 'dir' ? `${node.path || node.name}/` : node.type === 'file' ? node.path : node.name)}</b><div>${sub}</div>`;
    tip.style.display = 'block';
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(x, window.innerWidth - w - 24)}px`;
    tip.style.top = `${Math.min(y, window.innerHeight - 70)}px`;
  }

  // ───────────────────────────── search ─────────────────────────────

  private runSearch(q: string): void {
    const query = q.trim().toLowerCase();
    const ul = this.el.results;
    if (!query) {
      this.results = [];
      ul.classList.remove('open');
      return;
    }
    const scored: [number, GraphNode][] = [];
    for (const item of this.searchPool) {
      let score = 0;
      const at = item.name.indexOf(query);
      if (at === 0) score = 1000 - item.name.length;
      else if (at > 0) score = 700 - at - item.name.length * 0.1;
      else {
        const p = item.path.indexOf(query);
        if (p >= 0) score = 400 - item.path.length * 0.1;
        else if (query.length > 2 && subsequence(query, item.path)) score = 100 - item.path.length * 0.1;
      }
      if (score > 0) scored.push([score + (item.node.type === 'dir' ? 5 : 0), item.node]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    this.results = scored.slice(0, 14).map((s) => s[1]);
    this.active = 0;
    this.paintResults();
  }

  private paintResults(): void {
    const ul = this.el.results;
    ul.innerHTML = this.results.length
      ? this.results.map((n, i) => {
          const where = n.type === 'external' ? `${n.ecosystem} package` : n.path.slice(0, Math.max(0, n.path.length - n.name.length - 1));
          return `<li data-id="${n.id}" class="${i === this.active ? 'active' : ''}">${this.glyph(n)}<b>${esc(n.name)}${n.type === 'dir' ? '/' : ''}</b><em>&lrm;${esc(where)}</em></li>`;
        }).join('')
      : '<li style="color:var(--jp-dim)">nothing found</li>';
    ul.classList.add('open');
  }

  private go(id: number): void {
    this.world.select(id, true);
  }

  // ───────────────────────────── minimap ─────────────────────────────

  private renderMapStatic(): void {
    const canvas = this.el.map as HTMLCanvasElement;
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const g = off.getContext('2d')!;
    const b = this.world.layout.bounds;
    const pad = 14;
    const scale = Math.min((off.width - pad * 2) / Math.max(1, b.maxX - b.minX), (off.height - pad * 2) / Math.max(1, b.maxZ - b.minZ));
    const ox = off.width / 2 - ((b.minX + b.maxX) / 2) * scale;
    const oz = off.height / 2 - ((b.minZ + b.maxZ) / 2) * scale;
    this.mapView = { scale, ox, oz };
    g.fillStyle = 'rgba(2,10,14,.6)';
    g.fillRect(0, 0, off.width, off.height);
    for (const d of this.world.layout.dirs.values()) {
      g.fillStyle = hslToHex(d.hue, d.level === 0 ? 0.1 : 0.7, 0.42);
      const w = Math.max(1.5, d.w * scale);
      const h = Math.max(1.5, d.d * scale);
      g.fillRect(d.x * scale + ox - w / 2, d.z * scale + oz - h / 2, w, h);
    }
    g.fillStyle = '#ffb02e';
    for (const e of this.world.layout.externals.values()) {
      g.beginPath();
      g.arc(e.x * scale + ox, e.z * scale + oz, Math.max(1, e.r * scale), 0, Math.PI * 2);
      g.fill();
    }
    this.mapStatic = off;
  }

  private drawMap(): void {
    if (!this.mapStatic) return;
    const canvas = this.el.map as HTMLCanvasElement;
    const g = canvas.getContext('2d')!;
    const { scale, ox, oz } = this.mapView;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(this.mapStatic, 0, 0);
    const cam = this.world.camera.position;
    const t = this.world.controls.target;
    const tx = t.x * scale + ox;
    const tz = t.z * scale + oz;
    const ang = Math.atan2(t.z - cam.z, t.x - cam.x);
    // footprint of what the camera roughly sees: a wedge through the look-at point
    const range = Math.max(9, cam.distanceTo(t) * 0.55 * scale);
    const half = 0.62;
    const ax = tx - Math.cos(ang) * range * 0.9;
    const az = tz - Math.sin(ang) * range * 0.9;
    g.save();
    g.beginPath();
    g.rect(0, 0, canvas.width, canvas.height);
    g.clip();
    g.fillStyle = 'rgba(60,242,255,.13)';
    g.strokeStyle = 'rgba(60,242,255,.85)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(ax, az);
    g.lineTo(ax + Math.cos(ang - half) * range * 2.2, az + Math.sin(ang - half) * range * 2.2);
    g.lineTo(ax + Math.cos(ang + half) * range * 2.2, az + Math.sin(ang + half) * range * 2.2);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = '#fff';
    g.fillRect(tx - 2, tz - 2, 4, 4);
  }

  // ───────────────────────────── events ─────────────────────────────

  private bind(): void {
    const w = this.world;
    const search = this.el.search as HTMLInputElement;

    this.root.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const mode = t.closest<HTMLElement>('[data-mode]');
      if (mode) return this.setMode(mode.dataset.mode as EdgeMode);
      const tog = t.closest<HTMLElement>('[data-toggle]');
      if (tog) return this.toggle(tog.dataset.toggle as 'externals');
      const lang = t.closest<HTMLElement>('[data-lang]');
      if (lang) {
        const l = lang.dataset.lang!;
        w.setOptions({ spotlightLang: w.options.spotlightLang === l ? null : l });
        return this.renderLeft();
      }
      const act = t.closest<HTMLElement>('[data-act]');
      if (act) {
        if (act.dataset.act === 'close') w.select(null);
        else if (act.dataset.act === 'fly' && w.selected != null) w.flyToNode(w.selected);
        else if (act.dataset.act === 'copy') {
          navigator.clipboard?.writeText(act.dataset.copy ?? '').then(() => this.toast('path copied'), () => {});
        }
        return;
      }
      if (t.closest('.jp-stat.warn')) {
        this.toggle('cyclesOnly');
        const first = this.graph.cycles[0]?.[0];
        if (first != null && w.options.cyclesOnly) this.go(first);
        return;
      }
      const row = t.closest<HTMLElement>('[data-id]');
      if (row) {
        this.go(Number(row.dataset.id));
        if (row.closest('.jp-results')) {
          this.el.results.classList.remove('open');
          search.blur();
        }
      }
    });

    search.addEventListener('input', () => this.runSearch(search.value));
    search.addEventListener('focus', () => search.value && this.runSearch(search.value));
    search.addEventListener('blur', () => setTimeout(() => this.el.results.classList.remove('open'), 150));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.results.length;
        if (n) this.active = (this.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.paintResults();
      } else if (e.key === 'Enter') {
        const hit = this.results[this.active];
        if (hit) {
          this.go(hit.id);
          search.blur();
        }
      } else if (e.key === 'Escape') {
        search.value = '';
        this.runSearch('');
        search.blur();
      }
      e.stopPropagation();
    });

    const map = this.el.map as HTMLCanvasElement;
    const jump = (e: PointerEvent) => {
      const r = map.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * map.width;
      const pz = ((e.clientY - r.top) / r.height) * map.height;
      w.panTo((px - this.mapView.ox) / this.mapView.scale, (pz - this.mapView.oz) / this.mapView.scale);
    };
    map.addEventListener('pointerdown', (e) => {
      map.setPointerCapture(e.pointerId);
      jump(e);
    });
    map.addEventListener('pointermove', (e) => e.buttons && jump(e));

    this.el.help.addEventListener('click', () => this.el.help.classList.remove('open'));

    window.addEventListener('keydown', (e) => {
      if (e.target === search || e.metaKey || e.ctrlKey || e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          search.focus();
          search.select();
        }
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const nav = { ArrowUp: 'child', ArrowDown: 'parent', ArrowLeft: 'prev', ArrowRight: 'next' } as const;
      if (k in nav) {
        e.preventDefault();
        w.navigate(nav[k as keyof typeof nav]);
      } else if (k === '/') {
        e.preventDefault();
        search.focus();
        search.select();
      } else if (k === 'Escape') {
        if (this.el.help.classList.contains('open')) this.el.help.classList.remove('open');
        else w.select(null);
      } else if (k === ' ') {
        e.preventDefault();
        if (w.selected != null) w.flyToNode(w.selected);
      } else if (k === 'h' || k === 'Home') w.overview();
      else if (k === '?') this.el.help.classList.toggle('open');
      else if (k >= '1' && k <= '4') this.setMode(MODES[Number(k) - 1][0]);
      else if (k === 'x') this.toggle('externals');
      else if (k === 't') this.toggle('transitive');
      else if (k === 'l') this.toggle('labels');
      else if (k === 'c') this.toggle('cyclesOnly');
      else if (k === 'b') this.toggle('bloom');
    });
  }
}

function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

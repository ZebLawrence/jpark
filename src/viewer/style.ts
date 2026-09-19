export const CSS = /* css */ `
:root { --jp-c: #35f0e0; --jp-c2: #ff4fd8; --jp-amber: #ffb02e; --jp-dim: #5d8a94; --jp-line: rgba(53,240,224,.28); --jp-panel: rgba(2,12,18,.78); }
.jp-root { position: fixed; inset: 0; font: 12px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; color: #c9eef2; user-select: none; -webkit-font-smoothing: antialiased; }
.jp-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
.jp-hud { position: absolute; inset: 0; pointer-events: none; }
.jp-hud > * { pointer-events: auto; }
.jp-panel { box-sizing: border-box; background: var(--jp-panel); border: 1px solid var(--jp-line); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 24px rgba(53,240,224,.06) inset; position: relative; }
.jp-panel::before, .jp-panel::after { content: ""; position: absolute; width: 9px; height: 9px; border: 1px solid var(--jp-c); pointer-events: none; }
.jp-panel::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.jp-panel::after { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
.jp-scan { position: absolute; inset: 0; pointer-events: none !important; background: repeating-linear-gradient(0deg, rgba(0,0,0,.13) 0 1px, transparent 1px 3px); mix-blend-mode: multiply; opacity: .55; }
.jp-vignette { position: absolute; inset: 0; pointer-events: none !important; background: radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%); }

.jp-top { position: absolute; top: 12px; left: 12px; right: 12px; display: flex; gap: 10px; align-items: stretch; pointer-events: none; }
.jp-top > * { pointer-events: auto; }
.jp-brand { padding: 7px 12px; display: flex; flex-direction: column; justify-content: center; min-width: 0; }
.jp-brand b { color: var(--jp-c); letter-spacing: .34em; font-size: 13px; text-shadow: 0 0 12px rgba(53,240,224,.7); }
.jp-brand span { color: var(--jp-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.jp-stats { padding: 7px 12px; display: flex; gap: 16px; align-items: center; white-space: nowrap; overflow: hidden; }
.jp-stat { display: flex; flex-direction: column; }
.jp-stat b { color: #eaffff; font-size: 13px; font-weight: 600; }
.jp-stat span { color: var(--jp-dim); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
.jp-stat.warn b { color: #ff5b6e; cursor: pointer; }
.jp-spacer { flex: 1; }
.jp-search { width: min(360px, 34vw); position: relative; }
.jp-search input { width: 100%; height: 100%; min-height: 40px; box-sizing: border-box; background: transparent; border: 0; outline: 0; color: #eaffff; font: inherit; font-size: 13px; padding: 0 12px; }
.jp-search input::placeholder { color: var(--jp-dim); }
.jp-results { position: absolute; top: calc(100% + 6px); left: -1px; right: -1px; margin: 0; padding: 4px 0; list-style: none; max-height: 60vh; overflow: auto; display: none; z-index: 5; }
.jp-results.open { display: block; }
.jp-results li { padding: 4px 12px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; white-space: nowrap; overflow: hidden; }
.jp-results li.active, .jp-results li:hover { background: rgba(53,240,224,.13); }
.jp-results li i { font-style: normal; width: 1.1em; text-align: center; flex: none; }
.jp-results li em { font-style: normal; color: var(--jp-dim); overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }

.jp-left { position: absolute; top: 70px; left: 12px; width: 214px; max-height: calc(100vh - 140px); overflow: auto; padding: 10px 12px 12px; scrollbar-width: thin; scrollbar-color: var(--jp-line) transparent; }
.jp-h { color: var(--jp-dim); font-size: 10px; letter-spacing: .2em; text-transform: uppercase; margin: 12px 0 6px; display: flex; justify-content: space-between; }
.jp-h:first-child { margin-top: 0; }
.jp-seg { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--jp-line); }
.jp-seg button { all: unset; text-align: center; padding: 4px 0; cursor: pointer; color: var(--jp-dim); border-right: 1px solid var(--jp-line); font-size: 11px; }
.jp-seg button:last-child { border-right: 0; }
.jp-seg button:hover { color: #eaffff; }
.jp-seg button.on { background: rgba(53,240,224,.18); color: var(--jp-c); text-shadow: 0 0 8px rgba(53,240,224,.6); }
.jp-toggles { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-top: 8px; }
.jp-toggle { display: flex; gap: 6px; align-items: center; cursor: pointer; color: #9cc7cf; padding: 1px 0; }
.jp-toggle:hover { color: #eaffff; }
.jp-toggle i { width: 9px; height: 9px; border: 1px solid var(--jp-c); display: inline-block; flex: none; }
.jp-toggle.on i { background: var(--jp-c); box-shadow: 0 0 8px var(--jp-c); }
.jp-toggle kbd, .jp-seg kbd { color: var(--jp-dim); font: inherit; font-size: 10px; margin-left: auto; }
.jp-legend { display: grid; gap: 1px; }
.jp-legend div { display: flex; gap: 8px; align-items: center; padding: 1px 4px; margin: 0 -4px; color: #9cc7cf; }
.jp-legend div[data-lang] { cursor: pointer; }
.jp-legend div[data-lang]:hover { background: rgba(53,240,224,.1); color: #eaffff; }
.jp-legend div.on { background: rgba(53,240,224,.18); color: #fff; }
.jp-legend i { font-style: normal; width: 1.2em; text-align: center; flex: none; text-shadow: 0 0 8px currentColor; }
.jp-legend span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jp-legend em { font-style: normal; color: var(--jp-dim); font-size: 11px; }
.jp-arcs-legend b { display: inline-block; width: 22px; height: 2px; flex: none; box-shadow: 0 0 6px currentColor; background: currentColor; }

.jp-info { position: absolute; top: 70px; right: 12px; width: 318px; max-height: calc(100vh - 258px); overflow: auto; padding: 12px 14px 14px; display: none; scrollbar-width: thin; scrollbar-color: var(--jp-line) transparent; user-select: text; }
.jp-info.open { display: block; }
.jp-info h2 { margin: 0 22px 2px 0; font-size: 15px; font-weight: 600; color: #fff; word-break: break-all; display: flex; gap: 8px; align-items: baseline; }
.jp-info h2 i { font-style: normal; text-shadow: 0 0 10px currentColor; }
.jp-close { all: unset; position: absolute; top: 8px; right: 10px; cursor: pointer; color: var(--jp-dim); font-size: 16px; padding: 2px 4px; }
.jp-close:hover { color: #fff; }
.jp-path { color: var(--jp-dim); word-break: break-all; }
.jp-meta { margin: 8px 0 2px; color: #a9d3da; }
.jp-meta b { color: #eaffff; font-weight: 600; }
.jp-tag { display: inline-block; border: 1px solid currentColor; padding: 0 5px; font-size: 10px; letter-spacing: .08em; margin-right: 6px; text-transform: uppercase; }
.jp-actions { display: flex; gap: 6px; margin: 10px 0 2px; flex-wrap: wrap; }
.jp-btn { all: unset; cursor: pointer; border: 1px solid var(--jp-line); padding: 3px 9px; color: var(--jp-c); font-size: 11px; }
.jp-btn:hover { background: rgba(53,240,224,.16); border-color: var(--jp-c); }
.jp-list { margin: 0; padding: 0; list-style: none; }
.jp-list li { display: flex; gap: 7px; align-items: baseline; padding: 2px 6px; margin: 0 -6px; cursor: pointer; white-space: nowrap; }
.jp-list li:hover { background: rgba(53,240,224,.12); }
.jp-list li i { font-style: normal; flex: none; width: 1.1em; text-align: center; }
.jp-list li span { overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; flex: 1; color: #d6f4f7; }
.jp-list li em { font-style: normal; color: var(--jp-dim); font-size: 10px; flex: none; }
.jp-more { color: var(--jp-dim); padding: 2px 0; }
.jp-out { color: #3cf2ff; } .jp-in { color: #ff4fd8; } .jp-ext { color: var(--jp-amber); } .jp-cyc { color: #ff5b6e; }

.jp-bottom { position: absolute; left: 12px; bottom: 12px; right: 270px; display: flex; gap: 10px; align-items: center; pointer-events: none; }
.jp-bottom > * { pointer-events: auto; }
.jp-crumbs { padding: 6px 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60vw; }
.jp-crumbs a { color: #a9d3da; cursor: pointer; }
.jp-crumbs a:hover { color: var(--jp-c); text-shadow: 0 0 8px var(--jp-c); }
.jp-crumbs a:last-child { color: #fff; }
.jp-crumbs s { text-decoration: none; color: var(--jp-dim); margin: 0 5px; }
.jp-hint { color: var(--jp-dim); padding: 6px 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jp-hint b { color: #a9d3da; font-weight: 400; }
.jp-minimap { position: absolute; right: 12px; bottom: 12px; width: 246px; height: 156px; padding: 0; overflow: hidden; }
.jp-minimap canvas { width: 100%; height: 100%; display: block; cursor: crosshair; }

.jp-tip { position: fixed; z-index: 10; pointer-events: none !important; padding: 5px 9px; max-width: 420px; display: none; transform: translate(14px, 16px); white-space: nowrap; }
.jp-tip b { color: #fff; font-weight: 600; } .jp-tip div { color: var(--jp-dim); overflow: hidden; text-overflow: ellipsis; }

.jp-help { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,4,8,.6); z-index: 20; }
.jp-help.open { display: flex; }
.jp-help .jp-panel { padding: 18px 24px; max-width: 640px; }
.jp-help h3 { margin: 0 0 10px; color: var(--jp-c); letter-spacing: .2em; font-size: 12px; }
.jp-keys { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 4px 14px; }
.jp-keys kbd { color: #fff; font: inherit; border: 1px solid var(--jp-line); padding: 0 6px; text-align: center; white-space: nowrap; }
.jp-keys span { color: #a9d3da; }

.jp-boot { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #02060a; z-index: 30; transition: opacity .6s; color: var(--jp-c); text-shadow: 0 0 12px rgba(53,240,224,.6); letter-spacing: .12em; white-space: pre; }
.jp-boot.done { opacity: 0; pointer-events: none; }
.jp-boot.err { color: #ff5b6e; text-shadow: none; white-space: pre-wrap; padding: 40px; text-align: center; }
.jp-cursor::after { content: "█"; animation: jp-blink 1s steps(2) infinite; }
@keyframes jp-blink { 50% { opacity: 0; } }
.jp-toast { position: absolute; top: 66px; left: 50%; transform: translateX(-50%); padding: 5px 12px; color: var(--jp-c); opacity: 0; transition: opacity .3s; pointer-events: none !important; }
.jp-toast.show { opacity: 1; }
@media (max-width: 900px) { .jp-stats, .jp-left, .jp-hint { display: none; } .jp-info { width: min(318px, calc(100vw - 24px)); } }
`;

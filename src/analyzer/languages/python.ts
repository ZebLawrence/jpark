import type { DepKind, FileNode } from '../../types.js';
import { Ctx, dirname, joinPath, type LanguageAnalyzer } from '../context.js';

const STDLIB = new Set(
  (
    '__future__ abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 ' +
    'calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib ' +
    'contextvars copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest ' +
    'email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt ' +
    'getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ' +
    'ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap ' +
    'modulefinder msilib msvcrt multiprocessing netrc nis nntplib ntpath numbers opcode operator optparse os ossaudiodev ' +
    'pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd ' +
    'py_compile pyclbr pydoc queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select ' +
    'selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile ' +
    'sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog ' +
    'tabnanny tarfile telnetlib tempfile termios test textwrap threading time timeit tkinter token tokenize tomllib trace ' +
    'traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref ' +
    'webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread typing_extensions'
  ).split(' '),
);

/** Import name -> distribution name, for the famous mismatches. */
const DIST_ALIASES: Record<string, string> = {
  yaml: 'pyyaml', cv2: 'opencv-python', sklearn: 'scikit-learn', PIL: 'pillow', bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil', dotenv: 'python-dotenv', jwt: 'pyjwt', attr: 'attrs', google: 'google', OpenSSL: 'pyopenssl',
  serial: 'pyserial', git: 'gitpython', magic: 'python-magic', jose: 'python-jose', skimage: 'scikit-image',
  MySQLdb: 'mysqlclient', psycopg2: 'psycopg2-binary', Crypto: 'pycryptodome', zmq: 'pyzmq', docx: 'python-docx',
};

const REQ_STRING = /["']\s*([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~^;@][^"']*)?["']/g;

/** pyproject.toml (PEP 621 + Poetry), Pipfile, setup.cfg and setup.py — just enough to list dependencies. */
function parseManifest(text: string, declare: (name: string, kind: DepKind) => void): void {
  let section = '';
  let inArray: DepKind | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[+([^\]]+)\]+\s*$/.exec(line);
    if (header && inArray == null) {
      section = header[1].trim();
      continue;
    }
    let rest = line;
    if (inArray == null) {
      const open = /^\s*["']?([\w.-]+)["']?\s*[=:]\s*[[{(]?(.*)$/.exec(line);
      const key = open?.[1] ?? '';
      if (/^(install_requires|requires)$/.test(key) || (key === 'dependencies' && section === 'project')) {
        inArray = section === 'build-system' ? 'dev' : 'prod';
      } else if (/^(tests_require|setup_requires|extras_require)$/.test(key)) inArray = 'dev';
      else if (open && /^(project\.optional-dependencies|dependency-groups|options\.extras_require)$/.test(section)) inArray = 'dev';
      else if (open && /^(tool\.poetry\.dependencies|packages)$/.test(section)) declare(key, 'prod');
      else if (open && /^(tool\.poetry\.(dev-dependencies|group\..+\.dependencies)|dev-packages)$/.test(section)) declare(key, 'dev');
      else if (section === 'options' && key === 'install_requires') inArray = 'prod';
      if (inArray == null) continue;
      rest = open?.[2] ?? '';
      const setupCall = /(install_requires|tests_require|setup_requires)\s*=\s*\[(.*)$/.exec(line);
      if (setupCall) rest = setupCall[2];
    }
    for (const m of rest.matchAll(REQ_STRING)) declare(m[1], inArray);
    // setup.cfg lists bare requirement lines under `install_requires =`.
    const bare = /^\s+([A-Za-z0-9][\w.-]*)\s*(?:[<>=!~;].*)?$/.exec(rest);
    if (bare && !rest.includes('"') && !rest.includes("'")) declare(bare[1], inArray);
    else if (/^\S/.test(line) && !/[=:]\s*[[{(]?/.test(line)) inArray = null;
    if (/[\])}]\s*,?\s*$/.test(rest.replace(/["'][^"']*["']/g, ''))) inArray = null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');

export function scanPython(source: string): { module: string; names: string[] }[] {
  const src = source
    .replace(/("""|''')[\s\S]*?\1/g, '""')
    .replace(/#.*$/gm, '')
    .replace(/\\\r?\n/g, ' ');
  const out: { module: string; names: string[] }[] = [];
  for (const m of src.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm)) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(mod)) out.push({ module: mod, names: [] });
    }
  }
  for (const m of src.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm)) {
    const names = m[2]
      .replace(/[()]/g, '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => /^\w+$/.test(s));
    if (m[1]) out.push({ module: m[1], names });
  }
  return out;
}

export function createPythonAnalyzer(): LanguageAnalyzer {
  /** top-level module name -> directories that contain it */
  const roots = new Map<string, string[]>();
  const declared = new Map<string, DepKind>();
  let hasManifest = false;

  const moduleFile = (ctx: Ctx, base: string): string | null => {
    for (const c of [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`, `${base}/__init__.pyi`]) if (ctx.hasFile(c)) return c;
    return ctx.hasDir(base) ? base : null; // namespace package
  };

  const resolveAbsolute = (ctx: Ctx, file: FileNode, parts: string[]): { hit: string; used: number } | null => {
    const candidates = roots.get(parts[0]);
    if (!candidates) return null;
    // Prefer the root that is the closest ancestor of the importing file.
    const ordered = [...candidates].sort((a, b) => {
      const aa = a === '' || file.path.startsWith(a + '/');
      const bb = b === '' || file.path.startsWith(b + '/');
      if (aa !== bb) return aa ? -1 : 1;
      return aa ? b.length - a.length : a.length - b.length;
    });
    for (const root of ordered) {
      for (let used = parts.length; used >= 1; used--) {
        const hit = moduleFile(ctx, joinPath(root, parts.slice(0, used).join('/'))!);
        if (hit) return { hit, used };
      }
    }
    return null;
  };

  return {
    name: 'python',
    exts: ['py', 'pyi'],
    async prepare(ctx) {
      for (const f of ctx.files.values()) {
        if (f.ext !== 'py' && f.ext !== 'pyi') continue;
        const dir = dirname(f.path);
        const add = (name: string, root: string) => {
          const list = roots.get(name) ?? [];
          if (!list.includes(root)) list.push(root);
          roots.set(name, list);
        };
        if (f.name !== '__init__.py') add(f.name.replace(/\.pyi?$/, ''), dir);
        // Every ancestor directory is a candidate package living in *its* parent.
        let d = dir;
        while (d) {
          add(d.slice(d.lastIndexOf('/') + 1), dirname(d));
          d = dirname(d);
        }
      }
      const declare = (name: string, kind: DepKind) => {
        const key = norm(name);
        if (key && key !== 'python' && !declared.has(key)) declared.set(key, kind);
      };
      for (const f of ctx.files.values()) {
        if (/^requirements.*\.(txt|in)$/.test(f.name) || (f.ext === 'txt' && /(^|\/)requirements\//.test(f.path))) {
          hasManifest = true;
          const kind: DepKind = /dev|test|lint|doc/i.test(f.path) ? 'dev' : 'prod';
          for (const line of ((await ctx.readText(f.path)) ?? '').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z0-9][\w.-]*)/.exec(line);
            if (m && !line.trim().startsWith('-')) declare(m[1], kind);
          }
        } else if (f.name === 'pyproject.toml' || f.name === 'Pipfile' || f.name === 'setup.cfg' || f.name === 'setup.py') {
          hasManifest = true;
          parseManifest((await ctx.readText(f.path)) ?? '', declare);
        }
      }
    },
    analyze(file, source, ctx) {
      const dir = dirname(file.path);
      for (const { module, names } of scanPython(source)) {
        const dots = /^\.*/.exec(module)![0].length;
        const parts = module.slice(dots).split('.').filter(Boolean);
        if (dots) {
          let base: string | null = dir;
          for (let i = 1; i < dots && base != null; i++) base = base === '' ? null : dirname(base);
          if (base == null) {
            ctx.miss(file, module);
            continue;
          }
          const pkgPath = joinPath(base, parts.join('/'))!;
          let linked = false;
          for (const n of names) {
            const sub = moduleFile(ctx, pkgPath ? `${pkgPath}/${n}` : n);
            if (sub && ctx.files.has(sub)) linked = ctx.link(file, sub, 'import') || linked;
          }
          if (!linked) {
            const hit = moduleFile(ctx, pkgPath);
            if (!hit || !ctx.link(file, hit, 'import')) ctx.miss(file, module);
          }
          continue;
        }
        const res = resolveAbsolute(ctx, file, parts);
        if (res) {
          let linked = false;
          if (res.used === parts.length && ctx.hasDir(res.hit.replace(/\/__init__\.pyi?$/, ''))) {
            const pkgDir = res.hit.replace(/\/__init__\.pyi?$/, '');
            for (const n of names) {
              const sub = moduleFile(ctx, `${pkgDir}/${n}`);
              if (sub && ctx.files.has(sub)) linked = ctx.link(file, sub, 'import') || linked;
            }
          }
          if (!linked) ctx.link(file, res.hit, 'import');
          continue;
        }
        const top = parts[0];
        if (STDLIB.has(top)) ctx.external(file, top, 'pypi', 'builtin');
        else {
          const dist = DIST_ALIASES[top] ?? top;
          const kind = declared.get(norm(dist)) ?? declared.get(norm(top)) ?? (hasManifest ? 'unlisted' : 'prod');
          ctx.external(file, top, 'pypi', kind);
        }
      }
    },
    finish(ctx) {
      if (ctx.options.includeUnusedDeps === false) return;
      const used = new Set([...ctx.externals.values()].filter((e) => e.ecosystem === 'pypi').map((e) => norm(DIST_ALIASES[e.name] ?? e.name)));
      for (const [name, kind] of declared) if (!used.has(name)) ctx.external(null, name, 'pypi', kind);
    },
  };
}

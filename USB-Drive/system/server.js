#!/usr/bin/env node
/* ===========================================================================
   SUN TECH UNLIMITED — GAME GRID
   Local launcher server.  Serves the shell UI and every student game from a
   single http://localhost origin, which is what makes the "Esc back to menu"
   handler work from inside a running game (same-origin iframe access).

   No dependencies. Node 16+.
   =========================================================================== */
'use strict';

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const url  = require('url');
const { execFile, spawn } = require('child_process');

const SYSTEM_DIR = __dirname;                              // .../system
const ROOT_DIR   = path.resolve(SYSTEM_DIR, '..');         // USB root
const UI_DIR     = path.join(SYSTEM_DIR, 'ui');
const GAMES_DIR  = path.join(ROOT_DIR, 'games');
const MANIFEST   = path.join(GAMES_DIR, 'games.json');

const PORT_START = 7331;
const PORT_TRIES = 25;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8'
};

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/* "grid-runner/index.html" -> "Grid Runner", not "Index": when the file is the
   folder's index, the folder name is what the student actually named the game. */
function prettify(relPath) {
  const parts = String(relPath).split(/[\\/]/).filter(Boolean);
  let name = parts.pop() || '';
  const bare = path.basename(name, path.extname(name));
  if (/^index$/i.test(bare) && parts.length) name = parts.pop();

  return path.basename(name, path.extname(name))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
}

/** Reject anything that would escape the directory we mean to serve. */
function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.sep + rel.replace(/^[\\/]+/, ''));
  const baseR  = path.resolve(base) + path.sep;
  if (target !== path.resolve(base) && !target.startsWith(baseR)) return null;
  return target;
}

function walkHtml(dir, base, depth, acc) {
  if (depth > 4) return acc;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (e.isDirectory()) walkHtml(abs, base, depth + 1, acc);
    else if (/\.html?$/i.test(e.name)) acc.push(rel);
  }
  return acc;
}

/* --------------------------------------------------------------------------
   Manifest: read games.json, validate, and fold in anything not listed
   -------------------------------------------------------------------------- */

function readManifest() {
  const problems = [];
  let raw = null, data = null;

  if (!fs.existsSync(GAMES_DIR)) {
    try { fs.mkdirSync(GAMES_DIR, { recursive: true }); } catch {}
  }

  if (fs.existsSync(MANIFEST)) {
    try { raw = fs.readFileSync(MANIFEST, 'utf8'); }
    catch (e) { problems.push({ level: 'error', where: 'games.json', message: 'Could not read the file. ' + e.message }); }
  } else {
    problems.push({ level: 'info', where: 'games.json', message: 'No manifest yet — every HTML file in the games folder is being listed automatically.' });
  }

  if (raw !== null) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // Turn a JSON parse error into something a 10th grader can act on.
      const m = /position (\d+)/.exec(e.message);
      let hint = e.message;
      if (m) {
        const pos = Number(m[1]);
        const line = raw.slice(0, pos).split('\n').length;
        const col  = pos - raw.lastIndexOf('\n', pos - 1);
        hint = `Line ${line}, character ${col}. ${e.message.replace(/ in JSON at position \d+/, '')}`;
        const before = raw.slice(Math.max(0, pos - 40), pos);
        if (/,\s*$/.test(before)) hint += ' — this usually means an extra comma before a } or ].';
      }
      problems.push({ level: 'error', where: 'games.json', message: hint });
    }
  }

  let list = [];
  if (data) {
    const arr = Array.isArray(data) ? data : data.games;
    if (!Array.isArray(arr)) {
      problems.push({ level: 'error', where: 'games.json', message: 'Expected a "games" array at the top level.' });
    } else {
      arr.forEach((g, i) => {
        if (!g || typeof g !== 'object') {
          problems.push({ level: 'error', where: `games[${i}]`, message: 'Entry is not an object.' });
          return;
        }
        const label = g.title || g.name || `entry ${i + 1}`;
        const rel = g.path || g.file || g.entry;
        if (!rel) {
          problems.push({ level: 'error', where: label, message: 'Missing "path" — the HTML file to launch, relative to games.json.' });
          return;
        }
        const abs = safeJoin(GAMES_DIR, rel);
        const exists = abs && fs.existsSync(abs) && fs.statSync(abs).isFile();
        if (!exists) {
          problems.push({ level: 'error', where: label, message: `Can't find "${rel}" inside the games folder.` });
        }
        let preview = null;
        if (g.preview || g.image || g.cover) {
          const pr = g.preview || g.image || g.cover;
          const pabs = safeJoin(GAMES_DIR, pr);
          if (pabs && fs.existsSync(pabs)) preview = pr.replace(/^[\\/]+/, '').split(path.sep).join('/');
          else problems.push({ level: 'warn', where: label, message: `Preview image "${pr}" was not found — showing the fallback tile instead.` });
        }
        list.push({
          id: g.id || slugify(g.title || rel),
          title: g.title || g.name || prettify(rel),
          author: g.author || g.by || '',
          description: g.description || g.blurb || '',
          controls: g.controls || '',
          tags: Array.isArray(g.tags) ? g.tags.slice(0, 4) : [],
          preview,
          path: rel.replace(/^[\\/]+/, '').split(path.sep).join('/'),
          featured: !!g.featured,
          listed: true,
          missing: !exists
        });
      });
    }
  }

  // Anything on disk that nobody listed still shows up, so a drop-in never vanishes.
  const claimed = new Set(list.map(g => g.path.toLowerCase()));
  for (const rel of walkHtml(GAMES_DIR, GAMES_DIR, 0, [])) {
    if (claimed.has(rel.toLowerCase())) continue;
    if (/(^|\/)_/.test(rel)) continue;
    list.push({
      id: slugify(rel),
      title: prettify(rel),
      author: '', description: '', controls: '', tags: [],
      preview: null, path: rel, featured: false, listed: false, missing: false
    });
  }

  list.sort((a, b) => (b.featured - a.featured) || a.title.localeCompare(b.title));
  return { games: list, problems };
}

/* --------------------------------------------------------------------------
   Writing back to the manifest (the "Add a Game" form)
   -------------------------------------------------------------------------- */

function writeManifestEntry(entry) {
  let doc = { club: 'SUN Tech Unlimited', games: [] };
  if (fs.existsSync(MANIFEST)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      if (Array.isArray(parsed)) doc.games = parsed;
      else if (parsed && Array.isArray(parsed.games)) doc = parsed;
    } catch (e) {
      const backup = MANIFEST.replace(/\.json$/, `.broken-${Date.now()}.json`);
      fs.copyFileSync(MANIFEST, backup);
      throw new Error('games.json could not be parsed, so nothing was changed. A copy was saved as ' + path.basename(backup) + '. Fix the file, or delete it and add your games again.');
    }
  }
  const i = doc.games.findIndex(g => (g.path || g.file || g.entry) === entry.path);
  if (i >= 0) doc.games[i] = { ...doc.games[i], ...entry };
  else doc.games.push(entry);

  fs.writeFileSync(MANIFEST, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

function savePreview(dataUrl, gamePath) {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) throw new Error('That image is larger than 4 MB. Try a smaller one.');
  const dir = path.dirname(path.join(GAMES_DIR, gamePath));
  const base = slugify(path.basename(gamePath, path.extname(gamePath))) + '-cover.' + ext;
  const target = safeJoin(GAMES_DIR, path.relative(GAMES_DIR, path.join(dir, base)));
  if (!target) throw new Error('That location is outside the games folder.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buf);
  return path.relative(GAMES_DIR, target).split(path.sep).join('/');
}

/* --------------------------------------------------------------------------
   HTTP
   -------------------------------------------------------------------------- */

function send(res, code, body, type, extra) {
  const headers = Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {});
  res.writeHead(code, headers);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

/* Reading off a USB stick is slow, so let the browser keep what it already has.
   The shell's own assets never change while the Grid is running, so they get a
   real max-age. A student's game might change under us, so those revalidate —
   but an unchanged file costs a 304 and no disk read at all. */
function sendFile(res, abs, req, policy) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');

    const etag     = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const modified = st.mtime.toUTCString();

    const inm = req && req.headers['if-none-match'];
    const ims = req && req.headers['if-modified-since'];
    if ((inm && inm === etag) || (!inm && ims && ims === modified)) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': policy || 'no-cache' });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': policy || 'no-cache',
      'ETag': etag,
      'Last-Modified': modified,
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(abs).pipe(res);
  });
}

/* The shell's assets revalidate too. A max-age here is not just a small win: the
   browser profile outlives the Grid (it sits in the temp folder), so an update
   to the stylesheet or app.js kept being ignored for up to a day, and a fixed
   build kept running the old, slow one. A 304 is cheap and skips the disk read. */
const UI_CACHE    = 'no-cache';
/* Games revalidate, so a student's edit still shows up on the next launch. */
const GAME_CACHE  = 'no-cache';

function readBody(req, limit, cb) {
  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > limit) { req.destroy(); return cb(new Error('Upload too large.')); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', e => cb(e));
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); }
  catch { return send(res, 400, 'Bad request'); }

  // ---- API -----------------------------------------------------------------
  if (pathname === '/api/games') {
    return sendJson(res, 200, readManifest());
  }

  if (pathname === '/api/games' && req.method === 'POST') { /* handled below */ }

  if (pathname === '/api/add' && req.method === 'POST') {
    return readBody(req, 6 * 1024 * 1024, (err, body) => {
      if (err) return sendJson(res, 413, { ok: false, error: err.message });
      let input;
      try { input = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'Could not read the form data.' }); }

      const rel = String(input.path || '').replace(/^[\\/]+/, '');
      if (!rel) return sendJson(res, 400, { ok: false, error: 'Pick the HTML file that starts your game.' });
      const abs = safeJoin(GAMES_DIR, rel);
      if (!abs || !fs.existsSync(abs)) return sendJson(res, 400, { ok: false, error: `Can't find "${rel}" inside the games folder.` });

      try {
        let preview = input.previewPath || null;
        if (input.previewData) preview = savePreview(input.previewData, rel);
        const entry = {
          id: slugify(input.title || rel),
          title: String(input.title || prettify(rel)).slice(0, 80),
          author: String(input.author || '').slice(0, 60),
          description: String(input.description || '').slice(0, 400),
          controls: String(input.controls || '').slice(0, 80),
          tags: String(input.tags || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4),
          path: rel
        };
        if (preview) entry.preview = preview;
        writeManifestEntry(entry);
        return sendJson(res, 200, { ok: true, entry });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    });
  }

  if (pathname === '/api/candidates') {
    // Every HTML file on disk, so the form can offer a picker instead of a text box.
    return sendJson(res, 200, { files: walkHtml(GAMES_DIR, GAMES_DIR, 0, []) });
  }

  if (pathname === '/api/quit') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 200);
    return;
  }

  // ---- Games ---------------------------------------------------------------
  if (pathname.startsWith('/games/')) {
    const abs = safeJoin(GAMES_DIR, pathname.slice('/games/'.length));
    if (!abs) return send(res, 403, 'Forbidden');
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (fs.existsSync(idx)) return sendFile(res, idx, req, GAME_CACHE);
      return send(res, 404, 'Not found');
    }
    return sendFile(res, abs, req, GAME_CACHE);
  }

  // ---- Shell UI ------------------------------------------------------------
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(UI_DIR, 'index.html'), req, 'no-cache');
  }
  const uiAbs = safeJoin(UI_DIR, pathname);
  if (uiAbs && fs.existsSync(uiAbs) && fs.statSync(uiAbs).isFile()) {
    return sendFile(res, uiAbs, req, UI_CACHE);
  }

  send(res, 404, 'Not found');
});

/* --------------------------------------------------------------------------
   Boot: find a free port, then open a chromeless browser window
   -------------------------------------------------------------------------- */

function listen(port, attempt) {
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && attempt < PORT_TRIES) return listen(port + 1, attempt + 1);
    console.error('\n  Could not start the server: ' + err.message + '\n');
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => onReady(port));
}

const CHROME_PATHS = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium']
};

/* Chrome's profile directory MUST live on local disk, never on the drive this
   script is running from.

   A fresh Chrome profile is tens of megabytes spread over thousands of tiny
   files — LevelDB stores, Code Cache, Service Worker directories — and USB
   flash has dreadful random-write throughput. Putting the profile on the stick
   leaves the player staring at a black window for minutes while Chrome builds
   it, and then does the whole thing again on the next machine.

   Local temp fixes both halves: the first launch on a computer takes a couple
   of seconds, and every launch after that reuses the profile and is instant. */
function profileDir() {
  const base = path.join(os.tmpdir(), 'suntech-game-grid');
  try {
    fs.mkdirSync(path.join(base, 'profile'), { recursive: true });
    fs.mkdirSync(path.join(base, 'cache'), { recursive: true });
    return base;
  } catch {
    return null;   // no writable temp — fall back to the default browser
  }
}

function openWindow(target) {
  const list = CHROME_PATHS[process.platform] || [];
  const exe = list.find(p => { try { return p && fs.existsSync(p); } catch { return false; } });
  const base = exe ? profileDir() : null;

  if (exe && base && !process.env.SUNTECH_NO_APP_MODE) {
    const child = spawn(exe, [
      `--app=${target}`,
      `--user-data-dir=${path.join(base, 'profile')}`,
      `--disk-cache-dir=${path.join(base, 'cache')}`,
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      /* Everything below stops Chrome phoning home on a cold profile. On a
         school network behind a filtering proxy those requests hang rather
         than fail, which is the other way this window ends up black. */
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--disable-default-apps',
      '--no-service-autorun',
      '--disable-features=Translate,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion,InterestFeedContentSuggestions',
      /* Escape hatch for a machine that needs to tune the browser, such as
         scripts/pi-game-mode.sh asking for fullscreen. Space-separated. */
      ...(process.env.SUNTECH_CHROME_FLAGS || '').split(/\s+/).filter(Boolean)
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return 'app';
  }

  // Fall back to whatever the machine calls its default browser.
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', target], () => {});
  else if (process.platform === 'darwin') execFile('open', [target], () => {});
  else execFile('xdg-open', [target], () => {});
  return 'default';
}

function onReady(port) {
  const target = `http://localhost:${port}/`;
  const { games, problems } = readManifest();
  const errs = problems.filter(p => p.level === 'error').length;

  console.log('');
  console.log('   SUN TECH UNLIMITED  ///  GAME GRID');
  console.log('   ' + '-'.repeat(46));
  console.log('   Games folder : ' + GAMES_DIR);
  console.log('   Games found  : ' + games.length + (errs ? `   (${errs} manifest problem${errs > 1 ? 's' : ''} — see the menu)` : ''));
  console.log('   Address      : ' + target);
  console.log('');

  if (process.env.SUNTECH_NO_OPEN) {
    console.log('   Browser launch skipped (SUNTECH_NO_OPEN).');
  } else {
    const how = openWindow(target);
    if (how === 'app') {
      console.log('   Opened in a clean app window.');
      console.log('   (First run on a computer takes a few seconds while the');
      console.log('    browser profile is built in that computer\'s temp folder.');
      console.log('    Every run after that on the same machine is instant.)');
    } else {
      console.log('   Chrome or Edge was not found — opened in your default browser.');
    }
  }
  console.log('   Close this black window to shut the Game Grid down.');
  console.log('');
}

listen(Number(process.env.PORT) || PORT_START, 0);

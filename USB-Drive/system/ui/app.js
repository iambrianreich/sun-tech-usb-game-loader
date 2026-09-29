/* ===========================================================================
   SUN TECH UNLIMITED — GAME GRID  ·  shell logic
   =========================================================================== */
(() => {
'use strict';

const $  = id => document.getElementById(id);
const html = document.documentElement;

const el = {
  boot: $('boot'), bootStatus: $('bootStatus'),
  ribbonLabel: $('ribbonLabel'), ribbonHint: $('ribbonHint'),
  btnAdd: $('btnAdd'), btnMenu: $('btnMenu'), brandHome: $('brandHome'),
  list: $('list'), alerts: $('alerts'), empty: $('empty'), emptyAdd: $('emptyAdd'),
  dropnote: $('dropnote'),
  gameCount: $('gameCount'),
  detailArt: $('detailArt'), detailImg: $('detailImg'), detailInitial: $('detailInitial'),
  detailTags: $('detailTags'), detailTitle: $('detailTitle'),
  detailAuthor: $('detailAuthor'), detailDesc: $('detailDesc'),
  specControls: $('specControls'), specFile: $('specFile'),
  btnPlay: $('btnPlay'),
  stage: $('stage'), play: $('play'), frame: $('frame'), playLoading: $('playLoading'),
  add: $('add'), addForm: $('addForm'), addError: $('addError'),
  addCancel: $('addCancel'), addSubmit: $('addSubmit'),
  fPath: $('fPath'), fTitle: $('fTitle'), fAuthor: $('fAuthor'), fDesc: $('fDesc'),
  btnQuit: $('btnQuit'), quit: $('quit'), quitText: $('quitText'), quitYes: $('quitYes'), quitNo: $('quitNo'),
  fControls: $('fControls'), fTags: $('fTags'), fPreview: $('fPreview'),
  drop: $('drop'), dropPreview: $('dropPreview'), dropLabel: $('dropLabel')
};

let games = [], index = 0, view = 'boot', previewData = null;

/* ---------------------------------------------------------------- helpers */
const setView = v => { view = v; html.dataset.view = v; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* ---------------------------------------------------------------- loading */
async function loadGames() {
  const res  = await fetch('/api/games', { cache: 'no-store' });
  const data = await res.json();
  games = data.games || [];
  renderAlerts(data.problems || []);
  renderList();
  if (games.length) select(Math.min(index, games.length - 1));
}

function renderAlerts(problems) {
  const shown = problems.filter(p => p.level !== 'info' || !games.length);
  el.alerts.innerHTML = shown.map(p => `
    <div class="alert" data-level="${esc(p.level)}">
      <b>${p.level === 'error' ? 'Error' : p.level === 'warn' ? 'Check' : 'Note'}</b>
      <span><strong>${esc(p.where)}</strong> — ${esc(p.message)}</span>
    </div>`).join('');
}

function renderList() {
  const has = games.length > 0;
  el.empty.hidden = has;
  el.list.hidden = !has;
  el.dropnote.hidden = !has;
  el.gameCount.textContent = has ? String(games.length).padStart(2, '0') + ' available' : '';

  el.list.innerHTML = games.map((g, i) => {
    let flag = '';
    if (g.missing)      flag = '<span class="row__flag" data-kind="missing">file missing</span>';
    else if (!g.listed) flag = '<span class="row__flag" data-kind="unlisted">not listed</span>';
    return `<li class="row" role="option" data-i="${i}" aria-selected="false">
      <span class="row__num">${String(i + 1).padStart(2, '0')}</span>
      <span class="row__text">
        <span class="row__title">${esc(g.title)}</span>
        ${g.author ? `<span class="row__by">by ${esc(g.author)}</span>` : ''}
      </span>
      ${flag}
    </li>`;
  }).join('');

  el.list.querySelectorAll('.row').forEach(row => {
    const i = Number(row.dataset.i);
    row.addEventListener('mouseenter', () => select(i));
    row.addEventListener('click', () => { select(i); launch(games[i]); });
  });
}

function select(i) {
  if (!games.length) return;
  index = (i + games.length) % games.length;
  const g = games[index];

  el.list.querySelectorAll('.row').forEach(r =>
    r.setAttribute('aria-selected', Number(r.dataset.i) === index ? 'true' : 'false'));
  const row = el.list.querySelector(`.row[data-i="${index}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });

  el.detailTitle.textContent = g.title;
  el.detailInitial.textContent = (g.title[0] || '∞').toUpperCase();
  el.detailAuthor.textContent = g.author ? 'by ' + g.author : '';
  el.detailAuthor.hidden = !g.author;
  el.detailDesc.textContent = g.description ||
    (g.listed ? '' : 'This game was found in the games folder but has no entry in games.json yet. It still plays — adding an entry gives it a proper title, cover, and credit.');
  el.detailTags.innerHTML = (g.tags || []).map(t => `<span>${esc(t)}</span>`).join('');
  el.specControls.textContent = g.controls || 'See the game';
  el.specFile.textContent = g.path;
  el.specFile.title = g.path;

  if (g.preview) {
    el.detailImg.src = '/games/' + g.preview.split('/').map(encodeURIComponent).join('/');
    el.detailImg.hidden = false;
  } else {
    el.detailImg.hidden = true;
    el.detailImg.removeAttribute('src');
  }

  el.btnPlay.disabled = !!g.missing;
  el.btnPlay.style.opacity = g.missing ? .4 : 1;
}

/* ---------------------------------------------------------------- playing */
function launch(g) {
  if (!g || g.missing) return;
  setView('play');
  el.btnMenu.hidden = false;
  el.btnAdd.hidden = true;
  el.ribbonLabel.textContent = g.title;
  /* The Back button already carries Esc, so spend this space on something
     the player actually needs mid-game: how to control the thing. */
  el.ribbonHint.textContent = g.controls || '';
  el.playLoading.hidden = false;
  el.play.hidden = false;
  el.frame.src = '/games/' + g.path.split('/').map(encodeURIComponent).join('/');
}

/* Same-origin means we can keep the escape hatch alive even once the game
   has taken keyboard focus. Without the local server this would be impossible. */
el.frame.addEventListener('load', () => {
  el.playLoading.hidden = true;

  /* Blanking the frame on the way out also fires load. Focusing it there
     would steal the keyboard from the menu and leave the list dead. */
  const src = el.frame.getAttribute('src');
  if (view !== 'play' || !src || src === 'about:blank') return;

  try {
    const w = el.frame.contentWindow;
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toMenu(); }
    };
    w.addEventListener('keydown', onKey, true);
    w.document.addEventListener('keydown', onKey, true);
    w.focus();
    if (w.document.body) w.document.body.focus?.();
  } catch (err) {
    /* A game that navigates off-origin loses Esc — the ribbon button still works. */
    el.ribbonHint.textContent = 'Use “Back to grid” to return';
  }
});

function toMenu() {
  setView('menu');                    // set first, so the frame's load handler stands down
  el.frame.src = 'about:blank';
  el.play.hidden = true;
  el.btnMenu.hidden = true;
  el.btnAdd.hidden = false;
  el.ribbonLabel.textContent = 'Game Grid';
  el.ribbonHint.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> select <kbd>Enter</kbd> play';
  el.list.focus();
  /* Belt and braces: the frame can grab focus a tick later as it blanks. */
  setTimeout(() => { if (view === 'menu') el.list.focus(); }, 60);
}

/* If focus ever ends up somewhere dead, clicking anywhere in the menu
   hands it back to the list so the arrow keys keep working. */
el.stage.addEventListener('mousedown', () => {
  if (view === 'menu') setTimeout(() => el.list.focus(), 0);
});

/* ---------------------------------------------------------------- add form */
async function openAdd() {
  setView('add');
  el.add.hidden = false;
  el.btnAdd.hidden = true;
  el.btnMenu.hidden = false;
  el.ribbonLabel.textContent = 'Add a game';
  el.ribbonHint.textContent = '';
  el.addError.hidden = true;
  try {
    const r = await fetch('/api/candidates', { cache: 'no-store' });
    const { files } = await r.json();
    const known = new Set(games.filter(g => g.listed).map(g => g.path));
    el.fPath.innerHTML = '<option value="" disabled selected>Choose a file…</option>' +
      files.map(f => `<option value="${esc(f)}"${known.has(f) ? '' : ''}>${esc(f)}${known.has(f) ? '  (already listed — this will update it)' : ''}</option>`).join('');
    if (!files.length) el.fPath.innerHTML = '<option value="" disabled selected>No HTML files found in the games folder</option>';
  } catch { el.fPath.innerHTML = '<option value="" disabled selected>Could not read the games folder</option>'; }
  setTimeout(() => el.fPath.focus(), 60);
}

function closeAdd() {
  el.add.hidden = true;
  el.btnAdd.hidden = false;
  el.btnMenu.hidden = true;
  el.ribbonLabel.textContent = 'Game Grid';
  el.ribbonHint.innerHTML = '<kbd>↑</kbd><kbd>↓</kbd> select <kbd>Enter</kbd> play';
  setView('menu');
  el.list.focus();
}

el.fPath.addEventListener('change', () => {
  if (el.fTitle.value.trim()) return;
  const base = el.fPath.value.split('/').pop().replace(/\.html?$/i, '');
  el.fTitle.value = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
});

function readImage(file) {
  if (!file || !/^image\//.test(file.type)) return;
  if (file.size > 4 * 1024 * 1024) {
    el.addError.textContent = 'That image is larger than 4 MB. Try a smaller one.';
    el.addError.hidden = false; return;
  }
  const fr = new FileReader();
  fr.onload = () => {
    previewData = fr.result;
    el.dropPreview.src = previewData;
    el.dropPreview.hidden = false;
    el.dropLabel.textContent = file.name;
  };
  fr.readAsDataURL(file);
}
el.fPreview.addEventListener('change', e => readImage(e.target.files[0]));
['dragenter', 'dragover'].forEach(t => el.drop.addEventListener(t, e => { e.preventDefault(); el.drop.dataset.over = '1'; }));
['dragleave', 'drop'].forEach(t => el.drop.addEventListener(t, e => { e.preventDefault(); el.drop.dataset.over = '0'; }));
el.drop.addEventListener('drop', e => readImage(e.dataTransfer.files[0]));

el.addForm.addEventListener('submit', async e => {
  e.preventDefault();
  el.addError.hidden = true;
  if (!el.fPath.value) {
    el.addError.textContent = 'Pick the HTML file that starts your game.';
    el.addError.hidden = false; return;
  }
  el.addSubmit.disabled = true;
  el.addSubmit.textContent = 'Adding…';
  try {
    const r = await fetch('/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: el.fPath.value,
        title: el.fTitle.value,
        author: el.fAuthor.value,
        description: el.fDesc.value,
        controls: el.fControls.value,
        tags: el.fTags.value,
        previewData
      })
    });
    const out = await r.json();
    if (!out.ok) throw new Error(out.error || 'Something went wrong.');
    el.addForm.reset();
    previewData = null;
    el.dropPreview.hidden = true;
    el.dropLabel.textContent = 'Drop an image here, or click to choose one';
    await loadGames();
    const i = games.findIndex(g => g.path === out.entry.path);
    if (i >= 0) index = i;
    closeAdd();
    select(index);
  } catch (err) {
    el.addError.textContent = err.message;
    el.addError.hidden = false;
  } finally {
    el.addSubmit.disabled = false;
    el.addSubmit.textContent = 'Add to the grid';
  }
});

/* ---------------------------------------------------------------- quit
   Leaving is a deliberate two-step (ask, then confirm) because Enter also
   launches games. The dialog opens on "Stay", so a stray Enter is harmless. */
function openQuit() {
  if (view !== 'menu') return;
  setView('quit');
  el.quit.hidden = false;
  el.quitYes.disabled = el.quitNo.disabled = false;
  el.quitText.textContent = 'This closes the Grid and returns to the desktop.';
  el.quitNo.focus();
}

function closeQuit() {
  el.quit.hidden = true;
  setView('menu');
  el.list.focus();
}

async function doQuit() {
  el.quitYes.disabled = el.quitNo.disabled = true;
  el.quitText.textContent = 'Closing the Game Grid…';
  try { await fetch('/api/quit', { method: 'POST' }); }
  catch { /* the server may drop the connection as it exits */ }
  /* The window normally disappears with the server. If we are still here,
     something is holding it open, so say so instead of hanging silently. */
  setTimeout(() => {
    el.quitText.textContent = 'The Grid has stopped. You can close this window.';
  }, 4000);
}

el.btnQuit.addEventListener('click', openQuit);
el.quitNo.addEventListener('click', closeQuit);
el.quitYes.addEventListener('click', doQuit);

/* ---------------------------------------------------------------- keyboard */
document.addEventListener('keydown', e => {
  if (view === 'boot') { finishBoot(); return; }

  if (view === 'add') {
    if (e.key === 'Escape') { e.preventDefault(); closeAdd(); }
    return;
  }

  if (view === 'play') {
    if (e.key === 'Escape') { e.preventDefault(); toMenu(); }
    return;
  }

  if (view === 'quit') {
    /* Enter and Space are left alone: they press whichever button has focus. */
    if (e.key === 'Escape' || e.key === 'n' || e.key === 'N') { e.preventDefault(); closeQuit(); }
    else if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); doQuit(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      (document.activeElement === el.quitNo ? el.quitYes : el.quitNo).focus();
    }
    return;
  }

  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

  switch (e.key) {
    case 'ArrowDown': case 's': case 'S': e.preventDefault(); select(index + 1); break;
    case 'ArrowUp':   case 'w': case 'W': e.preventDefault(); select(index - 1); break;
    case 'Home':      e.preventDefault(); select(0); break;
    case 'End':       e.preventDefault(); select(games.length - 1); break;
    case 'PageDown':  e.preventDefault(); select(index + 5); break;
    case 'PageUp':    e.preventDefault(); select(index - 5); break;
    case 'Enter': case ' ': e.preventDefault(); launch(games[index]); break;
    case 'r': case 'R': e.preventDefault(); refresh(); break;
    case 'a': case 'A': e.preventDefault(); openAdd(); break;
    case 'q': case 'Q': e.preventDefault(); openQuit(); break;
  }
});

/* ---------------------------------------------------------------- gamepad
   Games only listen for the keyboard, so the pad is translated here: in the
   menus it drives the same actions as the keys above, and while playing it
   sends synthetic key events into the (same-origin) game frame. Every game,
   including ones added later, gets pad support without being touched.

   Uses the browser's "standard" mapping: 0 A, 1 B, 2 X, 3 Y, 8 Back, 9 Start,
   12-15 D-pad. Browsers hide the pad until its first button press. */
const PAD_STICK_DEADZONE = 0.5;
const PAD_REPEAT_FIRST_MS = 350;
const PAD_REPEAT_MS = 120;
const PAD_GAME_KEYS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

let padPrev = {};
let padHeld = new Set();       // keys currently held down inside the game frame
let padRepeatAt = {};

function readPads() {
  const s = { up: false, down: false, left: false, right: false, a: false, b: false, x: false, y: false, back: false, start: false };
  for (const p of (navigator.getGamepads ? navigator.getGamepads() : [])) {
    if (!p || !p.connected) continue;
    const b = i => !!(p.buttons[i] && p.buttons[i].pressed);
    const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
    s.up    ||= b(12) || ay < -PAD_STICK_DEADZONE;
    s.down  ||= b(13) || ay >  PAD_STICK_DEADZONE;
    s.left  ||= b(14) || ax < -PAD_STICK_DEADZONE;
    s.right ||= b(15) || ax >  PAD_STICK_DEADZONE;
    s.a ||= b(0); s.b ||= b(1); s.x ||= b(2); s.y ||= b(3);
    s.back ||= b(8); s.start ||= b(9);
  }
  return s;
}

function padKey(type, key) {
  try {
    const w = el.frame.contentWindow;
    w.document.dispatchEvent(new w.KeyboardEvent(type, { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true }));
  } catch { /* frame navigated off-origin: nothing to drive */ }
}

function padSetHeld(key, down) {
  if (down === padHeld.has(key)) return;
  down ? padHeld.add(key) : padHeld.delete(key);
  padKey(down ? 'keydown' : 'keyup', key);
}

function padReleaseAll() {
  for (const k of padHeld) padKey('keyup', k);
  padHeld.clear();
}

/* True on the press, then again on a steady beat while held. */
function padPulse(name, now, s) {
  if (!s[name]) { delete padRepeatAt[name]; return false; }
  if (!padPrev[name]) { padRepeatAt[name] = now + PAD_REPEAT_FIRST_MS; return true; }
  if (now >= padRepeatAt[name]) { padRepeatAt[name] = now + PAD_REPEAT_MS; return true; }
  return false;
}

function padTick(now) {
  requestAnimationFrame(padTick);
  const s = readPads();
  const pressed = n => s[n] && !padPrev[n];

  if (view === 'play') {
    for (const d of Object.keys(PAD_GAME_KEYS)) padSetHeld(PAD_GAME_KEYS[d], s[d]);
    padSetHeld(' ', s.a);
    padSetHeld('Enter', s.x);
    if (pressed('start') || pressed('back')) { padReleaseAll(); toMenu(); }
  } else {
    if (padHeld.size) padReleaseAll();
    if (view === 'boot') {
      if (Object.values(s).some(Boolean) && !Object.values(padPrev).some(Boolean)) finishBoot();
    } else if (view === 'add') {
      if (pressed('b') || pressed('back') || pressed('start')) closeAdd();
    } else if (view === 'menu') {
      if (padPulse('down', now, s)) select(index + 1);
      if (padPulse('up', now, s)) select(index - 1);
      if (pressed('a') || pressed('start')) launch(games[index]);
      if (pressed('x')) openAdd();
      if (pressed('y')) refresh();
      if (pressed('b')) openQuit();
    } else if (view === 'quit') {
      if (pressed('left') || pressed('right') || pressed('up') || pressed('down')) {
        (document.activeElement === el.quitNo ? el.quitYes : el.quitNo).focus();
      }
      if (pressed('a')) document.activeElement?.click();
      if (pressed('b')) closeQuit();
    }
  }
  padPrev = s;
}
requestAnimationFrame(padTick);

async function refresh() {
  el.gameCount.textContent = 'refreshing…';
  await loadGames();
}

el.btnPlay.addEventListener('click', () => launch(games[index]));
el.btnMenu.addEventListener('click', () => (view === 'add' ? closeAdd() : toMenu()));
el.btnAdd.addEventListener('click', openAdd);
el.emptyAdd.addEventListener('click', openAdd);
el.addCancel.addEventListener('click', closeAdd);
el.brandHome.addEventListener('click', e => { e.preventDefault(); view === 'menu' ? refresh() : toMenu(); });

/* Anything dropped on the window that isn't the form gets a nudge. */
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ---------------------------------------------------------------- boot */
const BOOT_LINES = ['Initializing grid', 'Reading games folder', 'Ready'];
let bootDone = false;

function finishBoot() {
  if (bootDone) return;
  bootDone = true;
  setView('menu');
  setTimeout(() => el.list.focus(), 120);
}

(async function start() {
  let step = 0;
  const tick = setInterval(() => {
    step = Math.min(step + 1, BOOT_LINES.length - 1);
    el.bootStatus.textContent = BOOT_LINES[step];
  }, 460);

  try { await loadGames(); }
  catch (err) {
    el.alerts.innerHTML = `<div class="alert" data-level="error"><b>Error</b>
      <span>The Game Grid could not reach its own server. Close this window and run START again.</span></div>`;
  }

  setTimeout(() => { clearInterval(tick); finishBoot(); }, 1400);
})();

})();

/* Chromebook Checkout — a front-desk loaner kiosk.

   No backend, no database. Every event is appended to a CSV file held in this
   origin's private file system (OPFS) on the device running it. Nothing is
   uploaded anywhere.

   Nothing in this file is specific to any school. Site settings — email domain,
   roster, staff password, asset IDs, colours — are entered in the staff view and
   stored beside the log, never in this bundle. See config.example.json for the
   shape, which the settings form can import and export. */

/* Neutral fallbacks. checkout-config.json overrides any of these. */
const DEFAULT_CONFIG = {
  deviceCount: 10,
  dayEndsAt: '15:30',
  dueOptions: [
    { key: 'eod',      label: 'End of day' },
    { key: 'tomorrow', label: 'Tomorrow' },
    { key: 'week',     label: 'Next week' },
  ],
  allowedEmailDomain: '',
  roster: [],
  requireRoster: false,
  assetIds: {},
  staffPresets: [
    { label: 'End of day', days: 0 },
    { label: '1 week',     days: 7 },
    { label: '2 weeks',    days: 14 },
    { label: '1 month',    days: 30 },
  ],
  // Fallback staff password, used until one is set in the staff view and again
  // if local storage is ever cleared. Deliberately simple: it only ever applies
  // when there is no local data, so there is nothing behind it to protect.
  // Default is the word: frontdesk    (regenerate with tools/make-password.py)
  password: {
    salt: 'c1571fa3ac455c167ef81d3c7c981a86',
    hash: '80692eba14f56ac12f5288fe98c2c8190ca00246afd54588e18d22dc6484ddaf',
    iterations: 200000,
  },
  kioskIdleMs: 45000,
  adminIdleLockMs: 120000,
  // Wording of the confirmation screens. Placeholders in braces are filled in;
  // an unrecognised one is left visible so a typo is obvious rather than blank.
  //   {device} {asset} {email} {due} {duration}
  messages: {
    checkoutTitle: 'Chromebook {device} is yours',
    checkoutBody:  'Please bring it back by {due}.',
    returnTitle:   'Chromebook {device} returned',
    returnBody:    'Thanks — it was out for {duration}.',
  },

  // Any of the -l / -d colour tokens in styles.css may be overridden here.
  theme: {},
};

/* Live settings. Replaced by applyConfig() once the local file is read. */
let CONFIG = structuredClone(DEFAULT_CONFIG);

const CSV_HEADER = ['timestamp','event','device','asset_id','email','due','checked_out_at','minutes_out','note'];
const MIRROR_KEY = 'cbcheckout.csv';
const FILE_NAME  = 'chromebook-checkout.csv';
const CONFIG_FILE = 'checkout-config.json';
const CONFIG_MIRROR = 'cbcheckout.config';

/* ---------------------------------------------------------------- helpers */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const pad = n => String(n).padStart(2, '0');

/** ISO 8601 with the local UTC offset, so spreadsheets read it as a real time. */
function isoLocal(d) {
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
       + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
       + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function atDayEnd(d) {
  const [h, m] = CONFIG.dayEndsAt.split(':').map(Number);
  const x = new Date(d); x.setHours(h, m, 0, 0); return x;
}

/** Push Saturday/Sunday forward to Monday. */
function toWeekday(d) {
  const x = new Date(d);
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() + 1);
  return x;
}

function dueDateFor(key, now = new Date()) {
  let d;
  if (key === 'tomorrow')  d = atDayEnd(addDays(now, 1));
  else if (key === 'week') d = atDayEnd(addDays(now, 7));
  else { // end of day — if we're already past it, mean the next school day
    d = atDayEnd(now);
    if (d <= now) d = atDayEnd(addDays(now, 1));
  }
  return atDayEnd(toWeekday(d));
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function fmtWhen(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (d.toDateString() === addDays(now, 1).toDateString()) return `tomorrow ${time}`;
  if (d.toDateString() === addDays(now, -1).toDateString()) return `yesterday ${time}`;
  return `${DAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

/** Format for a <input type="datetime-local"> value, which is always local time. */
const toLocalInput = d =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Due date for a staff preset: N days out, at the end of the school day. */
const presetDue = (days, now = new Date()) =>
  days === 0 ? dueDateFor('eod', now) : atDayEnd(toWeekday(addDays(now, days)));

/* Written into a folder that has no settings file yet, so there is something
   concrete to edit rather than an empty file. */
const CONFIG_TEMPLATE = {
  _readme: 'Local settings for this kiosk. Never commit this file — it holds '
         + 'your domain, roster and password hash. Edit, then use "Reload settings" '
         + 'in the staff view.',
  deviceCount: 10,
  dayEndsAt: '15:30',
  allowedEmailDomain: '',
  roster: [],
  requireRoster: false,
  assetIds: {},
  password: { salt: '', hash: '', iterations: 200000 },
  messages: {
    checkoutTitle: 'Chromebook {device} is yours',
    checkoutBody:  'Please bring it back by {due}.',
    returnTitle:   'Chromebook {device} returned',
    returnBody:    'Thanks — it was out for {duration}.',
  },
  theme: { light: {}, dark: {} },
};

/**
 * Fill {placeholders} in a configurable message. Unknown names are left as-is,
 * so a mistyped placeholder shows up on screen instead of silently vanishing.
 */
function fillTemplate(tpl, vars) {
  return String(tpl == null ? '' : tpl)
    .replace(/\{(\w+)\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
}

/* ---------------------------------------------------------------- config */

const THEME_TOKENS = ['bg','surface','ink','muted','line','accent','accent-ink',
                      'ok','ok-bg','out','out-bg','bad','bad-bg'];

/** Merge a parsed config file over the neutral defaults. */
function mergeConfig(raw) {
  const o = (raw && typeof raw === 'object') ? raw : {};
  const merged = { ...structuredClone(DEFAULT_CONFIG), ...o };
  // one level of nesting needs merging rather than replacing
  // A locally-set password wins; a blank one falls back to the bundle's, so a
  // wiped store can never leave the staff view unlocked.
  const local = o.password || {};
  merged.password = (local.hash && local.salt)
    ? { iterations: 200000, ...local }
    : { ...DEFAULT_CONFIG.password };
  merged.theme    = { ...(o.theme || {}) };
  // Blank entries fall back to the default wording rather than showing nothing.
  merged.messages = { ...DEFAULT_CONFIG.messages };
  for (const [k, v] of Object.entries(o.messages || {}))
    if (typeof v === 'string' && v.trim()) merged.messages[k] = v;
  merged.assetIds = { ...(o.assetIds || {}) };
  if (!Array.isArray(merged.roster)) merged.roster = [];
  if (!Array.isArray(merged.dueOptions) || !merged.dueOptions.length)
    merged.dueOptions = structuredClone(DEFAULT_CONFIG.dueOptions);
  if (!Array.isArray(merged.staffPresets) || !merged.staffPresets.length)
    merged.staffPresets = structuredClone(DEFAULT_CONFIG.staffPresets);
  return merged;
}

/**
 * theme: { light: {accent: '#334f66', ...}, dark: {...} }
 * Written onto :root as the -l / -d variables the stylesheet reads.
 */
function themeVars(theme) {
  const out = {};
  for (const [mode, sfx] of [['light', 'l'], ['dark', 'd']]) {
    for (const [k, v] of Object.entries((theme && theme[mode]) || {})) {
      if (THEME_TOKENS.includes(k) && /^#[0-9a-f]{3,8}$/i.test(String(v)))
        out[`--${k}-${sfx}`] = String(v);
    }
  }
  return out;
}

/** Push config-dependent bits into the DOM. Safe to call repeatedly. */
function refreshConfigUI() {
  const list = $('#rosterList');
  if (!list) return;
  list.innerHTML = rosterOptions().map(e => `<option value="${e}">`).join('');

  const suffix = $('#coSuffix');
  if (suffixMode()) {
    suffix.textContent = '@' + CONFIG.allowedEmailDomain;
    suffix.hidden = false;
    $('#coEmail').placeholder = 'username';
    $('#coEmailLabel').textContent = 'Your school email address';
  } else {
    suffix.hidden = true;
    $('#coEmail').placeholder = 'you@example.org';
    $('#coEmailLabel').textContent = 'Your school email';
  }
}

function applyConfig(raw) {
  CONFIG = mergeConfig(raw);
  const vars = themeVars(CONFIG.theme);
  const root = document.documentElement;
  for (const t of THEME_TOKENS) {
    root.style.removeProperty(`--${t}-l`);
    root.style.removeProperty(`--${t}-d`);
  }
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);

  // keep the browser chrome in step with the configured surface colour
  const meta = $('meta[name="theme-color"]');
  if (meta && vars['--accent-l']) meta.setAttribute('content', vars['--accent-l']);

  refreshConfigUI();
}

/* ----------------------------------------------------------------- email */

/** True when students only need to type the part before the @. */
const suffixMode = () => Boolean(CONFIG.allowedEmailDomain);

/**
 * Turn whatever was typed into a full address. With allowedEmailDomain set,
 * a bare username gets the domain appended; a full address is left alone so
 * pasting one still works (and still gets domain-checked by validEmail).
 */
function normalizeEmail(raw) {
  const v = (raw || '').trim().toLowerCase();
  if (!v) return '';
  if (suffixMode() && !v.includes('@')) return v + '@' + CONFIG.allowedEmailDomain.toLowerCase();
  return v;
}

/** The roster holds full addresses; autocomplete has to match what they type. */
function rosterOptions() {
  const dom = '@' + CONFIG.allowedEmailDomain.toLowerCase();
  return CONFIG.roster.map(e => {
    const lc = String(e).trim().toLowerCase();
    return suffixMode() && lc.endsWith(dom) ? lc.slice(0, -dom.length) : lc;
  });
}

function validEmail(v, staff = false) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    return (suffixMode() && !staff) ? 'Enter your username, the part before the @.'
                                    : 'Enter a valid email address.';
  }
  // Staff are trusted to loan to a teacher, an aide, or anyone off the roster.
  if (staff) return null;
  if (CONFIG.allowedEmailDomain && !v.endsWith('@' + CONFIG.allowedEmailDomain.toLowerCase()))
    return `Use your @${CONFIG.allowedEmailDomain} address.`;
  if (CONFIG.requireRoster && !CONFIG.roster.some(r => String(r).trim().toLowerCase() === v))
    return 'That address is not on the student list. Please see the front desk.';
  return null;
}

/* ------------------------------------------------------------------- csv */

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"')  { inQ = true; i++; continue; }
    if (c === ',')  { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Bring a log file up to the current column layout. Older files predate the
 * asset_id column; rows are remapped by header name, so nothing is lost and
 * column order changes are survivable. A file that isn't ours is left alone.
 */
function canonicalizeCSV(text) {
  const wanted = CSV_HEADER.join(',');
  const rows = parseCSV(text || '');
  if (!rows.length) return wanted + '\n';

  const hdr = rows[0].map(h => h.trim());
  if (hdr.join(',') === wanted) return text;
  const ix = Object.fromEntries(hdr.map((h, i) => [h, i]));
  if (ix.timestamp == null || ix.event == null) return text;   // not our file

  const out = [wanted];
  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    out.push(CSV_HEADER.map(k => csvEscape(ix[k] != null ? (r[ix[k]] ?? '') : '')).join(','));
  }
  return out.join('\n') + '\n';
}

/** Device numbers sharing an asset ID with another device. */
function duplicateAssets(map) {
  const seen = new Map(), dups = new Set();
  for (const [dev, id] of Object.entries(map)) {
    const v = String(id ?? '').trim().toLowerCase();
    if (!v) continue;
    if (seen.has(v)) { dups.add(seen.get(v)); dups.add(dev); }
    else seen.set(v, dev);
  }
  return [...dups].sort((a, b) => Number(a) - Number(b));
}

/* ------------------------------------------------------------- indexeddb */

function openIDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('cbcheckout', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
async function idbGet(k) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const q = db.transaction('kv', 'readonly').objectStore('kv').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function idbSet(k, v) {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const q = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k);
    q.onsuccess = () => res(); q.onerror = () => rej(q.error);
  });
}

/* ----------------------------------------------------------------- store */

const hasOPFS = Boolean(navigator.storage && navigator.storage.getDirectory);

const Store = {
  root: null,             // OPFS root directory
  csv: null,              // file handle for the log
  cfg: null,              // file handle for the settings
  text: '',
  mode: 'local',          // 'opfs' once the private file system is open
  configText: '',
  persisted: null,        // result of navigator.storage.persisted()
  _queue: Promise.resolve(),

  /**
   * Open the origin private file system. No picker, no dialog, no permission
   * prompt — which is what makes this work in an unattended kiosk session.
   */
  async open() {
    this.root = await navigator.storage.getDirectory();
    this.csv = await this.root.getFileHandle(FILE_NAME, { create: true });
    this.cfg = await this.root.getFileHandle(CONFIG_FILE, { create: true });
    this.mode = 'opfs';

    // Ask for storage exempt from eviction. Cheap, and it is the only thing
    // that meaningfully reduces the chance of losing the log.
    try {
      if (navigator.storage.persist) await navigator.storage.persist();
      if (navigator.storage.persisted) this.persisted = await navigator.storage.persisted();
    } catch (e) { console.warn('persist() unavailable', e); }

    // ---- settings ----
    this.configText = await (await this.cfg.getFile()).text();
    if (!this.configText.trim()) {
      const mirror = localStorage.getItem(CONFIG_MIRROR);
      this.configText = (mirror && mirror.trim())
        ? mirror
        : JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n';
      await this._write(this.cfg, this.configText);
    }
    this.loadConfig();

    // ---- log ----
    const onDisk = await (await this.csv.getFile()).text();
    if (onDisk.trim()) {
      const migrated = canonicalizeCSV(onDisk);
      this.text = migrated;
      if (migrated !== onDisk) await this.flush();   // older column layout
      else this._mirror();
    } else {
      // Empty log. Seed from the browser-storage mirror if there is one, so a
      // partial wipe doesn't silently start from zero.
      const mirror = localStorage.getItem(MIRROR_KEY);
      this.text = (mirror && mirror.trim()) ? mirror : CSV_HEADER.join(',') + '\n';
      await this.flush();
    }
  },

  /** Parse whatever is in configText and apply it. Returns an error string or null. */
  loadConfig() {
    try {
      const raw = this.configText.trim() ? JSON.parse(this.configText) : {};
      applyConfig(raw);
      try { localStorage.setItem(CONFIG_MIRROR, this.configText); } catch (e) {}
      return null;
    } catch (err) {
      applyConfig({});
      return `Settings are not valid JSON: ${err.message}`;
    }
  },

  /** Persist a settings object, then apply it. */
  async saveConfig(obj) {
    this.configText = JSON.stringify(obj, null, 2) + '\n';
    if (this.mode === 'opfs' && this.cfg) await this._write(this.cfg, this.configText);
    return this.loadConfig();
  },

  /** Everything in browser storage only — used when OPFS isn't available. */
  loadLocalOnly() {
    this.mode = 'local';
    this.text = canonicalizeCSV(localStorage.getItem(MIRROR_KEY) || '');
    const cached = localStorage.getItem(CONFIG_MIRROR);
    this.configText = (cached && cached.trim()) ? cached : '{}';
    this.loadConfig();
  },

  append(obj) { return this.appendMany([obj]); },

  /** One write for a batch — saving eleven asset IDs shouldn't be eleven writes. */
  appendMany(objs) {
    if (!objs.length) return this._queue;
    if (this.text && !this.text.endsWith('\n')) this.text += '\n';
    this.text += objs.map(o => CSV_HEADER.map(k => csvEscape(o[k])).join(',')).join('\n') + '\n';
    return this.flush();
  },

  async _write(handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  },

  /** Serialised so two quick taps can't interleave whole-file writes. */
  flush() {
    this._queue = this._queue.then(async () => {
      this._mirror();
      if (this.mode !== 'opfs' || !this.csv) return;
      await this._write(this.csv, this.text);
    }).catch(err => {
      console.error('write failed', err);
      toast('Could not save — this checkout may not survive a restart.');
    });
    return this._queue;
  },

  _mirror() {
    try { localStorage.setItem(MIRROR_KEY, this.text); }
    catch (e) { console.warn('mirror failed', e); }
  },
};

/* ----------------------------------------------------------------- state */

let EVENTS = [];
let LOANS  = {};   // device -> { email, at, due }
let ASSETS = {};   // device -> asset ID tag

function rebuild() {
  const rows = parseCSV(Store.text);
  EVENTS = []; LOANS = {};
  // CONFIG provides the starting map; asset_set events recorded in the log win.
  ASSETS = {};
  for (const [dev, id] of Object.entries(CONFIG.assetIds || {})) ASSETS[String(dev)] = String(id);
  if (!rows.length) return;
  const hdr = rows[0].map(s => s.trim());
  const ix  = Object.fromEntries(hdr.map((h, i) => [h, i]));
  if (ix.timestamp == null) return;      // not our file

  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    const e = {};
    for (const k of CSV_HEADER) e[k] = r[ix[k]] ?? '';
    if (!e.event) continue;
    EVENTS.push(e);
    if (e.event === 'asset_set') { ASSETS[e.device] = e.asset_id; continue; }
    if (e.event === 'checkout' || e.event === 'staff_checkout')
      LOANS[e.device] = { email: e.email, at: e.timestamp, due: e.due };
    else delete LOANS[e.device];
  }
}

const devices = () => Array.from({ length: CONFIG.deviceCount }, (_, i) => String(i + 1));
const isOverdue = loan => loan.due && new Date(loan.due) < new Date();
const openLoanFor = email => devices().find(d => LOANS[d] && LOANS[d].email.toLowerCase() === email);

/* -------------------------------------------------------------------- ui */

let curScreen = 'loading';

function show(name) {
  curScreen = name;
  document.body.dataset.screen = name;      // handy when inspecting the page
  $$('.screen').forEach(el => el.classList.toggle('active', el.dataset.name === name));
  if (name === 'home')  renderHome();
  if (name === 'admin') renderAdmin();
  resetIdle();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function renderHome() {
  const grid = $('#deviceGrid');
  grid.innerHTML = '';
  let free = 0;

  for (const id of devices()) {
    const loan = LOANS[id];
    const b = document.createElement('button');
    b.className = 'device ' + (!loan ? 'available' : (isOverdue(loan) ? 'out overdue' : 'out'));
    b.dataset.device = id;

    let status, sub;
    if (!loan) { free++; status = 'Available'; sub = 'Tap to check out'; }
    else {
      status = isOverdue(loan) ? 'Overdue' : 'Checked out';
      sub = `Out ${fmtDur(Date.now() - new Date(loan.at).getTime())} · tap to return`;
    }
    b.innerHTML = `<span class="num">${id}</span>
      <span><span class="status">${status}</span><br><span class="sub">${sub}</span></span>`;
    grid.appendChild(b);
  }

  $('#availCount').textContent = `${free} of ${CONFIG.deviceCount} available`;
  $('#homeFoot').textContent = Store.mode === 'file'
    ? `Log: ${FILE_NAME}`
    : 'Log file not connected — records are kept in this browser only.';
}

/* ---- checkout ---- */

let coDevice = null, coDue = CONFIG.dueOptions[0].key, coDupOk = false;

function openCheckout(id) {
  coDevice = id; coDue = CONFIG.dueOptions[0].key; coDupOk = false;
  $('#coDevice').textContent = `Chromebook ${id}`;
  $('#coEmail').value = '';
  $('#coErr').hidden = true;
  $('#coWarn').hidden = true;
  renderDueChips();
  show('checkout');
  setTimeout(() => $('#coEmail').focus(), 50);
}

function renderDueChips() {
  const wrap = $('#coDue');
  wrap.innerHTML = '';
  for (const opt of CONFIG.dueOptions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(opt.key === coDue));
    b.dataset.due = opt.key;
    b.innerHTML = `${opt.label}<span class="when">${fmtWhen(dueDateFor(opt.key))}</span>`;
    wrap.appendChild(b);
  }
}

async function doCheckout() {
  const email = normalizeEmail($('#coEmail').value);
  const problem = validEmail(email);
  $('#coErr').hidden = !problem;
  if (problem) { $('#coErr').textContent = problem; return; }

  if (LOANS[coDevice]) {      // someone grabbed it between renders
    toast(`Chromebook ${coDevice} was just checked out by someone else.`);
    show('home'); return;
  }

  const already = openLoanFor(email);
  if (already && !coDupOk) {
    coDupOk = true;
    $('#coWarn').hidden = false;
    $('#coWarn').textContent =
      `You already have Chromebook ${already} checked out. Tap "Check out" again to take a second one.`;
    return;
  }

  const now = new Date();
  const due = dueDateFor(coDue, now);
  await Store.append({
    timestamp: isoLocal(now), event: 'checkout', device: coDevice,
    asset_id: ASSETS[coDevice] || '',
    email, due: isoLocal(due), checked_out_at: '', minutes_out: '', note: '',
  });
  rebuild();

  const vars = {
    device: coDevice, asset: ASSETS[coDevice] || '', email,
    due: fmtWhen(due), duration: '',
  };
  $('#doneTitle').textContent = fillTemplate(CONFIG.messages.checkoutTitle, vars);
  $('#doneMsg').textContent   = fillTemplate(CONFIG.messages.checkoutBody, vars);
  show('done');
}

/* ---- return ---- */

let rtDevice = null;

function openReturn(id) {
  const loan = LOANS[id];
  if (!loan) { show('home'); return; }
  rtDevice = id;
  $('#rtDevice').textContent = `Chromebook ${id}`;
  const out = fmtDur(Date.now() - new Date(loan.at).getTime());
  $('#rtDetail').textContent = isOverdue(loan)
    ? `Checked out ${out} ago — it was due ${fmtWhen(new Date(loan.due))}.`
    : `Checked out ${out} ago.`;
  show('return');
}

async function doReturn(id, byStaff = false) {
  const loan = LOANS[id];
  if (!loan) { show('home'); return; }
  const now = new Date();
  const outMs = now.getTime() - new Date(loan.at).getTime();
  await Store.append({
    timestamp: isoLocal(now),
    event: byStaff ? 'force_return' : 'return',
    device: id, asset_id: ASSETS[id] || '', email: loan.email, due: loan.due,
    checked_out_at: loan.at,
    minutes_out: String(Math.max(0, Math.round(outMs / 60000))),
    note: byStaff ? 'returned by staff' : (isOverdue(loan) ? 'late' : ''),
  });
  rebuild();

  if (byStaff) { renderAdmin(); toast(`Chromebook ${id} marked returned.`); return; }
  const vars = {
    device: id, asset: ASSETS[id] || '', email: loan.email,
    due: loan.due ? fmtWhen(new Date(loan.due)) : '', duration: fmtDur(outMs),
  };
  $('#doneTitle').textContent = fillTemplate(CONFIG.messages.returnTitle, vars);
  $('#doneMsg').textContent   = fillTemplate(CONFIG.messages.returnBody, vars);
  show('done');
}

/* ---- admin ---- */

const bytesToHex = b => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = h => new Uint8Array((h.match(/../g) || []).map(x => parseInt(x, 16)));

/** PBKDF2-SHA256. Salted and slow, because the hash sits in a readable local file. */
async function derivePassword(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations, hash: 'SHA-256' }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function tryLogin() {
  const err = $('#loginErr');
  err.hidden = true;

  if (!window.crypto || !crypto.subtle) {
    err.hidden = false;
    err.textContent = 'Staff sign-in needs a secure page (https:// or localhost).';
    return;
  }

  const btn = $('#btnLogin');
  btn.disabled = true;
  try {
    const { salt, hash, iterations } = CONFIG.password;
    const got = await derivePassword($('#adminPw').value, salt, iterations || 200000);
    if (got === String(hash).toLowerCase()) {
      $('#adminPw').value = '';
      show('admin');
    } else {
      err.hidden = false; err.textContent = 'Wrong password.';
    }
  } catch (e) {
    err.hidden = false; err.textContent = 'Could not check the password: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function renderConfigPanel() {
  // Don't overwrite a half-filled form on the 60-second refresh.
  const panel = $('#settingsPanel');
  if (panel.open && panel.dataset.dirty === '1') { renderConfigStatus(); return; }

  $('#cfgDeviceCount').value  = CONFIG.deviceCount;
  $('#cfgDayEnds').value      = CONFIG.dayEndsAt;
  $('#cfgDomain').value       = CONFIG.allowedEmailDomain || '';
  $('#cfgRoster').value       = (CONFIG.roster || []).join('\n');
  $('#cfgRequireRoster').checked = Boolean(CONFIG.requireRoster);
  $('#cfgMsgCoTitle').value   = CONFIG.messages.checkoutTitle;
  $('#cfgMsgCoBody').value    = CONFIG.messages.checkoutBody;
  $('#cfgMsgRtTitle').value   = CONFIG.messages.returnTitle;
  $('#cfgMsgRtBody').value    = CONFIG.messages.returnBody;
  $('#cfgTheme').value        = Object.keys(CONFIG.theme || {}).length
    ? JSON.stringify(CONFIG.theme, null, 2) : '';
  $('#cfgPw1').value = '';
  $('#cfgPw2').value = '';
  panel.dataset.dirty = '0';
  renderConfigStatus();
}

function renderConfigStatus() {
  const bits = [];
  bits.push(Store.mode === 'opfs' ? 'Storage: private file system' : 'Storage: browser only');
  if (Store.persisted !== null) bits.push(`Eviction-protected: ${Store.persisted ? 'yes' : 'NO'}`);
  bits.push(usingFallbackPassword() ? 'Password: built-in fallback' : 'Password: set here');
  bits.push(`Events logged: ${EVENTS.length}`);
  $('#configStatus').textContent = bits.join(' · ');
}

/** True while no password has been set locally, so the bundle default applies. */
function usingFallbackPassword() {
  return CONFIG.password.hash === DEFAULT_CONFIG.password.hash;
}

/** Read the form into a settings object, or return {error}. */
async function collectConfig() {
  const count = Number($('#cfgDeviceCount').value);
  if (!Number.isInteger(count) || count < 1 || count > 200)
    return { error: 'Number of Chromebooks must be a whole number between 1 and 200.' };

  const dayEnds = $('#cfgDayEnds').value;
  if (!/^\d{1,2}:\d{2}$/.test(dayEnds)) return { error: 'School day end must be a time.' };

  const domain = $('#cfgDomain').value.trim().toLowerCase().replace(/^@/, '');
  if (domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain))
    return { error: 'Email domain should look like example.org, with no @ and no https://.' };

  const roster = $('#cfgRoster').value.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
  const bad = roster.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
  if (bad.length) return { error: `Not a valid address: ${bad[0]}` };

  const requireRoster = $('#cfgRequireRoster').checked;
  if (requireRoster && !roster.length)
    return { error: 'Roster is empty, so requiring it would block every checkout.' };

  let theme = {};
  const themeRaw = $('#cfgTheme').value.trim();
  if (themeRaw) {
    try { theme = JSON.parse(themeRaw); }
    catch (e) { return { error: 'Colours must be valid JSON: ' + e.message }; }
  }

  // Password: blank means keep whatever is in force.
  let password = JSON.parse(JSON.stringify(CONFIG.password));
  const pw1 = $('#cfgPw1').value, pw2 = $('#cfgPw2').value;
  if (pw1 || pw2) {
    if (pw1 !== pw2) return { error: 'The two passwords do not match.' };
    if (pw1.length < 4) return { error: 'Password must be at least 4 characters.' };
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    password = { salt, hash: await derivePassword(pw1, salt, 200000), iterations: 200000 };
  }

  return {
    config: {
      _readme: CONFIG_TEMPLATE._readme,
      deviceCount: count,
      dayEndsAt: dayEnds,
      allowedEmailDomain: domain,
      roster,
      requireRoster,
      assetIds: CONFIG.assetIds,      // maintained by the Asset IDs panel
      messages: {
        checkoutTitle: $('#cfgMsgCoTitle').value.trim(),
        checkoutBody:  $('#cfgMsgCoBody').value.trim(),
        returnTitle:   $('#cfgMsgRtTitle').value.trim(),
        returnBody:    $('#cfgMsgRtBody').value.trim(),
      },
      password,
      theme,
    },
  };
}

async function saveConfig() {
  const err = $('#configErr'), okMsg = $('#configOk');
  err.hidden = true; okMsg.hidden = true;

  const { config, error } = await collectConfig();
  if (error) { err.hidden = false; err.textContent = error; return; }

  const problem = await Store.saveConfig(config);
  if (problem) { err.hidden = false; err.textContent = problem; return; }

  $('#settingsPanel').dataset.dirty = '0';
  rebuild();
  renderAdmin();
  okMsg.hidden = false;
  okMsg.textContent = 'Settings saved.';
}

function exportConfig() {
  const blob = new Blob([Store.configText || '{}'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = CONFIG_FILE;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importConfig(file) {
  const err = $('#configErr'), okMsg = $('#configOk');
  err.hidden = true; okMsg.hidden = true;
  try {
    const text = await file.text();
    JSON.parse(text);                       // validate before committing
    Store.configText = text;
    const problem = await Store.saveConfig(JSON.parse(text));
    if (problem) throw new Error(problem);
    // The imported file supersedes whatever was typed, so clear the dirty flag
    // or renderConfigPanel() will decline to repopulate the fields.
    $('#settingsPanel').dataset.dirty = '0';
    rebuild();
    renderAdmin();
    okMsg.hidden = false;
    okMsg.textContent = `Imported ${file.name}.`;
  } catch (e) {
    err.hidden = false;
    err.textContent = 'Could not import that file: ' + e.message;
  }
}

function renderAssets() {
  // Don't clobber half-typed input on the 60-second refresh.
  if ($('#assetPanel').open && $('#assetGrid').dataset.dirty === '1') return;
  $('#assetGrid').innerHTML = devices().map(d => `
    <label><span class="devlabel">${d}</span>
      <input type="text" data-asset="${d}" value="${(ASSETS[d] || '').replace(/"/g, '&quot;')}"
             autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="unset">
    </label>`).join('');
  $('#assetGrid').dataset.dirty = '0';
}

async function saveAssets() {
  const err = $('#assetErr');
  const typed = {};
  for (const el of $$('#assetGrid input[data-asset]')) typed[el.dataset.asset] = el.value.trim();

  const dups = duplicateAssets(typed);
  if (dups.length) {
    err.hidden = false;
    err.textContent = `Chromebooks ${dups.join(', ')} share an asset ID. Each one must be unique.`;
    return;
  }
  err.hidden = true;

  const now = isoLocal(new Date());
  const rows = [];
  for (const d of devices()) {
    const was = ASSETS[d] || '';
    if (typed[d] === was) continue;
    rows.push({
      timestamp: now, event: 'asset_set', device: d, asset_id: typed[d],
      email: '', due: '', checked_out_at: '', minutes_out: '',
      note: was ? `was ${was}` : 'first set',
    });
  }

  if (!rows.length) { toast('No asset ID changes to save.'); return; }
  await Store.appendMany(rows);
  rebuild();
  $('#assetGrid').dataset.dirty = '0';
  renderAdmin();
  toast(`Saved ${rows.length} asset ID${rows.length === 1 ? '' : 's'}.`);
}

function renderStaffCheckout() {
  const free = devices().filter(d => !LOANS[d]);
  const sel = $('#scDevice');
  const keep = sel.value;
  sel.innerHTML = free.map(d =>
    `<option value="${d}">Chromebook ${d}${ASSETS[d] ? ' — ' + ASSETS[d] : ''}</option>`).join('');
  if (free.includes(keep)) sel.value = keep;

  const none = free.length === 0;
  sel.disabled = none;
  $('#btnStaffCheckout').disabled = none;
  $('#scHint').textContent = none
    ? 'Every Chromebook is already checked out.'
    : (suffixMode()
        ? `A bare username becomes @${CONFIG.allowedEmailDomain}. Any other full address is accepted too.`
        : '');

  $('#scPresets').innerHTML = CONFIG.staffPresets.map(p =>
    `<button type="button" class="chip" data-preset="${p.days}">${p.label}</button>`).join('');

  if (!$('#scDue').value) $('#scDue').value = toLocalInput(presetDue(0));
}

async function doStaffCheckout() {
  const err = $('#scErr');
  const device = $('#scDevice').value;
  const email = normalizeEmail($('#scEmail').value);
  const dueRaw = $('#scDue').value;

  const fail = msg => { err.hidden = false; err.textContent = msg; };
  err.hidden = true;

  if (!device) return fail('No Chromebook is available.');
  if (LOANS[device]) return fail(`Chromebook ${device} is already checked out.`);

  const problem = validEmail(email, true);
  if (problem) return fail(problem);

  if (!dueRaw) return fail('Pick a return-by date and time.');
  const due = new Date(dueRaw);
  if (isNaN(due.getTime())) return fail('That return-by date is not valid.');
  if (due <= new Date()) return fail('The return-by date is in the past.');

  const now = new Date();
  const note = $('#scNote').value.trim();
  await Store.append({
    timestamp: isoLocal(now), event: 'staff_checkout', device,
    asset_id: ASSETS[device] || '',
    email, due: isoLocal(due), checked_out_at: '', minutes_out: '', note,
  });
  rebuild();

  $('#scEmail').value = '';
  $('#scNote').value = '';
  $('#scDue').value = toLocalInput(presetDue(0));
  renderAdmin();
  toast(`Chromebook ${device} checked out to ${email} until ${fmtWhen(due)}.`);
}

function renderAdmin() {
  const now = Date.now();
  const out = devices().filter(d => LOANS[d]);
  $('#adminWarn').hidden = !usingFallbackPassword();
  renderStaffCheckout();
  renderAssets();
  renderConfigPanel();

  const tb = $('#outTable tbody');
  tb.innerHTML = '';
  for (const d of out.sort((a, b) => Number(a) - Number(b))) {
    const l = LOANS[d], late = isOverdue(l);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${d}</strong></td>
      <td class="asset">${ASSETS[d] || '—'}</td>
      <td>${l.email}</td>
      <td>${fmtWhen(new Date(l.at))}</td>
      <td>${fmtDur(now - new Date(l.at).getTime())}</td>
      <td class="${late ? 'late' : ''}">${l.due ? fmtWhen(new Date(l.due)) : '—'}${late ? ' (overdue)' : ''}</td>
      <td><button class="btn danger" data-force="${d}">Mark returned</button></td>`;
    tb.appendChild(tr);
  }
  $('#outTable').closest('.tablewrap').hidden = out.length === 0;
  $('#outEmpty').hidden = out.length !== 0;

  const hb = $('#histTable tbody');
  hb.innerHTML = '';
  for (const e of EVENTS.slice(-60).reverse()) {
    const tr = document.createElement('tr');
    const label = e.event === 'asset_set' ? 'Asset ID set'
                : e.event === 'checkout' ? 'Checked out'
                : e.event === 'staff_checkout' ? 'Checked out (staff)'
                : e.event === 'force_return' ? 'Returned (staff)' : 'Returned';
    tr.innerHTML = `
      <td>${fmtWhen(new Date(e.timestamp))}</td>
      <td>${label}${e.note === 'late' ? ' <span class="late">late</span>' : ''}</td>
      <td>${e.device}</td>
      <td class="asset">${e.asset_id || '—'}</td>
      <td>${e.email}</td>
      <td>${e.minutes_out ? fmtDur(Number(e.minutes_out) * 60000) : ''}</td>`;
    hb.appendChild(tr);
  }

  const checkouts = EVENTS.filter(e => e.event === 'checkout' || e.event === 'staff_checkout').length;
  const returns   = EVENTS.filter(e => e.minutes_out);
  const avg = returns.length
    ? fmtDur(returns.reduce((s, e) => s + Number(e.minutes_out), 0) / returns.length * 60000)
    : '—';
  $('#adminStats').innerHTML = `
    <div class="stat"><div class="n">${out.length}</div><div class="k">Out now</div></div>
    <div class="stat"><div class="n">${out.filter(d => isOverdue(LOANS[d])).length}</div><div class="k">Overdue</div></div>
    <div class="stat"><div class="n">${CONFIG.deviceCount - out.length}</div><div class="k">On the shelf</div></div>
    <div class="stat"><div class="n">${checkouts}</div><div class="k">Checkouts all time</div></div>
    <div class="stat"><div class="n">${avg}</div><div class="k">Average loan</div></div>`;
}

function exportCSV() {
  const url = URL.createObjectURL(new Blob([Store.text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = FILE_NAME;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------ idle timer */

let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (curScreen === 'admin') {
    idleTimer = setTimeout(() => { show('home'); toast('Staff view locked.'); }, CONFIG.adminIdleLockMs);
  } else if (['checkout', 'return', 'done', 'login'].includes(curScreen)) {
    idleTimer = setTimeout(() => show('home'), CONFIG.kioskIdleMs);
  }
}

/* --------------------------------------------------------------- wiring */

document.addEventListener('click', async ev => {
  const t = ev.target;

  const go = t.closest('[data-go]');
  if (go) { show(go.dataset.go); return; }

  const dev = t.closest('.device');
  if (dev) { LOANS[dev.dataset.device] ? openReturn(dev.dataset.device) : openCheckout(dev.dataset.device); return; }

  const preset = t.closest('[data-preset]');
  if (preset) { $('#scDue').value = toLocalInput(presetDue(Number(preset.dataset.preset))); return; }

  const chip = t.closest('.chip');
  if (chip) { coDue = chip.dataset.due; renderDueChips(); return; }

  const force = t.closest('[data-force]');
  if (force) {
    const d = force.dataset.force;
    if (confirm(`Mark Chromebook ${d} as returned?\n\nHolder: ${LOANS[d].email}`)) doReturn(d, true);
    return;
  }

  switch (t.id) {
    case 'btnCheckout':  doCheckout(); break;
    case 'btnStaffCheckout': doStaffCheckout(); break;
    case 'btnSaveAssets': saveAssets(); break;
    case 'btnSaveConfig':   saveConfig(); break;
    case 'btnExportConfig': exportConfig(); break;
    case 'btnImportConfig': $('#cfgFile').click(); break;
    case 'btnReturn':    doReturn(rtDevice); break;
    case 'btnStaff':     $('#loginErr').hidden = true;
                         $('#loginNote').hidden = !usingFallbackPassword();
                         show('login');
                         setTimeout(() => $('#adminPw').focus(), 50); break;
    case 'btnLogin':     tryLogin(); break;
    case 'btnLock':      show('home'); break;
    case 'btnExport':    exportCSV(); break;
  }
});

document.addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  if (curScreen === 'checkout') { ev.preventDefault(); doCheckout(); }
  if (curScreen === 'login')    { ev.preventDefault(); tryLogin(); }
  if (curScreen === 'return')   { ev.preventDefault(); doReturn(rtDevice); }
});

['pointerdown', 'keydown'].forEach(e => document.addEventListener(e, resetIdle, true));

// Mark the asset editor dirty so a background refresh can't wipe what's typed.
document.addEventListener('input', ev => {
  if (ev.target.matches('#assetGrid input[data-asset]')) $('#assetGrid').dataset.dirty = '1';
  // #cfgFile is the import picker, not a field — selecting a file fires input too,
  // and treating that as a pending edit blocks the post-import re-render.
  if (ev.target.closest('#settingsPanel') && ev.target.id !== 'cfgFile')
    $('#settingsPanel').dataset.dirty = '1';
});

document.addEventListener('change', ev => {
  if (ev.target.id === 'cfgFile' && ev.target.files[0]) {
    importConfig(ev.target.files[0]);
    ev.target.value = '';
  }
});

// Keep durations and overdue flags honest without a reload.
setInterval(() => { if (curScreen === 'home') renderHome(); if (curScreen === 'admin') renderAdmin(); }, 60_000);

/* ----------------------------------------------------------------- boot */

async function boot() {
  // Paint the last known branding before anything else, so a configured kiosk
  // doesn't flash the generic palette on every load.
  const cached = localStorage.getItem(CONFIG_MIRROR);
  if (cached) { try { applyConfig(JSON.parse(cached)); } catch (e) { /* ignore */ } }
  else applyConfig({});

  if (hasOPFS) {
    try {
      await Store.open();
    } catch (err) {
      console.error('OPFS unavailable', err);
      Store.loadLocalOnly();
      toast('Private file storage unavailable — records are kept in browser storage only.');
    }
  } else {
    Store.loadLocalOnly();
    toast('Private file storage unavailable — records are kept in browser storage only.');
  }

  rebuild();
  show('home');
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

boot().catch(err => {
  console.error(err);
  $('#loadingMsg').textContent = 'Startup failed: ' + (err.message || err);
});

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from), b = to ? src.indexOf(to) : src.length;
  if (a < 0 || b < 0) throw new Error('marker not found: ' + (a < 0 ? from : to));
  return src.slice(a, b);
};

const pure  = src.slice(0, src.indexOf('/* ------------------------------------------------------------- indexeddb */'));
const state = cut('/* ----------------------------------------------------------------- state */',
                  '/* -------------------------------------------------------------------- ui */');


/* Logic tests run against a KNOWN config, not whatever is currently in app.js —
   otherwise configuring the app for a real school breaks its own test suite.
   The live CONFIG is sanity-checked separately at the bottom. */
const CONFIG_DEFAULTS = {
  deviceCount: '11',
  assetIds: '{}',
  dayEndsAt: "'15:30'",
  allowedEmailDomain: "''",
  roster: '[]',
  requireRoster: 'false',
};

function configured(over = {}) {
  let out = pure;
  for (const [k, v] of Object.entries({ ...CONFIG_DEFAULTS, ...over })) {
    const re = new RegExp('^(\\s*)' + k + ':\\s*.*?,\\s*$', 'm');
    if (!re.test(out)) throw new Error('CONFIG key not found in app.js: ' + k);
    out = out.replace(re, '$1' + k + ': ' + v + ',');
  }
  return out;
}

const mod = (over, exports) =>
  new Function('window', configured(over) + '; return {' + exports + '};')({});

const liveCONFIG = new Function('window', pure + '; return CONFIG;')({});

let FAIL = 0;
const ok = (name, cond, extra='') => { if (!cond) { FAIL++; console.log('FAIL', name, extra); } else console.log('  ok ', name); };

// ---- eval the pure half plus the replay half, with a stub Store ----
const sandbox = { console, window: {}, localStorage: null };
const run = body => { const f = new Function('window','localStorage','STORE_TEXT', body); return f; };

// --- date + format tests -------------------------------------------------
const P = mod({}, 'dueDateFor, atDayEnd, toWeekday, fmtDur, isoLocal, parseCSV, csvEscape, CONFIG, addDays');

// Thursday 2026-08-20 at 09:00 -> due same day 15:30
let now = new Date(2026, 7, 20, 9, 0, 0);
let d = P.dueDateFor('eod', now);
ok('eod before cutoff = same day 15:30',
   d.getDate() === 20 && d.getHours() === 15 && d.getMinutes() === 30, d.toString());

// Thursday 16:00 (past cutoff) -> Friday 15:30
now = new Date(2026, 7, 20, 16, 0, 0);
d = P.dueDateFor('eod', now);
ok('eod after cutoff rolls to next day', d.getDate() === 21 && d.getHours() === 15, d.toString());

// Friday 16:00 -> should skip the weekend to Monday the 24th
now = new Date(2026, 7, 21, 16, 0, 0);
d = P.dueDateFor('eod', now);
ok('eod on Friday evening skips weekend to Monday',
   d.getDate() === 24 && d.getDay() === 1, d.toString());

// Friday 09:00 "tomorrow" = Saturday -> Monday
now = new Date(2026, 7, 21, 9, 0, 0);
d = P.dueDateFor('tomorrow', now);
ok('tomorrow from Friday lands on Monday', d.getDay() === 1 && d.getDate() === 24, d.toString());

// week from Thursday 20th = 27th (a Thursday)
now = new Date(2026, 7, 20, 9, 0, 0);
d = P.dueDateFor('week', now);
ok('next week = +7 days, still a weekday', d.getDate() === 27 && d.getDay() === 4, d.toString());

ok('fmtDur minutes', P.fmtDur(25 * 60000) === '25 min', P.fmtDur(25 * 60000));
ok('fmtDur hours',   P.fmtDur(135 * 60000) === '2h 15m', P.fmtDur(135 * 60000));
ok('fmtDur days',    P.fmtDur(50 * 3600000) === '2d 2h', P.fmtDur(50 * 3600000));

// isoLocal must round-trip through Date
const t = new Date(2026, 7, 20, 15, 30, 0);
ok('isoLocal round-trips', new Date(P.isoLocal(t)).getTime() === t.getTime(), P.isoLocal(t));

// --- csv tests -----------------------------------------------------------
const nasty = 'o\'brien+test@x.org';
const noteWithComma = 'damaged, screen cracked';
const line = [nasty, noteWithComma, 'say "hi"'].map(P.csvEscape).join(',');
const back = P.parseCSV(line + '\n')[0];
ok('csv escapes/parses commas and quotes',
   back[0] === nasty && back[1] === noteWithComma && back[2] === 'say "hi"', JSON.stringify(back));

ok('csv handles CRLF', P.parseCSV('a,b\r\nc,d\r\n').length === 2);
ok('csv handles trailing newline', P.parseCSV('a,b\n').length === 1);
ok('csv handles missing trailing newline', P.parseCSV('a,b\nc,d').length === 2);

// --- replay tests --------------------------------------------------------
function replay(csv, over = {}) {
  const f = new Function('window', 'STORE_TEXT',
    configured(over) + '\nconst Store = { text: STORE_TEXT };\n' + state +
    '\nreturn { rebuild, get EVENTS(){return EVENTS}, get LOANS(){return LOANS}, get ASSETS(){return ASSETS}, devices, openLoanFor, isOverdue };');
  const m = f({}, csv);
  m.rebuild();
  return m;
}

const H = 'timestamp,event,device,email,due,checked_out_at,minutes_out,note\n';
let m = replay(H +
  '2026-08-20T09:00:00-04:00,checkout,3,ada@x.org,2026-08-20T15:30:00-04:00,,,\n' +
  '2026-08-20T09:05:00-04:00,checkout,7,grace@x.org,2026-08-20T15:30:00-04:00,,,\n' +
  '2026-08-20T14:00:00-04:00,return,3,ada@x.org,2026-08-20T15:30:00-04:00,2026-08-20T09:00:00-04:00,300,\n');
ok('replay: device 3 returned, 7 still out', !m.LOANS['3'] && m.LOANS['7'], JSON.stringify(m.LOANS));
ok('replay: event count', m.EVENTS.length === 3, m.EVENTS.length);
ok('replay: openLoanFor finds holder', m.openLoanFor('grace@x.org') === '7', m.openLoanFor('grace@x.org'));
ok('replay: openLoanFor misses returned', m.openLoanFor('ada@x.org') === undefined);

// re-checkout of a returned device
m = replay(H +
  '2026-08-20T09:00:00-04:00,checkout,3,ada@x.org,2026-08-20T15:30:00-04:00,,,\n' +
  '2026-08-20T10:00:00-04:00,return,3,ada@x.org,,2026-08-20T09:00:00-04:00,60,\n' +
  '2026-08-20T11:00:00-04:00,checkout,3,bob@x.org,2026-08-20T15:30:00-04:00,,,\n');
ok('replay: re-checkout after return', m.LOANS['3'] && m.LOANS['3'].email === 'bob@x.org', JSON.stringify(m.LOANS['3']));

// force_return clears the loan too
m = replay(H +
  '2026-08-20T09:00:00-04:00,checkout,5,ada@x.org,2026-08-20T15:30:00-04:00,,,\n' +
  '2026-08-21T08:00:00-04:00,force_return,5,ada@x.org,,2026-08-20T09:00:00-04:00,1380,returned by staff\n');
ok('replay: force_return clears loan', !m.LOANS['5'], JSON.stringify(m.LOANS));

// an email containing a comma survives the whole round trip
const weird = 'o"quote,comma@x.org';
m = replay(H + `2026-08-20T09:00:00-04:00,checkout,2,${P.csvEscape(weird)},2026-08-20T15:30:00-04:00,,,\n`);
ok('replay: quoted email round-trips', m.LOANS['2'] && m.LOANS['2'].email === weird, JSON.stringify(m.LOANS['2']));

// empty / header-only file
m = replay(H);
ok('replay: header-only file is empty state', m.EVENTS.length === 0 && Object.keys(m.LOANS).length === 0);
m = replay('');
ok('replay: totally empty file does not throw', m.EVENTS.length === 0);

// overdue detection
ok('isOverdue past due', m.isOverdue({ due: '2020-01-01T15:30:00-04:00' }) === true);
ok('isOverdue future due', m.isOverdue({ due: '2099-01-01T15:30:00-04:00' }) === false);
ok('isOverdue blank due', !m.isOverdue({ due: '' }));


// --- screen wiring (guards the blank-checkout-screen bug) ----------------
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const css  = fs.readFileSync(__dirname + '/styles.css', 'utf8');

const names = [...html.matchAll(/data-name="(\w+)"/g)].map(m => m[1]);
ok('every screen section has a data-name', names.length >= 7, names.join(','));
ok('the picker screens are gone (OPFS needs no folder)',
   !names.includes('setup') && !names.includes('unlock'), names.join(','));

// The original bug: per-screen selectors where one lost its descendant combinator
// through column alignment, so that screen could never display.
ok('css has no per-screen display selectors', !/body\[data-screen=/.test(css));
ok('css has the generic .screen.active rule', /\.screen\.active\s*\{[^}]*display:\s*block/.test(css));

// show() must drive visibility for every declared screen, by data-name.
ok('show() toggles .active by data-name',
   /classList\.toggle\('active',\s*el\.dataset\.name === name\)/.test(src));

// Exactly one section starts visible, and it is the one body/show() expects.
const initial = [...html.matchAll(/class="screen active" data-name="(\w+)"/g)].map(m => m[1]);
ok('exactly one section starts active', initial.length === 1, initial.join(','));
ok('the initially active section is "loading"', initial[0] === 'loading', initial[0]);

// Every screen JS can navigate to must exist in the markup.
const targets = new Set([...src.matchAll(/show\('(\w+)'\)/g)].map(m => m[1]));
const missing = [...targets].filter(t => !names.includes(t));
ok('every show() target has a matching section', missing.length === 0, missing.join(','));

// Every data-go button must point at a real section too.
const gos = [...html.matchAll(/data-go="(\w+)"/g)].map(m => m[1]);
const badGo = gos.filter(g => !names.includes(g));
ok('every data-go target has a matching section', badGo.length === 0, badGo.join(','));


// --- email suffix mode ---------------------------------------------------
// Build a second copy of the pure half with a domain configured.
const withDomain = (dom, roster = '[]', require_ = 'false') =>
  mod({ allowedEmailDomain: `'${dom}'`, roster, requireRoster: require_ },
      'normalizeEmail, validEmail, rosterOptions, suffixMode');

const D = withDomain('students.myschool.org');
ok('suffixMode on when a domain is set', D.suffixMode() === true);
ok('bare username gets the domain',
   D.normalizeEmail('jsmith') === 'jsmith@students.myschool.org', D.normalizeEmail('jsmith'));
ok('username is trimmed and lowercased',
   D.normalizeEmail('  JSmith ') === 'jsmith@students.myschool.org', D.normalizeEmail('  JSmith '));
ok('a full matching address is left alone',
   D.normalizeEmail('jsmith@students.myschool.org') === 'jsmith@students.myschool.org');
ok('a pasted full address is not double-suffixed',
   !D.normalizeEmail('jsmith@students.myschool.org').includes('@students.myschool.org@'));
ok('empty stays empty', D.normalizeEmail('') === '' && D.normalizeEmail('   ') === '');

ok('suffixed username validates', D.validEmail(D.normalizeEmail('jsmith')) === null);
ok('wrong pasted domain is rejected',
   /Use your @/.test(D.validEmail(D.normalizeEmail('jsmith@gmail.com'))), D.validEmail(D.normalizeEmail('jsmith@gmail.com')));
ok('username with a space is rejected', D.validEmail(D.normalizeEmail('j smith')) !== null);
ok('error text mentions the username in suffix mode',
   /username/.test(D.validEmail(D.normalizeEmail('j smith'))), D.validEmail(D.normalizeEmail('j smith')));

// No domain configured: behaviour must be unchanged from before.
const N = withDomain('');
ok('suffixMode off when no domain', N.suffixMode() === false);
ok('no domain: bare username stays bare and is invalid',
   N.normalizeEmail('jsmith') === 'jsmith' && N.validEmail('jsmith') !== null);
ok('no domain: any valid address is accepted',
   N.validEmail(N.normalizeEmail('someone@anywhere.org')) === null);

// Roster options must match what students actually type.
const R = withDomain('students.myschool.org',
                     "['Ada@students.myschool.org','grace@students.myschool.org','ext@other.org']");
ok('roster strips the shared domain for autocomplete',
   R.rosterOptions().join(',') === 'ada,grace,ext@other.org', R.rosterOptions().join(','));
const R2 = withDomain('', "['ada@students.myschool.org']");
ok('roster keeps full addresses when no domain is set',
   R2.rosterOptions()[0] === 'ada@students.myschool.org', R2.rosterOptions()[0]);

// requireRoster must compare against the full address, not the username.
const RQ = withDomain('students.myschool.org', "['ada@students.myschool.org']", 'true');
ok('requireRoster accepts a rostered username',
   RQ.validEmail(RQ.normalizeEmail('ada')) === null, RQ.validEmail(RQ.normalizeEmail('ada')));
ok('requireRoster rejects an unrostered username',
   /not on the student list/.test(RQ.validEmail(RQ.normalizeEmail('mallory'))));

// The markup the suffix logic drives must exist.
ok('suffix span exists in markup', /id="coSuffix"/.test(html));
ok('email label is addressable', /id="coEmailLabel"/.test(html));
ok('email input is type=text so a bare username is allowed',
   /id="coEmail"/.test(html) && !/type="email" id="coEmail"/.test(html));


// --- staff checkout ------------------------------------------------------
const S = mod({}, 'toLocalInput, presetDue, validEmail, normalizeEmail, CONFIG');

// datetime-local round trip: the value must reparse to the same wall-clock time.
let dt = new Date(2026, 7, 20, 15, 30);
ok('toLocalInput format', S.toLocalInput(dt) === '2026-08-20T15:30', S.toLocalInput(dt));
ok('datetime-local value reparses to the same instant',
   new Date(S.toLocalInput(dt)).getTime() === dt.getTime());
dt = new Date(2026, 0, 5, 9, 5);
ok('toLocalInput zero-pads month/day/time', S.toLocalInput(dt) === '2026-01-05T09:05', S.toLocalInput(dt));

// presets
let base = new Date(2026, 7, 20, 9, 0);            // Thursday
ok('preset 0 days = end of today', S.presetDue(0, base).getDate() === 20);
let wk = S.presetDue(7, base);
ok('preset 7 days lands 27th at day end',
   wk.getDate() === 27 && wk.getHours() === 15 && wk.getMinutes() === 30, wk.toString());
// 30 days from Thu 2026-08-20 is Sat 2026-09-19 -> must move to Mon the 21st
let mo = S.presetDue(30, base);
ok('preset that lands on a weekend moves to Monday',
   mo.getDay() !== 0 && mo.getDay() !== 6 && mo.getDate() === 21, mo.toString());

// staff email validation is deliberately looser than the student path
const SD = mod({ allowedEmailDomain: "'students.myschool.org'", requireRoster: 'true' },
               'validEmail, normalizeEmail');
ok('staff may check out to an off-domain address',
   SD.validEmail('teacher@staff.myschool.org', true) === null,
   SD.validEmail('teacher@staff.myschool.org', true));
ok('staff bypasses the roster requirement',
   SD.validEmail('nobody@students.myschool.org', true) === null);
ok('student path still enforces the domain',
   SD.validEmail('teacher@staff.myschool.org', false) !== null);
ok('staff still requires a well-formed address',
   SD.validEmail('not-an-email', true) !== null);
ok('staff username still gets the domain appended',
   SD.normalizeEmail('jsmith') === 'jsmith@students.myschool.org');

// replay: a staff checkout opens a loan just like a student one
let sm = replay(H +
  '2026-08-20T09:00:00-04:00,staff_checkout,4,teacher@x.org,2026-09-20T15:30:00-04:00,,,own device in for repair\n');
ok('replay: staff_checkout opens a loan',
   sm.LOANS['4'] && sm.LOANS['4'].email === 'teacher@x.org', JSON.stringify(sm.LOANS));
sm = replay(H +
  '2026-08-20T09:00:00-04:00,staff_checkout,4,teacher@x.org,2026-09-20T15:30:00-04:00,,,note\n' +
  '2026-08-25T09:00:00-04:00,return,4,teacher@x.org,,2026-08-20T09:00:00-04:00,7200,\n');
ok('replay: staff_checkout can be returned normally', !sm.LOANS['4'], JSON.stringify(sm.LOANS));

// markup the staff form depends on
for (const id of ['scDevice','scEmail','scDue','scNote','scErr','scPresets','scHint','btnStaffCheckout'])
  ok('staff form has #' + id, new RegExp('id="' + id + '"').test(html));
ok('due field is a datetime-local input', /type="datetime-local" id="scDue"/.test(html));


// --- the published bundle must not identify any school ------------------
// These files go to a public host. Site-specific settings belong in
// checkout-config.json on the kiosk, which is gitignored.
const DEF = mod({}, 'DEFAULT_CONFIG').DEFAULT_CONFIG;

ok('default config ships no email domain', DEF.allowedEmailDomain === '', DEF.allowedEmailDomain);
ok('default config ships an empty roster', Array.isArray(DEF.roster) && DEF.roster.length === 0);
ok('default config does not require a roster', DEF.requireRoster === false);
ok('default config ships no asset IDs', Object.keys(DEF.assetIds).length === 0);
// The bundle now carries a fallback password on purpose. A salt and a hash are
// random hex, so they identify nothing — the anonymity guarantee is unaffected.
ok('bundle fallback password is a well-formed PBKDF2 block',
   /^[0-9a-f]{32}$/.test(DEF.password.salt) && /^[0-9a-f]{64}$/.test(DEF.password.hash)
   && DEF.password.iterations >= 100000, JSON.stringify(DEF.password));
ok('default config ships no theme overrides', Object.keys(DEF.theme).length === 0);

// A stray local settings file in the repo would be committed by accident.
// config.example.json is the only settings file that belongs here.
{
  const strays = fs.readdirSync(__dirname)
    .filter(f => /config.*\.json$/i.test(f) && f !== 'config.example.json');
  const leaky = strays.filter(f => {
    try {
      const c = JSON.parse(fs.readFileSync(__dirname + '/' + f, 'utf8'));
      return Boolean(c.allowedEmailDomain) || Boolean(c.password && c.password.hash)
          || (Array.isArray(c.roster) && c.roster.length);
    } catch (e) { return false; }
  });
  ok('no populated settings file sits in the repo', leaky.length === 0,
     `${leaky.join(', ')} holds real settings — settings are entered in the staff view now; keep any exported copy outside the repo`);

  // Whatever strays exist must at least be gitignored.
  const gi = fs.existsSync(__dirname + '/.gitignore')
    ? fs.readFileSync(__dirname + '/.gitignore', 'utf8').split('\n').map(l => l.trim()) : [];
  const unignored = strays.filter(f => !gi.includes(f) && !gi.includes('*.json'));
  ok('any stray settings file is gitignored', unignored.length === 0, unignored.join(', '));
}

const gitignore = fs.existsSync(__dirname + '/.gitignore')
  ? fs.readFileSync(__dirname + '/.gitignore', 'utf8') : '';
ok('.gitignore exists', gitignore.length > 0);
ok('.gitignore covers the settings file', /^checkout-config\.json$/m.test(gitignore));
ok('.gitignore covers log files (they hold student emails)', /^\*\.csv$/m.test(gitignore));
// Classic accidental-commit vectors. None are present now; that is the point.
for (const pat of ['\\.env', '\\*~', '\\.DS_Store', '\\*\\.log', '\\*\\.key'])
  ok(`.gitignore covers ${pat.replace(/\\/g, '')}`, new RegExp('^' + pat + '$', 'm').test(gitignore));

// Nothing the app serves may reach off-origin: no CDN, no fonts, no analytics,
// and no way for the log to be transmitted anywhere.
{
  const served = ['app.js','index.html','styles.css','manifest.webmanifest']
    .map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');
  ok('app makes no network requests of its own',
     !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/.test(served));
  const urls = (served.match(/https?:\/\/[^\s"')]+/g) || [])
    .filter(u => !/^https?:\/\/\.?$/.test(u));
  ok('no remote assets or endpoints in served files', urls.length === 0, urls.join(', '));
  ok('service worker caches only the app shell',
     !/config|\.csv/.test(fs.readFileSync(__dirname + '/sw.js', 'utf8')));
}

// The example config is a template, so it must carry no real secrets.
const example = JSON.parse(fs.readFileSync(__dirname + '/config.example.json', 'utf8'));
ok('example config parses as JSON', typeof example === 'object');
ok('example config has no password baked in', !example.password.salt && !example.password.hash);
ok('example config has an empty roster', example.roster.length === 0);


// A real school domain in the source would undo the whole point of the split.
{
  const bundle = ['app.js','index.html','styles.css','manifest.webmanifest','sw.js']
    .map(f => fs.readFileSync(__dirname + '/' + f, 'utf8')).join('\n');
  const domains = [...bundle.matchAll(/@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map(m => m[1].toLowerCase());
  const allowed = new Set(['example.org', 'example.com']);
  const real = [...new Set(domains)].filter(d => !allowed.has(d));
  ok('no real email domain appears in the published bundle', real.length === 0, real.join(', '));
}

// --- theme plumbing ------------------------------------------------------
const T = mod({}, 'themeVars, mergeConfig, THEME_TOKENS');

// Every semantic token needs both a light and dark definition, or a config
// override of one would leave the other undefined.
for (const t of T.THEME_TOKENS) {
  ok(`css defines --${t}-l and --${t}-d`,
     new RegExp('--' + t + '-l:').test(css) && new RegExp('--' + t + '-d:').test(css));
  ok(`--${t} resolves through the light/dark pair`,
     new RegExp('--' + t + ':\\s*var\\(--' + t + '-l\\)').test(css)
     && new RegExp('--' + t + ':\\s*var\\(--' + t + '-d\\)').test(css));
}
ok('css still has a dark-mode media query', /prefers-color-scheme:\s*dark/.test(css));

ok('themeVars maps light and dark onto the -l/-d variables', (() => {
  const v = T.themeVars({ light: { accent: '#112233' }, dark: { accent: '#aabbcc' } });
  return v['--accent-l'] === '#112233' && v['--accent-d'] === '#aabbcc';
})());
ok('themeVars ignores unknown tokens',
   T.themeVars({ light: { 'evil--x': '#000000' } })['--evil--x-l'] === undefined);
ok('themeVars ignores non-colour values',
   Object.keys(T.themeVars({ light: { accent: 'url(javascript:alert(1))' } })).length === 0);
ok('themeVars tolerates a missing theme', Object.keys(T.themeVars(undefined)).length === 0);

// --- config merging ------------------------------------------------------
ok('mergeConfig falls back to defaults for absent keys',
   T.mergeConfig({}).dayEndsAt === DEF.dayEndsAt);
ok('mergeConfig applies overrides', T.mergeConfig({ deviceCount: 11 }).deviceCount === 11);
ok('mergeConfig merges the password block rather than replacing it',
   T.mergeConfig({ password: { hash: 'ab' } }).password.iterations === 200000);
ok('mergeConfig survives null', T.mergeConfig(null).deviceCount === DEF.deviceCount);
ok('mergeConfig survives a non-object', T.mergeConfig('nonsense').deviceCount === DEF.deviceCount);
ok('mergeConfig repairs a non-array roster', Array.isArray(T.mergeConfig({ roster: 'x' }).roster));
ok('mergeConfig repairs empty dueOptions', T.mergeConfig({ dueOptions: [] }).dueOptions.length > 0);
ok('mergeConfig repairs empty staffPresets', T.mergeConfig({ staffPresets: [] }).staffPresets.length > 0);
ok('mergeConfig accepts the shipped example file',
   T.mergeConfig(example).allowedEmailDomain === 'example.org');

// --- password hashing ----------------------------------------------------
// The app derives with WebCrypto; the tool derives with Python hashlib. If the
// parameters ever drift apart, staff get locked out of a kiosk. Cross-check.
{
  const { execFileSync } = require('child_process');
  const crypto = require('crypto');
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const pw = 'correct horse battery staple';
  const iters = 200000;

  const nodeHash = crypto.pbkdf2Sync(pw, Buffer.from(salt, 'hex'), iters, 32, 'sha256').toString('hex');
  const pyHash = execFileSync('python3', ['-c',
    'import hashlib,sys;'
    + 'print(hashlib.pbkdf2_hmac("sha256", sys.argv[1].encode(), bytes.fromhex(sys.argv[2]),'
    + ' int(sys.argv[3]), dklen=32).hex())', pw, salt, String(iters)], { encoding: 'utf8' }).trim();

  ok('make-password.py agrees with the app on PBKDF2 output', pyHash === nodeHash, pyHash);

  const tool = fs.readFileSync(__dirname + '/tools/make-password.py', 'utf8');
  ok('tool uses sha256', /pbkdf2_hmac\("sha256"/.test(tool));
  ok('tool uses a 32-byte key', /dklen=32/.test(tool));
  ok('tool iteration count matches the app default',
     /ITERATIONS = 200_000/.test(tool) && DEF.password.iterations === 200000);
  ok('tool salts randomly', /os\.urandom\(16\)/.test(tool));
  ok('tool never writes the password anywhere', !/open\(|write\(/.test(tool));
}

ok('app derives with PBKDF2, not bare sha256',
   /name: 'PBKDF2'/.test(src) && !/sha256Hex/.test(src));
ok('staff view warns when no password is set', /adminWarn/.test(src) && /id="adminWarn"/.test(html));

// --- asset IDs -----------------------------------------------------------
const A = mod({}, 'canonicalizeCSV, duplicateAssets, CSV_HEADER, parseCSV');

ok('asset_id is its own column, right after device',
   A.CSV_HEADER.join(',') === 'timestamp,event,device,asset_id,email,due,checked_out_at,minutes_out,note',
   A.CSV_HEADER.join(','));

// migration from the pre-asset_id layout
const OLD_H = 'timestamp,event,device,email,due,checked_out_at,minutes_out,note\n';
const oldFile = OLD_H +
  '2026-08-20T09:00:00-04:00,checkout,3,ada@x.org,2026-08-20T15:30:00-04:00,,,\n' +
  '2026-08-20T14:00:00-04:00,return,3,ada@x.org,,2026-08-20T09:00:00-04:00,300,late\n';
const migrated = A.canonicalizeCSV(oldFile);
ok('migration rewrites the header', migrated.split('\n')[0] === A.CSV_HEADER.join(','));
{
  const rows = A.parseCSV(migrated);
  ok('migration keeps every row', rows.length === 3, rows.length);
  ok('migration puts an empty asset_id in old rows', rows[1][3] === '', JSON.stringify(rows[1]));
  ok('migration preserves the email in its new position', rows[1][4] === 'ada@x.org', rows[1][4]);
  ok('migration preserves trailing fields', rows[2][8] === 'late', JSON.stringify(rows[2]));
}
ok('migration is a no-op on a current file',
   A.canonicalizeCSV(migrated) === migrated);
ok('migration turns an empty file into a header', A.canonicalizeCSV('') === A.CSV_HEADER.join(',') + '\n');
ok('migration leaves a foreign file untouched',
   A.canonicalizeCSV('name,qty\nwidget,3\n') === 'name,qty\nwidget,3\n');
{ // a quoted field must survive being moved between columns
  const q = OLD_H + '2026-08-20T09:00:00-04:00,checkout,3,ada@x.org,,,,"damaged, screen cracked"\n';
  const r = A.parseCSV(A.canonicalizeCSV(q));
  ok('migration preserves quoted fields containing commas',
     r[1][8] === 'damaged, screen cracked', JSON.stringify(r[1]));
}

// duplicate detection
ok('duplicateAssets finds a clash', A.duplicateAssets({1:'CB-1',2:'CB-2',3:'CB-1'}).join(',') === '1,3');
ok('duplicateAssets ignores case and padding', A.duplicateAssets({1:' cb-1 ',2:'CB-1'}).length === 2);
ok('duplicateAssets ignores blanks', A.duplicateAssets({1:'',2:'',3:'CB-9'}).length === 0);
ok('duplicateAssets clean map is empty', A.duplicateAssets({1:'CB-1',2:'CB-2'}).length === 0);

// replay
const AH = A.CSV_HEADER.join(',') + '\n';
let am = replay(AH + '2026-08-20T08:00:00-04:00,asset_set,3,CB-1042,,,,,first set\n');
ok('replay: asset_set records the mapping', am.ASSETS['3'] === 'CB-1042', JSON.stringify(am.ASSETS));

am = replay(AH +
  '2026-08-20T08:00:00-04:00,asset_set,3,CB-1042,,,,,first set\n' +
  '2026-08-21T08:00:00-04:00,asset_set,3,CB-2000,,,,,was CB-1042\n');
ok('replay: a later asset_set wins', am.ASSETS['3'] === 'CB-2000', am.ASSETS['3']);

// the bug this ordering exists to avoid
am = replay(AH +
  '2026-08-20T09:00:00-04:00,checkout,3,CB-1042,ada@x.org,2026-08-20T15:30:00-04:00,,,\n' +
  '2026-08-20T10:00:00-04:00,asset_set,3,CB-9999,,,,,was CB-1042\n');
ok('replay: retagging a device does NOT clear its active loan',
   am.LOANS['3'] && am.LOANS['3'].email === 'ada@x.org', JSON.stringify(am.LOANS));
ok('replay: retagging still updates the mapping', am.ASSETS['3'] === 'CB-9999');
ok('replay: asset_set appears in history', am.EVENTS.some(e => e.event === 'asset_set'));

// CONFIG seed, and events overriding it
am = replay(AH, { assetIds: "{ 1: 'SEED-1', 2: 'SEED-2' }" });
ok('replay: CONFIG.assetIds seeds the map',
   am.ASSETS['1'] === 'SEED-1' && am.ASSETS['2'] === 'SEED-2', JSON.stringify(am.ASSETS));
am = replay(AH + '2026-08-20T08:00:00-04:00,asset_set,1,FROM-LOG,,,,,\n',
            { assetIds: "{ 1: 'SEED-1' }" });
ok('replay: a logged asset_set beats the CONFIG seed', am.ASSETS['1'] === 'FROM-LOG', am.ASSETS['1']);

// loan events must carry the asset ID
ok('checkout rows stamp the asset id', /asset_id: ASSETS\[coDevice\]/.test(src));
ok('return rows stamp the asset id', /asset_id: ASSETS\[id\]/.test(src));
ok('staff checkout rows stamp the asset id', /asset_id: ASSETS\[device\]/.test(src));

// markup: staff sees it, students never do
ok('staff "out" table has an Asset ID column', /<th>#<\/th><th>Asset ID<\/th>/.test(html));
ok('history table has an Asset ID column', /<th>#<\/th><th>Asset ID<\/th><th>Student<\/th>/.test(html));
for (const id of ['assetPanel','assetGrid','assetErr','btnSaveAssets'])
  ok('asset editor has #' + id, new RegExp('id="' + id + '"').test(html));
{ // the student-facing sections must not mention assets at all
  const studentPart = html.slice(html.indexOf('data-name="home"'), html.indexOf('data-name="login"'));
  ok('student screens never reference an asset ID', !/asset/i.test(studentPart));
}


// --- storage layer is OPFS, with no picker anywhere ---------------------
ok('store opens the origin private file system',
   /navigator\.storage\.getDirectory\(\)/.test(src));
ok('no file or folder picker remains',
   !/showDirectoryPicker|showOpenFilePicker|showSaveFilePicker/.test(src));
ok('no permission prompts remain',
   !/requestPermission|queryPermission/.test(src));
ok('storage eviction protection is requested', /navigator\.storage\.persist\(\)/.test(src));
ok('persisted() result is surfaced to staff', /storage\.persisted\(\)/.test(src)
   && /Eviction-protected/.test(src));
ok('log and settings are separate files in OPFS',
   /getFileHandle\(FILE_NAME/.test(src) && /getFileHandle\(CONFIG_FILE/.test(src));
ok('browser-storage fallback still exists', /loadLocalOnly/.test(src));

// --- password fallback --------------------------------------------------
const M = mod({}, 'mergeConfig, DEFAULT_CONFIG');
const bundlePw = M.DEFAULT_CONFIG.password;

ok('a locally set password overrides the bundle one', (() => {
  const c = M.mergeConfig({ password: { salt: 'aa', hash: 'bb', iterations: 200000 } });
  return c.password.hash === 'bb';
})());
ok('a blank local password falls back to the bundle one', (() => {
  const c = M.mergeConfig({ password: { salt: '', hash: '', iterations: 200000 } });
  return c.password.hash === bundlePw.hash;
})(), 'a wiped store must never leave the staff view unlocked');
ok('a missing password block falls back to the bundle one',
   M.mergeConfig({}).password.hash === bundlePw.hash);
ok('a half-filled password block falls back rather than half-applying',
   M.mergeConfig({ password: { hash: 'bb' } }).password.hash === bundlePw.hash);
ok('the staff view never opens without a password',
   !/show\('admin'\); return;/.test(src),
   'login must not have an unauthenticated path');

// --- settings form ------------------------------------------------------
for (const id of ['settingsPanel','cfgDeviceCount','cfgDayEnds','cfgDomain','cfgRoster',
                  'cfgRequireRoster','cfgTheme','cfgPw1','cfgPw2','cfgFile',
                  'btnSaveConfig','btnExportConfig','btnImportConfig'])
  ok('settings form has #' + id, new RegExp('id="' + id + '"').test(html));

ok('settings form validates the domain shape', /should look like example\.org/.test(src));
ok('settings form rejects mismatched passwords', /do not match/.test(src));
ok('settings form blocks requireRoster with an empty roster',
   /would block every checkout/.test(src));
ok('new passwords get a fresh random salt',
   /crypto\.getRandomValues\(new Uint8Array\(16\)\)/.test(src));
ok('blank password fields keep the current password',
   /blank means keep whatever is in force/.test(src));
ok('asset IDs are preserved when saving settings',
   /assetIds: CONFIG\.assetIds/.test(src));
ok('settings can be exported and re-imported', /exportConfig/.test(src) && /importConfig/.test(src));


// --- settings panel refresh after import (regression) -------------------
// renderConfigPanel() skips repopulating when the form is dirty, so anything
// that replaces the form's contents must clear that flag first.
{
  const importFn = src.slice(src.indexOf('async function importConfig'),
                             src.indexOf('/* ------------------------------------------------------------ idle timer */'));
  ok('importConfig clears the dirty flag before re-rendering',
     /dataset\.dirty = '0'/.test(importFn)
     && importFn.indexOf("dataset.dirty = '0'") < importFn.indexOf('renderAdmin()'),
     'without this the imported values never reach the form fields');

  const saveFn = src.slice(src.indexOf('async function saveConfig'), src.indexOf('function exportConfig'));
  ok('saveConfig clears the dirty flag before re-rendering',
     /dataset\.dirty = '0'/.test(saveFn)
     && saveFn.indexOf("dataset.dirty = '0'") < saveFn.indexOf('renderAdmin()'));

  ok('the file picker does not mark the settings form dirty',
     /ev\.target\.id !== 'cfgFile'/.test(src),
     'selecting a file fires input, which would block the post-import refresh');

  ok('renderConfigPanel still guards against clobbering live edits',
     /panel\.open && panel\.dataset\.dirty === '1'/.test(src));
}


// --- configurable confirmation messages ---------------------------------
const MSG = mod({}, 'fillTemplate, mergeConfig, DEFAULT_CONFIG');

ok('fillTemplate substitutes a placeholder',
   MSG.fillTemplate('Chromebook {device} is yours', { device: '7' }) === 'Chromebook 7 is yours');
ok('fillTemplate substitutes several, repeated',
   MSG.fillTemplate('{device}/{asset} due {due} ({device})',
     { device: '3', asset: 'CB-1', due: 'today 3pm' }) === '3/CB-1 due today 3pm (3)');
ok('an unknown placeholder is left visible, not blanked',
   MSG.fillTemplate('Ask {persn} for it', { person: 'x' }) === 'Ask {persn} for it',
   'a typo should be obvious on screen rather than silently disappearing');
ok('a message with no placeholders passes through',
   MSG.fillTemplate('Ask at the front desk', {}) === 'Ask at the front desk');
ok('fillTemplate tolerates null/undefined', MSG.fillTemplate(null, {}) === ''
   && MSG.fillTemplate(undefined, {}) === '');
ok('empty-string values substitute as empty',
   MSG.fillTemplate('[{asset}]', { asset: '' }) === '[]');
ok('braces that are not placeholders are untouched',
   MSG.fillTemplate('use {} or {a-b}', {}) === 'use {} or {a-b}');

ok('defaults exist for all four messages',
   ['checkoutTitle','checkoutBody','returnTitle','returnBody']
     .every(k => typeof MSG.DEFAULT_CONFIG.messages[k] === 'string'
                 && MSG.DEFAULT_CONFIG.messages[k].length));

ok('a custom message overrides the default',
   MSG.mergeConfig({ messages: { checkoutTitle: 'Ask at the desk' } })
      .messages.checkoutTitle === 'Ask at the desk');
ok('a blank message falls back to the default',
   MSG.mergeConfig({ messages: { checkoutTitle: '   ' } })
      .messages.checkoutTitle === MSG.DEFAULT_CONFIG.messages.checkoutTitle,
   'clearing a field should restore the default, not show nothing');
ok('overriding one message leaves the others alone',
   MSG.mergeConfig({ messages: { checkoutTitle: 'x' } })
      .messages.returnBody === MSG.DEFAULT_CONFIG.messages.returnBody);
ok('a non-string message is ignored',
   MSG.mergeConfig({ messages: { checkoutTitle: 42 } })
      .messages.checkoutTitle === MSG.DEFAULT_CONFIG.messages.checkoutTitle);
ok('a missing messages block uses all defaults',
   MSG.mergeConfig({}).messages.checkoutBody === MSG.DEFAULT_CONFIG.messages.checkoutBody);

// Staff-entered text must never become markup.
ok('confirmation messages are rendered as text, not HTML',
   /doneTitle'\)\.textContent = fillTemplate/.test(src)
   && /doneMsg'\)\.textContent   = fillTemplate/.test(src));
ok('no innerHTML on the done screen', !/#done\w*'\)\.innerHTML/.test(src));

for (const id of ['cfgMsgCoTitle','cfgMsgCoBody','cfgMsgRtTitle','cfgMsgRtBody'])
  ok('settings form has #' + id, new RegExp('id="' + id + '"').test(html));
ok('placeholder help is shown in the form', /\{device\}/.test(html) && /\{duration\}/.test(html));

console.log(FAIL ? `\n${FAIL} FAILURE(S)` : '\nAll tests passed.');
process.exit(FAIL ? 1 : 0);

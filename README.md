# Chromebook Checkout

A self-service checkout kiosk for a small fleet of loaner Chromebooks at a school
front desk. A student taps a number, types their email, and picks a return-by date.
Staff can see who has what, and for how long, from a password-protected screen on
the same machine.

Built for a specific situation: a shelf of loaners, one checkout point, and a
front-desk staff member who shouldn't have to stop what they're doing every time a
student needs one. If that's your situation too, you're welcome to it.

**There is no server and no database.** The whole thing is static files. Every event
is appended to a CSV file in the browser's origin private file system on the kiosk,
and exported with a button when you want to analyse usage in Sheets.

**Nothing in this repository is specific to any school.** Site settings — email
domain, roster, staff password, asset IDs, colours — are entered in the staff view
and stored on the device, never in this bundle. See [Setup](#setup).

## How it works

- **Front screen** — one tile per Chromebook. Green means available, amber means
  checked out, red means overdue. Students never see anyone's email or asset ID here.
- **Check out** — tap an available tile, type your email, choose a return-by, confirm.
- **Return** — tap a checked-out tile, confirm. No email needed.
- **Staff view** — the "Staff" link, top right. Who has each device, how long they've
  had it, what's overdue, recent history, and a CSV export button. Locks itself after
  two minutes of inactivity.
- **Staff checkout** — for loans that don't fit the kiosk flow: any device, any email,
  any return-by date, plus a note. Because the password gates it, this path also
  accepts addresses off the roster and outside the configured domain, so you can loan
  to a teacher.
- **Asset IDs** — match each device number to its asset tag. These appear in the staff
  tables and as their own CSV column, so the log lines up with Google Admin Console.

## Setup

### 1. Host the files

The page must be served over `https://` or `localhost`. It cannot be opened as a
`file://` document — that origin isn't allowed to write files, which is how the app
stores everything.

Any static host works; GitHub Pages is the low-friction option. Note that a Pages
site is **public** even when published from a private repository — private Pages
requires GitHub Enterprise Cloud. That's exactly why site settings are kept out of
this repository.

To try it locally:

```sh
python3 -m http.server 8777
# then open http://localhost:8777
```

### 2. Install it on the kiosk

Open the URL in Chrome and use **Install** from the address bar or the ⋮ menu.
Installing matters: Chrome grants installed apps a *persistent* file permission, so
the kiosk won't ask anyone to re-approve after a restart. Without it, expect one
"Allow" click each morning.

### 3. Sign in and configure

Open the **Staff** link. The kiosk ships with a built-in fallback password:

```
frontdesk
```

Open **Settings** and fill in the number of Chromebooks, the school day end time,
your email domain, and optionally a roster and colour overrides. **Set your own
password there** — the banner nags until you do.

Under **Confirmation messages** you can reword what a student sees after checking
out or returning — useful if they collect the device from a person rather than a
shelf, e.g. `Ask at the front desk for Chromebook {device}`. Placeholders:

| | |
|---|---|
| `{device}` | Device number |
| `{asset}` | Asset ID tag |
| `{email}` | The student's address |
| `{due}` | Return-by, on checkout |
| `{duration}` | How long it was out, on return |

An unrecognised placeholder is left on screen rather than blanked, so a typo is
visible instead of silent. Clearing a field restores the default wording.

Then open **Asset IDs** and match each device number to its asset tag.

**Export your settings when you are done** and keep the JSON somewhere safe, such
as Drive. If the device is ever wiped, importing that file restores everything in
one step. [`config.example.json`](config.example.json) shows the shape.

### 4. About the fallback password

The bundle carries a simple built-in password rather than shipping with no lock at
all. It only ever applies in two situations: the very first boot, and after local
storage has been cleared. In both cases there is no data behind the staff view, so
a weak fallback costs nothing. Once you set your own password it takes precedence
and the fallback is unreachable.

To change the built-in one, run `python3 tools/make-password.py` and paste the block
into `DEFAULT_CONFIG.password` in `app.js`.

### 5. ChromeOS settings that matter

Run it as a **web app kiosk** so it auto-launches on boot and needs no signed-in
user. In Admin Console, for the OU this Chromebook is in, make sure that:

- **Ephemeral mode is off.** If local data is wiped at session end, every checkout
  and every setting goes with it.
- **Cookies are set to persist.** Chrome's "clear on exit" settings sweep other site
  data — IndexedDB, Cache, and the private file system — along with cookies.
- There is adequate free disk space.

The app also requests eviction-protected storage at startup and reports whether it
got it, in the staff view's Settings panel. Worth a glance after setup.

**Data loss is possible** if those settings drift, and the app cannot detect it —
any marker it wrote would be wiped by the same event. This is convenience data; the
mitigation is the exported settings file plus the occasional CSV export, not
machinery.

## Branding

The committed palette is deliberately generic. Override any of it in
`checkout-config.json`:

```json
"theme": {
  "light": { "accent": "#334f66", "ok": "#1a7f4b", "out": "#8a5a00" },
  "dark":  { "accent": "#aabbcc", "ok": "#6ddc9d", "out": "#f0c169" }
}
```

Tokens: `bg`, `surface`, `ink`, `muted`, `line`, `accent`, `accent-ink`, `ok`,
`ok-bg`, `out`, `out-bg`, `bad`, `bad-bg`. Each is defined for both light and dark;
set whichever you care about and the rest fall back to the defaults.

`ok` is "available", `out` is "checked out", `bad` is "overdue". Check your contrast —
pale tints need darkened ink on top. Aim for 4.5:1 or better.

**The app icon is part of the published bundle**, unlike the config, so it stays
generic. If you want a branded icon on your own kiosk, edit the colours in
`tools/make-icons.py` and re-run it — but understand that publishes them.

## The data file

One row per event, append-only. Nothing is ever edited or deleted, so the history
stays trustworthy for analysis.

| Column | Notes |
|---|---|
| `timestamp` | ISO 8601 with local offset. Sheets reads it as a real datetime. |
| `event` | `checkout`, `staff_checkout`, `return`, `force_return`, or `asset_set` |
| `device` | Device number, 1..N |
| `asset_id` | The asset tag, as it was at the time of the event |
| `email` | Address, lowercased |
| `due` | Return-by, recorded at checkout |
| `checked_out_at` | On return rows, when it went out |
| `minutes_out` | On return rows, how long it was gone |
| `note` | `late`, `returned by staff`, a staff note, or blank |

Return rows carry the checkout time and duration so each one stands alone — you can
pivot on `minutes_out` without joining anything.

## Behaviour worth knowing

- **Students type a username, not an address**, whenever `allowedEmailDomain` is set.
  Pasting a full address still works; the wrong domain is rejected.
- **Staff loans are a distinct event type** (`staff_checkout`), so a six-week repair
  loan is easy to exclude when looking at normal daily usage.
- **Asset ID changes are logged**, not silently rewritten, so re-tagging a replaced
  device leaves a dated trail. Past events keep the ID they were recorded with.
- **Duplicate asset IDs are rejected.**
- **Due dates skip weekends.** A Friday-afternoon "end of day" becomes Monday.
- **"End of day" after the cutoff** means the *next* school day, not a time already past.
- **Second device** — if a student already has one out, they get a warning and have to
  tap again. Not a block; the front desk can judge.
- **Older log files migrate automatically** when the column layout changes, matching by
  column name. Nothing is lost.
- **Fallback storage** — everything mirrors to localStorage as well as the private file
  system. If the log comes up empty but the mirror has content, it re-seeds rather
  than silently starting from zero.

## Privacy

`checkout-config.json` holds your domain, your roster, and your password hash. The
CSV holds student email addresses. **Neither belongs in version control** — both are
in `.gitignore`. The test suite fails if a settings file appears in the project
folder, or if a real email domain turns up anywhere in the published files.

## Tests

```sh
node test.js
```

Covers date maths, CSV escaping and migration, event replay, config merging, theme
plumbing, and cross-checks that `tools/make-password.py` and the app agree on PBKDF2
parameters — a mismatch there would lock staff out of a kiosk.

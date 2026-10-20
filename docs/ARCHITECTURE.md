# Architecture

Static site, ES2022 modules, no build. `index.html` loads `js/app.js`, which imports the rest.

## Modules

| File | Responsibility | Touches |
|---|---|---|
| `js/app.js` | Screen routing (home, play, results), event wiring, keyboard, uploads, data export/import, autosave | DOM, all modules |
| `js/engine.js` | Session state machine `idle → running → ended`, timer, scoring | nothing (pure; clock and RNG injected) |
| `js/store.js` | `localStorage["mcq:v1"]` with migrations; IndexedDB `mcq-packs` for uploaded packs; memory fallback | storage only |
| `js/render.js` | Question body, snapshot clip windows, typed blocks, answer buttons, `el()` helper | DOM |
| `js/text.js` | Markdown-lite + KaTeX; the only `innerHTML` sink | DOM (2 setters) |
| `js/review.js` | Results screen, mistakes list, explanation `<dialog>`, cause tags | DOM, store |
| `js/importer.js` | Built-in and uploaded packs, overlays, asset URLs (relative or blob:) | fetch, fflate |
| `js/validator.js` | Pack rules, same as `tools/mcqpack.py validate` | nothing (pure) |
| `js/leaderboard.js` | Optional board: probe, show, post | fetch |
| `netlify/functions/*.js` | `submit-score` (POST, validate, insert) and `leaderboard` (GET top 50) | Supabase REST |

Dependency direction: `app → review → render → text`; `app → engine`, `app → store`,
`app/render → importer → validator`. Engine and validator import nothing with side effects,
so they run under `node --test` unchanged.

## Data flow

```
packs/index.json ─┐                     ┌─> engine.start(pack, {mode, shuffle, ids, resume})
upload zip/dir/json ─> importer ─> validate ─> pack ─┤        events: question, answered, tick, ended
IndexedDB record ─┘   (overlays)                     └─> render.question / answerButtons
engine "answered" ─> store.update(active = snapshot)            (autosave, resume after reload)
engine "ended" ────> store.recordResult(result) ─> review.showResults ─> leaderboard.setupBoard
```

`setInterval(250 ms)` in `app.js` calls `engine.tick()`. The engine adds the
`performance.now()` delta since the last call, so throttled or sleeping tabs catch up
correctly and changing the system clock does nothing.

A session ends by `end('manual')`, `end('timer')` (from `tick`) or `end('complete')` (from
`answer` when every scorable question is answered; in exam mode only if nothing is flagged).

## Storage schema

`localStorage["mcq:v1"]`:

```
{ v: 1,
  settings: { mode: "exam" | "practice", shuffle: bool },
  sessions: [ { packId, packVersion, mode, reason, full, correct, total, durationMs, endedAt } ],   // last 500
  mistakes: { "<packId>/<qid>": { packId, qid, selected|null, answer, rev, at, timesWrong, cause } },
  nickname: "", clientId: "<uuid>",
  active: null | { ref: {kind:"builtin",dir} | {kind:"upload",id}, title, snapshot: <engine state> } }
```

IndexedDB `mcq-packs`, store `packs`, key `id`: `{ id, title, version, json: "<pack.json text>",
assets: { "<path>": Blob } }` (overlays are stored as assets and re-applied on open).

If storage throws (private mode, quota, blocked), the app keeps working in memory and
shows one line under the header.

## Rendering rules

- Typed question (`stem` + `options`): blocks, plus a "View original" `<details>` when a
  snapshot exists. Otherwise the snapshot, with buttons labelled by `pack.optionKeys`.
- Clip window: wrapper `aspect-ratio: w / h; overflow: hidden; position: relative`; the
  `<img>` is absolute with `width = naturalWidth / w * 100%`, `left = -x / w * 100%`,
  `top = -y / h * 100%`, set on `load`.
- Pack text never reaches `innerHTML` except through `text.js`, which escapes first.

## Adding a block type

1. Document it in `docs/PACK_FORMAT.md` (minor version bump, e.g. 1.1).
2. Add its field checks to `block()` in **both** `js/validator.js` and `tools/mcqpack.py`,
   plus a fixture in `tests/fixtures/` (valid and invalid) with `expect.json`.
3. Add a `case` in `block()` in `js/render.js`. Build DOM with `el()`; pass any text
   through `setRich`.
4. Older engines show "Unsupported content" for it, so old apps keep working.

## Adding a question type

1. Spec it (e.g. `"multi"` with `answer: ["A","C"]`).
2. Add it to `SUPPORTED_TYPES` in `validator.js` and the same check in `mcqpack.py`;
   validate its answer shape.
3. Engine: `answer()` and the scoring in `end()` compare `selected === answer`; make
   that comparison type-aware (one small function).
4. Render: `answerButtons()` would toggle instead of select for multi-answer.
5. Review: `item()` prints `selected`/`answer`; format arrays.

## Upgrading the pack format version

- `1.x`: only add optional fields. Readers ignore unknown fields and keep them
  (uploaded packs are stored as their original text).
- `2.0`: the validator refuses unknown majors with a `format` error. To support both,
  add a `toV1(pack)` (or upgrade function) in `importer.js` before `validate`, keyed on
  the major version, and the same in `mcqpack.py`. Bump the version the extractor writes.

## Upgrading stored data

Bump `VERSION` in `store.js` and add `MIGRATIONS[2] = (d) => ({ ...d, v: 2, /* changes */ })`.
`migrate()` runs every missing step on load. Add a test with a v1 object. Keep the key
`mcq:v1` (it names the storage slot, not the schema) or migrate the key too.

## Leaderboard

Client: `leaderboard.js` GETs `/.netlify/functions/leaderboard?pack=…`; any failure keeps
the panel hidden. "Post score" appears only for full-length exam runs. Server: functions
validate, then call Supabase REST with the service key. The table has RLS on with no policies.
The `best_scores` view does best-per-client.

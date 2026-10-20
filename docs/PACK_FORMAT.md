# mcqpack v1.0 — question pack format

> Reconstruction note: the original toolkit zip was not available when the engine
> was built, so this spec was written from the build brief. See DECISIONS.md.

A pack is a folder (or a zip of one) containing `pack.json`, its assets, and optional
overlay files. All paths inside a pack are relative POSIX paths from the folder that
holds `pack.json`.

```
my-pack/
  pack.json
  assets/page-02.png
  overlays/explanations.json
```

## pack.json

| Field | Type | Required | Meaning |
|---|---|---|---|
| `format` | `"mcqpack"` | yes | Identifies the file. |
| `formatVersion` | string `"1.x"` | yes | Readers accept any `1.x`; unknown fields are ignored and kept. |
| `id` | string | yes | `^[a-z0-9][a-z0-9-]{1,63}$`. Stable across versions. |
| `version` | string | yes | Content version of the pack, e.g. `"1.0.0"`. |
| `title` | string | yes | Shown to the player. |
| `optionKeys` | string[] | yes | 2–10 unique non-empty keys of at most 3 characters, e.g. `["A","B","C","D"]`. |
| `questions` | Question[] | yes | At least one, in paper order. |
| `timeLimitSec` | integer > 0 | no | Exam-mode time limit. Default: 90 s per question. |
| `overlays` | string[] | no | Overlay files to apply after loading. |
| `subject`, `source`, `licence` | string | no | Informational. |

## Question

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, unique in the pack. |
| `type` | string | yes | `"single"` (one correct key). Other types are skipped with a warning. |
| `rev` | integer ≥ 1 | yes | Bump whenever the question or its answer changes. |
| `answer` | string | yes* | One of `optionKeys`. *May be supplied by an `answers` overlay. |
| `number` | integer | no | Printed question number. |
| `snapshot` | Snapshot[] | see below | Images of the printed question. |
| `stem` | Block[] | see below | Typed question body. |
| `options` | Option[] | see below | Typed options, `{key, blocks: Block[]}`, one per option key, in order. |
| `explanation` | string | no | Markdown-lite (below). |
| `topics` | string[] | no | Free tags. |

A question must have a non-empty `snapshot`, or both `stem` and `options`, or all three.
When typed content exists it is shown, with the snapshot behind a "view original" toggle.

### Snapshot item

`{ "src": "assets/page-02.png", "clip": [x, y, w, h] }` — `clip` is a rectangle in the
image's own pixel units (`w`, `h` > 0, `x`, `y` ≥ 0). Without `clip` the whole image is
shown. Several items stack vertically (a question that runs across a page break).

### Blocks

| `type` | Fields |
|---|---|
| `text` | `text`: markdown-lite string |
| `math` | `tex`: TeX string; `display`: boolean (default true) |
| `fig` | `src`, `alt` (required, non-empty), `clip` (optional), `provenance`: `"crop"` (cut from the paper) or `"redraw"` (redrawn; shown with a badge) |
| `table` | `rows`: string[][] (markdown-lite cells); `header`: boolean, first row is a header |

Unknown block types are shown as "unsupported content" and produce a warning.

### Markdown-lite

Paragraphs separated by blank lines, `**bold**`, `*italic*`, inline math `$...$`.
Everything else is literal text. HTML is never interpreted.

## Assets

Images referenced by `snapshot[].src` and `fig.src`: PNG, JPEG, WebP, GIF or SVG.
They must exist inside the pack and paths must not escape it (no leading `/`, no `..`
or `.` segments, no `\`, no `:`). SVG files must not contain `<script`, `on*=` event
attributes, `<foreignObject`, or any `href` / `xlink:href` that does not start with `#`.

## Overlays

An overlay adds one layer of data to an existing pack without editing it:

```json
{ "format": "mcqpack-overlay", "formatVersion": "1.0", "pack": "sample-physics",
  "layer": "explanations", "items": { "q01": "Because **F = ma**." } }
```

| `layer` | Item value | Effect |
|---|---|---|
| `explanations` | string | sets `explanation` |
| `topics` | string[] | sets `topics` |
| `answers` | key string | sets `answer` |

Overlays are applied in this order: files listed in `pack.overlays`, then any other
`.json` file in the pack root whose `format` is `mcqpack-overlay`, sorted by name. Later
values win. An overlay for a different `pack`, an unknown `layer`, or an item for an
unknown question id produces a warning and is skipped. A listed overlay that is missing
is an error. Validation runs after overlays are applied.

## Validation

Errors (pack refused) carry a code; warnings do not refuse the pack.

| Code | Condition |
|---|---|
| `json` | `pack.json` missing or not valid JSON |
| `format` | `format` is not `mcqpack` or `formatVersion` is not `1.x` |
| `field` | required field missing or of the wrong type (includes `rev`, `type`, `title`, `version`) |
| `id` | pack or question id does not match its pattern |
| `duplicate-id` | two questions share an id |
| `option-keys` | bad `optionKeys`, or `options` keys differ from `optionKeys` |
| `answer` | answer missing or not one of `optionKeys` |
| `content` | no snapshot and no stem+options, or only one of stem/options |
| `clip` | clip is not four numbers with `x,y ≥ 0`, `w,h > 0` |
| `alt` | a `fig` block has no non-empty `alt` |
| `path` | an asset or overlay path escapes the pack |
| `asset-missing` | a referenced asset or listed overlay does not exist |
| `svg-unsafe` | an SVG asset contains script, event handlers, foreignObject or an external href |

Warning codes: `unsupported-type`, `unsupported-block`, `overlay`.

`tools/mcqpack.py validate` and `js/validator.js` implement exactly these rules and
report the same `(code, where)` pairs, where `where` is a question id or `pack`.

## Making a pack (three commands)

```
python3 tools/mcqpack.py extract --profile profiles/cie-mcq-v1.json \
    --paper paper.pdf --scheme scheme.pdf --id my-pack --title "My paper" --out packs/my-pack
python3 tools/mcqpack.py merge packs/my-pack/pack.json structured.json -o packs/my-pack/pack.json
python3 tools/mcqpack.py validate packs/my-pack
```

`extract` needs poppler (`pdftoppm`, `pdftotext`). It renders each page to PNG, finds
question numbers in the left margin, and writes one snapshot clip per question (plus a
second item when a question continues on the next page). It reads answers from the mark
scheme. `merge` deep-merges a partial pack (`{"questions":[{"id":..., ...}]}`) by
question id, or applies an overlay file; unknown fields are kept.

## Versioning

- Minor versions (`1.1`) only add optional fields; 1.0 readers ignore them.
- A major version (`2.0`) may change meaning. Readers refuse unknown majors with a
  `format` error. To upgrade, add a converter `2 -> 1` reader path or a migration in
  the importer (see ARCHITECTURE.md), and bump `formatVersion` in the tool.

## Leaderboard upgrade path

Version 1 grades in the browser and submits only the score, so a determined user can
forge scores. The upgrade: the client submits `{packId, packVersion, answers: {qid: key},
durationMs}`; the server holds the answer keys for allowed packs (never shipped to the
client for ranked packs) and grades itself. Packs used for ranking then ship without
`answer` fields and get an `answers` overlay only after the run is submitted.

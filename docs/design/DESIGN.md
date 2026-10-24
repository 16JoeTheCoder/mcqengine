# builtbyjosef design standard

The default for every project made by Josef Yang (UI, sites, apps, documents, slides, charts, study sheets, code, artifacts, cloud environments), unless another brand is named. Full system: the builtbyjosef design system artifact (read `project/README.md` there). This file is self-contained.

## Idea
Everything is a Tab: 72 x 128 (9:16), corner 10, one orange cap at the head. Bold, clean, minimal, disciplined, dynamic. Four rules: **ma** (leave deliberate space), **itten** (one orange point per view, at most about 10% of the area), **kata** (one fixed form per recurring element), **dynamic** (motion tells state; snap, then settle). If a detail does not improve the result, cut it.

## Voice
Answer first, short sentences, sentence case, verb-first buttons, no emoji or exclamation marks. Name: `builtbyjosef` (one word, lowercase; `builtby` weight 300 + `josef` weight 700). Person: Josef Yang. Monogram: JY (never JDY). Tagline: "Built to a standard. Built to move." Numbers with units and a space, SI (`12.4 GWh`), thin-space thousands, decimal point; dates `2026-10-24`.

## Colour (token: light / dark)
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| surface | #F3F2EE | #0D0E10 | page ground |
| surface-raised | #FBFAF7 | #16181B | panels, inputs |
| surface-sunken | #E8E6E0 | #08090A | code, wells, table heads |
| ink | #0D0E10 | #F3F2EE | text |
| ink-muted | #4A4D53 | #A9ADB3 | secondary text |
| ink-subtle | #5E6167 | #8D9198 | captions, placeholders |
| line / line-strong | #D3D0C7 / #767A80 | #2A2D32 / #7B8088 | hairlines / control borders |
| accent | #FF5B1F | #FF5B1F | fill for THE one action; the cap |
| on-accent | #0D0E10 | #0D0E10 | text on orange (never paper: 2.8:1) |
| accent-text | #B93A09 | #FF5B1F | orange as text or thin marks |
| focus | #0D0E10 | #FF5B1F | 2px ring, 2px gap |
| status-ok / warn / bad | #0B5FB5 / #8F5B00 / #C41E3A | #6DB3FF / #F0B429 / #FF6B7F | blue, amber, red; always shape + word |
| data-1..6 | #D9480F #0B63C5 #00796B #A8326F #9A6700 #4A4D53 | #FF5B1F #56B4E9 #2FD3A3 #E58FBD #F0C419 #A9ADB3 | chart series, in order |
Inverse (primary button fill): ink in light, paper in dark. Contrast: text 4.5:1, marks and control borders 3:1, in both themes. All tokens are in `tokens.css`; use `var(--token)`, never raw hex.

## Type
Space Grotesk (text, UI) and JetBrains Mono (code, columns of numbers). Weights 300, 400, 500, 700 only (no 600). Display 96/88, 64/64, 44/48 at weight 700, tracking -0.04em to -0.03em; headline pairs set one phrase in 300 and the key word in 700. h1 32/40, h2 24/32, h3 18/26. Body 15/24, lead 18/28, small 13/20 (minimum 12px, uppercase labels 12px/500/0.08em). Tabular figures for numbers in columns.

## Space, shape, depth
8px grid, 4px half step (4 8 12 16 24 32 48 64 96 128). Panel padding 24. Default radius 10 (max two radii per view; pill only for toggles). Flat: 1px hairlines; one hard shadow `4px 4px 0 0 ink` (orange in dark) with a 2px lift on hover; soft shadow only for floating menus. Left-aligned, asymmetric, max width 1200px, prose 68ch. No gradients, glass, blur, emoji icons or coloured left-border cards. Icons: Lucide, 2px stroke (stand-in; no house set yet).

## Components (`bundle.css`, prefix `jy-`)
`jy-btn` (primary = ink body + orange cap; `--accent` once per view; `--ghost`), `jy-panel` (cap sweeps orange on hover; `--active`), `jy-field`, `jy-badge` (circle ok, triangle warn, diamond bad), `jy-stat`, `jy-code` (bar says where to run it), `jy-table`, `jy-chart` helpers. Touch targets 44px.

## Motion
Durations 80 / 140 / 240 / 400 / 640 ms (instant, fast, base, slow, sweep). Curves: ease-out `cubic-bezier(0.16,1,0.3,1)` (default), ease-in `cubic-bezier(0.7,0,0.84,0)` (exits, 60% duration), ease-inout `cubic-bezier(0.65,0,0.35,1)`, ease-snap `cubic-bezier(0.34,1.56,0.64,1)` (toggles only). Signature moves: cap sweep, tab rise (lift 2px + hard shadow), counter roll. Never decorative loops; respect `prefers-reduced-motion`.

## Logo
Files in `logos/`. Light ground: tab-primary-light; dark: tab-primary-dark; one-colour print/favicons: tab-mono-ink / tab-mono-paper; orange ground: tab-on-orange; low-ink print and study sheets: tab-outline; 24-48px: tab-small; signatures and README banners: tab-lockup-light/dark. Clear space 28 units (2 x cap); min 24px tall (lockup 40px). Every app, site, document and program carries the signature.

## Data and print
Direct line labels, `quantity (unit)` axis titles, SI, data-1 for the series the chart is about (3px), dashes beyond three series, gridlines 1px `data-grid`, n and source in the caption. Equations in LaTeX, define symbols once, working line by line. Study sheets: low ink (coloured outlines, no filled backgrounds), single column, generous spacing, body at least 11pt, tab-outline logo. Matplotlib: `builtbyjosef.mplstyle`.

## Code and working rules
Lean, efficient code: no gold-plating, no feature or token spend that does not substantially improve the result. Units in names (`speed_ms`), SI internally. snake_case Python, kebab-case files and classes, PascalCase components. CLI output: `->` step, `ok` success, `!` warning, `x` failure; no emoji; honour NO_COLOR. Whenever instructing an install or command, state exactly where to run it (Ubuntu/WSL terminal, VS Code terminal, Windows PowerShell, or browser). Build only when told to build; "build the plan" means plan only.

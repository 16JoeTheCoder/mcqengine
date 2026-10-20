# Vendored libraries

Copied by hand from npm once; there is no package manager at runtime. To verify the
files have not changed: `cd vendor && sha256sum -c SHA256SUMS` (every file is listed there).

| Library | Version | Licence | Source file in the npm package | Vendored as | sha256 |
|---|---|---|---|---|---|
| KaTeX | 0.16.47 | MIT (`katex/LICENSE`) | `dist/katex.mjs` | `katex/katex.js` | `09a78a9812d1e7d3ace85033512e6a450127b9554ef281b4b6567408694c6e36` |
| KaTeX | 0.16.47 | MIT | `dist/katex.min.css` | `katex/katex.min.css` | `0289a02cf451a44dd73add683a09644252363871ac11713a647b732cee8b1ee3` |
| KaTeX | 0.16.47 | MIT | `dist/fonts/*.woff2` (20 files) | `katex/fonts/` | see `SHA256SUMS` |
| fflate | 0.8.2 | MIT (`fflate/LICENSE`) | `esm/browser.js` | `fflate/fflate.js` | `8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7` |

Notes

- `.mjs` was renamed to `.js` so every static server sends a JavaScript MIME type.
- Only the `.woff2` fonts are kept; every browser that runs ES modules supports woff2,
  so the `.woff`/`.ttf` fallbacks named in the CSS are never requested.
- KaTeX 0.16.x was chosen over the newer 0.17–0.19 line because 0.16 had years of
  field use; nothing in this app needs newer features.
- Only fflate's synchronous `unzipSync` is used, so its Worker code never runs (it
  would be blocked by the CSP anyway).

Upgrading: `npm install katex@X fflate@Y` in a scratch folder, copy the same files,
regenerate `SHA256SUMS` (`find . -type f ! -name SHA256SUMS ! -name README.md | sort | xargs sha256sum > SHA256SUMS`),
update this table, run `npm test` and the e2e script.

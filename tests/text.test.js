import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHTML, inlineHTML, escape, math } from '../js/text.js';

// Every "<" must start a well-formed tag (text is escaped); no dangerous tag or attribute may appear.
const TAG = /^<\/?([a-z][a-z0-9]*)((?:\s+[a-z:-]+="[^"<]*")*)\s*\/?>/i;
function assertInert(html) {
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i + 1)) {
    const m = TAG.exec(html.slice(i));
    assert.ok(m, `raw "<" at ${i}: ${html.slice(i, i + 40)}`);
    assert.doesNotMatch(m[1], /^(a|img|script|iframe|object|embed|foreignobject|style|link|image|use)$/i, `tag ${m[1]}`);
    for (const [, name, value] of m[2].matchAll(/([a-z:-]+)="([^"]*)"/gi)) {
      assert.doesNotMatch(name, /^(on|href|src|xlink|action|formaction|id$)/i, `attribute ${name}`);
      assert.doesNotMatch(value, /javascript:|url\(/i, `value ${value}`);
    }
  }
}

test('basic markdown-lite', () => {
  assert.equal(toHTML('Hello **bold** and *it*\n\nTwo\nlines'), '<p>Hello <strong>bold</strong> and <em>it</em></p><p>Two<br>lines</p>');
  assert.equal(toHTML(''), '');
  assert.equal(toHTML(null), '');
});

test('HTML in text is escaped', () => {
  const html = toHTML('<img src=x onerror=alert(1)> <script>alert(1)</script> "q" \'s\' & <b>');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<script|<b>/);
  assert.equal(escape('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
});

test('markdown cannot be used to build tags', () => {
  const html = toHTML('**<img src=x onerror=alert(1)>**');
  assert.equal(html, '<p><strong>&lt;img src=x onerror=alert(1)&gt;</strong></p>');
});

test('inline math renders through KaTeX', () => {
  const html = inlineHTML('Energy $E = mc^2$ here');
  assert.match(html, /class="katex"/);
  assertInert(html);
});

test('\\href with javascript: stays inert', () => {
  for (const src of ['$\\href{javascript:alert(1)}{x}$', '$\\url{javascript:alert(1)}$', '$\\htmlId{x}{y}$', '$\\includegraphics{http://evil/x.png}$']) {
    const html = toHTML(src);
    assertInert(html);
    assert.doesNotMatch(html, /href=|src=|id="x"/);
  }
});

test('unbalanced and malformed math render inert and do not throw', () => {
  for (const src of ['$x^2', 'cost $5 and $', '$\\frac{1}{$', '$<img src=x onerror=alert(1)>$', '$\\begin{array}$', '$'.repeat(9)]) {
    const html = toHTML(src);
    assertInert(html);
    assert.doesNotMatch(html, /<img/);
  }
  assertInert(math('\\badcommand{<script>}', true));
});

test('macro bombs are bounded', () => {
  const html = math('\\def\\a{\\a\\a}\\a');
  assertInert(html);
});

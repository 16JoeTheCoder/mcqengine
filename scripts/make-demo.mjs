// Writes synthetic demo packs for reviews and manual testing. No real exam content.
// Run from the repo root in any terminal: node scripts/make-demo.mjs <out-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const out = process.argv[2] ?? 'demo';
mkdirSync(out, { recursive: true });
const L = 'ABCD';
const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 100'><rect x='70' y='40' width='80' height='30' fill='none' stroke='black' stroke-width='2'/><line x1='150' y1='55' x2='220' y2='55' stroke='black' stroke-width='2'/><polygon points='220,50 230,55 220,60' fill='black'/><text x='190' y='45' font-size='14'>F</text><line x1='10' y1='70' x2='230' y2='70' stroke='black' stroke-width='2'/></svg>`;

function question(paper, n) {
  const k = (n * 7 + paper.length) % 4;
  const base = { n, answer: L[k] };
  if (n % 9 === 0)
    return { ...base, stem: `Which row correctly describes quantity ${n}?`, table: { columns: ['quantity', 'unit'], rows: [['speed', 'm s^{-1}'], ['force', 'N'], ['energy', 'J'], ['power', 'W']] } };
  if (n % 7 === 0) return { ...base, stem: `A block is pulled by a force F as shown. The mass is ${n}.0 kg. What is its acceleration?`, figure: { svg, alt: 'Block on a surface pulled by force F' }, options: ['1.0 m s^{-2}', '2.0 m s^{-2}', '4.0 m s^{-2}', '8.0 m s^{-2}'] };
  if (n % 11 === 0) return { ...base, stem: `The graph shows how velocity varies with time for object ${n}. What is the displacement?`, figure: { needed: true, note: 'velocity-time graph' }, options: ['12 m', '24 m', '36 m', '48 m'] };
  return {
    ...base,
    stem: `Synthetic question ${n}: a wave of wavelength λ = ${(n * 0.1).toFixed(1)} m travels at ${n * 3} m s^{-1}. What is \\frac{v}{λ}, and which statement is **NOT** true?`,
    options: [`${n} Hz`, `${n * 2} Hz`, `${n * 3} Hz`, `${n * 4} Hz`],
  };
}

function paper(id, title, group, count = 40, minutes = 75) {
  return { id, title, group, questionCount: count, timeLimitMinutes: minutes, optionCount: 4, questions: Array.from({ length: count }, (_, i) => question(id, i + 1)) };
}

const small = {
  format: 'dmc-pack/1',
  pack: { title: 'Demo Physics', subject: 'Physics' },
  papers: [
    paper('demo-2025-mj-12', 'May/June 2025 Paper 12', ['2025', 'May/June']),
    paper('demo-2025-mj-13', 'May/June 2025 Paper 13', ['2025', 'May/June']),
    paper('demo-2024-on-12', 'Oct/Nov 2024 Paper 12', ['2024', 'Oct/Nov']),
  ],
};
writeFileSync(join(out, 'demo-3-papers.json'), JSON.stringify(small, null, 2));

const series = ['Feb/March', 'May/June', 'Oct/Nov'];
const many = { format: 'dmc-pack/1', pack: { title: 'Demo Archive', subject: 'Physics' }, papers: [] };
for (let y = 2025; many.papers.length < 300; y--)
  for (const s of series)
    for (const v of [11, 12, 13, 21, 22])
      if (many.papers.length < 300) many.papers.push(paper(`demo-${y}-${s.slice(0, 3).toLowerCase()}-${v}`, `${s} ${y} Paper ${v}`, [String(y), s], 10, 20));
writeFileSync(join(out, 'demo-300-papers.json'), JSON.stringify(many));

// A zip with a whole-question screenshot (rendered as a simple SVG "scan").
const scan = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 260"><rect width="600" height="260" fill="white"/><text x="20" y="40" font-size="20" font-family="serif">7  A ball is thrown vertically upwards at 12 m s</text><text x="452" y="30" font-size="13" font-family="serif">−1</text><text x="20" y="80" font-size="20" font-family="serif">What is the maximum height reached?</text><text x="40" y="130" font-size="20" font-family="serif">A  3.7 m     B  7.3 m     C  12 m     D  15 m</text></svg>`;
const zipDoc = {
  format: 'dmc-pack/1',
  pack: { title: 'Demo Screenshots', subject: 'Physics' },
  papers: [{ id: 'demo-scan', title: 'Screenshot paper', group: ['2025'], questionCount: 2, timeLimitMinutes: 4, questions: [{ n: 1, stem: 'A typed question with an attached figure.', figure: { file: 'images/fig1.svg' }, options: ['a', 'b', 'c', 'd'], answer: 'B' }, { n: 2, image: 'images/q7.svg', answer: 'B' }] }],
};
writeFileSync(join(out, 'demo-screenshots.zip'), zipSync({ 'pack.json': strToU8(JSON.stringify(zipDoc)), 'images/q7.svg': strToU8(scan), 'images/fig1.svg': strToU8(svg.replace(/'/g, '"')) }));
console.log(`ok wrote demo packs to ${out}`);

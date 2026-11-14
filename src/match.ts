// Matching brain dump lines to existing tasks (Day planner). Pure, so it is tested on its own.
const STOP = new Set('a an the to for of and or with on in at by my me i we our up do get go make set new about from this that it is be will can need needs'.split(' '));
const stem = (w: string) => w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)).map(stem);
const grams = (s: string) => { const t = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `; const g = new Set<string>(); for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3)); return g; };
/**
 * How well a brain dump line matches a task title, 0 to 1. Words count most (stemmed, small words ignored, a word that
 * starts another of 4+ letters counts 0.8: "eval" and "evaluate"); letter triples catch typos and run-together words.
 * A task key written in the line ("OPS-12") is a sure match.
 */
export function matchScore(line: string, title: string, key = ''): number {
  if (key && new RegExp(`\\b${key}\\b`, 'i').test(line)) return 1;
  const a = tokens(line), b = tokens(title);
  if (!a.length || !b.length) return 0;
  let hit = 0;
  for (const w of a) hit += b.includes(w) ? 1 : b.some(x => (x.length >= 4 && w.length >= 4) && (x.startsWith(w) || w.startsWith(x))) ? 0.8 : 0;
  const cover = hit / a.length, back = hit / b.length;
  const ga = grams(line), gb = grams(title); let common = 0; for (const g of ga) if (gb.has(g)) common++;
  const dice = (2 * common) / (ga.size + gb.size || 1);
  return Math.min(1, Math.max(0.65 * cover + 0.35 * back, 0.9 * dice));
}


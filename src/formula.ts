// Formula engine for formula columns. No eval: a small parser over a fixed set of operators and functions.
// ---------- Formulas ----------
// {Column name} reads a column. Operators: + - * / % == != < > <= >= && || !. Functions:
// if(cond, a, b), round(x, digits), floor, ceil, abs, min, max, sum, days(from, to), today(), dateAdd(date, days),
// concat(...), len(x), empty(x), lower, upper, contains(text, part).
export type Val = number | string | boolean | null;
const FNS: Record<string, (...a: Val[]) => Val> = {
  if: (c, a, b) => (c ? a : b) ?? null,
  round: (x, d = 0) => { const m = 10 ** Number(d); return Math.round(Number(x) * m) / m; },
  floor: x => Math.floor(Number(x)), ceil: x => Math.ceil(Number(x)), abs: x => Math.abs(Number(x)),
  min: (...a) => Math.min(...a.filter(v => v !== null && v !== '').map(Number)), max: (...a) => Math.max(...a.filter(v => v !== null && v !== '').map(Number)),
  sum: (...a) => a.reduce<number>((s, v) => s + (Number(v) || 0), 0),
  days: (a, b) => a && b ? Math.round((Date.parse(String(b)) - Date.parse(String(a))) / 86400000) : null,
  dateAdd: (d, n) => { if (!d) return null; const t = new Date(String(d) + 'T00:00:00'); t.setDate(t.getDate() + Number(n)); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; },
  concat: (...a) => a.map(v => v ?? '').join(''), len: x => String(x ?? '').length, empty: x => x === null || x === '' || x === 0 || x === false,
  lower: x => String(x ?? '').toLowerCase(), upper: x => String(x ?? '').toUpperCase(), contains: (s, t) => String(s ?? '').toLowerCase().includes(String(t ?? '').toLowerCase()),
};

type Tok = {t: 'num' | 'str' | 'prop' | 'id' | 'op'; v: string};
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < src.length && /[0-9.]/.test(src[j])) j++; out.push({t: 'num', v: src.slice(i, j)}); i = j; continue; }
    if (c === '"' || c === "'") { const j = src.indexOf(c, i + 1); if (j < 0) throw new Error('A text value is missing its closing quote'); out.push({t: 'str', v: src.slice(i + 1, j)}); i = j + 1; continue; }
    if (c === '{') { const j = src.indexOf('}', i); if (j < 0) throw new Error('A {column} is missing its }'); out.push({t: 'prop', v: src.slice(i + 1, j).trim()}); i = j + 1; continue; }
    if (/[a-z_]/i.test(c)) { let j = i; while (j < src.length && /[a-z0-9_]/i.test(src[j])) j++; out.push({t: 'id', v: src.slice(i, j)}); i = j; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({t: 'op', v: two}); i += 2; continue; }
    if ('+-*/%<>!(),'.includes(c)) { out.push({t: 'op', v: c}); i++; continue; }
    throw new Error(`Unexpected "${c}"`);
  }
  return out;
}
export function evalFormula(src: string, get: (name: string) => Val, today: string): Val {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p], eat = (v?: string) => { const t = toks[p++]; if (!t || (v && t.v !== v)) throw new Error(v ? `Expected "${v}"` : 'The formula ends too soon'); return t; };
  const num = (v: Val) => typeof v === 'number' ? v : v === null || v === '' ? 0 : typeof v === 'boolean' ? Number(v) : Number(v);
  const primary = (): Val => {
    const t = eat();
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'str') return t.v;
    if (t.t === 'prop') return get(t.v);
    if (t.t === 'op' && t.v === '(') { const v = or(); eat(')'); return v; }
    if (t.t === 'op' && t.v === '-') return -num(primary());
    if (t.t === 'op' && t.v === '!') return !primary();
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'today' && peek()?.v !== '(') return today;
      eat('(');
      const args: Val[] = [];
      if (peek()?.v !== ')') { args.push(or()); while (peek()?.v === ',') { eat(','); args.push(or()); } }
      eat(')');
      if (t.v === 'today') return today;
      const f = FNS[t.v];
      if (!f) throw new Error(`Unknown function ${t.v}()`);
      return f(...args);
    }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const mul = (): Val => { let a = primary(); while (['*', '/', '%'].includes(peek()?.v)) { const o = eat().v, b = primary(); a = o === '*' ? num(a) * num(b) : o === '/' ? (num(b) === 0 ? null : num(a) / num(b)) : num(a) % num(b); } return a; };
  const add = (): Val => { let a = mul(); while (['+', '-'].includes(peek()?.v)) { const o = eat().v, b = mul(); a = o === '+' ? (typeof a === 'string' || typeof b === 'string' ? `${a ?? ''}${b ?? ''}` : num(a) + num(b)) : num(a) - num(b); } return a; };
  const cmp = (): Val => {
    const a = add();
    if (!['==', '!=', '<', '>', '<=', '>='].includes(peek()?.v)) return a;
    const o = eat().v, b = add();
    const [x, y] = typeof a === 'number' || typeof b === 'number' ? [num(a), num(b)] : [String(a ?? ''), String(b ?? '')];
    return o === '==' ? x === y : o === '!=' ? x !== y : o === '<' ? x < y : o === '>' ? x > y : o === '<=' ? x <= y : x >= y;
  };
  const and = (): Val => { let a = cmp(); while (peek()?.v === '&&') { eat(); const b = cmp(); a = !!a && !!b; } return a; };
  const or = (): Val => { let a = and(); while (peek()?.v === '||') { eat(); const b = and(); a = !!a || !!b; } return a; };
  const v = or();
  if (p < toks.length) throw new Error(`Unexpected "${toks[p].v}"`);
  return typeof v === 'number' && !Number.isFinite(v) ? null : v;
}


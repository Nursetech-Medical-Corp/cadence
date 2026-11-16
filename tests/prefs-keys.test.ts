import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {PREF_KEY, Tasks} from '../server/service.ts';
import {openDb} from '../server/db.ts';

// Found by the timers e2e: focusList, focus, eventColors, newItems, newDefaults and rollupAdd were refused by the
// server ("Unknown preference"), so those settings never saved. Every key the app saves must be accepted.
test('every preference key the app saves is accepted by the server', () => {
  const dir = join(import.meta.dirname, '../src');
  const keys = new Set<string>();
  for (const f of readdirSync(dir).filter(f => /\.tsx?$/.test(f))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/setPref\('([^']+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/setPref\(`([a-z]+):\$\{/g)) keys.add(`${m[1]}:abc-123`);
    for (const m of src.matchAll(/'\/prefs', \{method: 'PUT', body: \{key: '([^']+)'/g)) keys.add(m[1]);
  }
  assert.ok(keys.size >= 8, `found ${keys.size} keys`);
  for (const k of keys) assert.match(k, PREF_KEY, `the server refuses the preference "${k}"`);
  const t = new Tasks(openDb(':memory:'), () => '2026-11-16');
  const p = t.createPerson({name: 'Ann'});
  t.setPref(p.id, 'eventColors', {ev1: '11'});
  assert.deepEqual(t.prefs(p.id).eventColors, {ev1: '11'});
  assert.throws(() => t.setPref(p.id, 'anything', 1), /Unknown preference/);
});

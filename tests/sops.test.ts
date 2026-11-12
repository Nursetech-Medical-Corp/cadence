import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db.ts';
import {Tasks} from '../server/service.ts';
import {listSopLinks, migrateSops, setSopLinks} from '../server/sops.ts';

test('SOP links: set, replace, fallback, remove, reject bad input', () => {
  const t = new Tasks(openDb(':memory:'), () => '2026-11-11');
  migrateSops(t);
  setSopLinks(t, [{code: 'sop-07.2', url: 'https://docs.google.com/document/d/a', title: 'Outreach'}, {code: '*', url: 'https://docs.google.com/spreadsheets/d/m'}]);
  assert.deepEqual(listSopLinks(t).map(l => l.code), ['*', 'SOP-07.2']);
  setSopLinks(t, [{code: 'SOP-07.2', url: 'https://docs.google.com/document/d/b'}]);
  assert.equal(listSopLinks(t).find(l => l.code === 'SOP-07.2')!.url, 'https://docs.google.com/document/d/b');
  setSopLinks(t, [{code: 'SOP-07.2', url: ''}]);
  assert.equal(listSopLinks(t).length, 1);
  assert.throws(() => setSopLinks(t, [{code: 'hello', url: 'https://x.test'}]), /not an SOP code/);
  assert.throws(() => setSopLinks(t, [{code: 'SOP-01.1', url: 'javascript:alert(1)'}]), /https/);
});

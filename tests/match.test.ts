import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchScore} from '../src/match.ts';

test('brain dump matching: close titles score high, unrelated ones low', () => {
  const titles = ['Evaluate customer survey results', 'Call Tim about the distributor contract', 'Develop feature: export to CSV', 'Order lunch for the team', 'Fix broken image links'];
  const best = (line: string) => titles.map(t => [t, matchScore(line, t)] as const).sort((a, b) => b[1] - a[1])[0];
  assert.equal(best('evaluate survey')[0], titles[0]);
  assert.equal(best('call tim')[0], titles[1]);
  assert.equal(best('develop features')[0], titles[2], 'plural and singular match');
  assert.equal(best('eval survey')[0], titles[0], 'a short form of a word counts');
  assert.equal(best('fix brokn images')[0], titles[4], 'typos still land');
  assert.ok(best('do laundry')[1] < 0.45, 'nothing close stays under the line');
  assert.ok(matchScore('read book', 'Write article') < 0.45);
  assert.equal(matchScore('follow up on OPS-12 today', 'Anything', 'OPS-12'), 1, 'a written key is a sure match');
  assert.ok(matchScore('the a to', 'The A To') === 0, 'small words alone never match');
});

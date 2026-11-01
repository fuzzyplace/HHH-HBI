import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journey, FIT_HOLD_MS } from '../../src/journey/journey.js';

const run = (j, frames) => { for (const f of frames) j.tick(f); };

test('muse path: connect waits for the stream, fit waits for 3 sensors held steady', () => {
  const j = new Journey(), seen = [];
  j.on('stage', e => seen.push(e.stage));
  j.begin('muse');
  run(j, [{ streaming: false, contactN: 0, now: 0 }]);
  assert.equal(j.stage, 'connect');
  run(j, [{ streaming: true, contactN: 1, now: 100 }]);
  assert.equal(j.stage, 'fit');
  run(j, [{ streaming: true, contactN: 3, now: 200 }, { streaming: true, contactN: 2, now: 1500 }, { streaming: true, contactN: 3, now: 1600 }]);
  assert.equal(j.stage, 'fit', 'a dropped sensor restarts the hold');
  run(j, [{ streaming: true, contactN: 4, now: 1600 + FIT_HOLD_MS }]);
  assert.equal(j.stage, 'baseline');
  assert.deepEqual(seen, ['connect', 'fit', 'baseline']);
});

test('simulator path skips connect; manual steps only move on go()', () => {
  const j = new Journey();
  j.begin('sim');
  assert.equal(j.stage, 'fit');
  run(j, [{ streaming: true, contactN: 4, now: 0 }, { streaming: true, contactN: 4, now: FIT_HOLD_MS }]);
  assert.equal(j.stage, 'baseline');
  run(j, [{ streaming: true, contactN: 4, now: 99999 }]);
  assert.equal(j.stage, 'baseline');
  j.go('ready'); j.go('practice'); j.go('nowhere');
  assert.equal(j.stage, 'practice');
  assert.ok(j.guided);
  j.go('explore');
  assert.ok(!j.guided);
});

test('Back from the baseline step returns to where you came from', () => {
  const j = new Journey();
  j.go('explore'); j.go('baseline');
  assert.equal(j.backFromBaseline, 'explore');
  j.go('ready'); j.go('baseline');
  assert.equal(j.backFromBaseline, 'ready');
  j.go('fit'); j.go('baseline');
  assert.equal(j.backFromBaseline, 'welcome');
});

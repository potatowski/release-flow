'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ZERO, parseTag, format, latestTag, decideBump, bump } = require('../src/version.cjs');

test('parses only strict vX.Y.Z tags', () => {
  assert.deepEqual(parseTag('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseTag('1.2.3'), null);
  assert.equal(parseTag('v1.2'), null);
  assert.equal(parseTag('v1.2.3-rc.1'), null);
  assert.equal(parseTag('v1'), null);
});

test('picks the highest semver tag, not the lexicographic one', () => {
  const best = latestTag(['v1.9.0', 'v1.10.0', 'v1', 'nightly', 'v0.99.99']);
  assert.equal(best.tag, 'v1.10.0');
  assert.equal(latestTag(['foo']), null);
});

test('nothing to release without entries', () => {
  assert.equal(decideBump({ breaking: true, added: false, total: 0 }, ZERO), null);
});

test('breaking bumps major', () => {
  const current = parseTag('v1.4.2');
  const decision = decideBump({ breaking: true, added: true, total: 3 }, current);
  assert.equal(decision.type, 'major');
  assert.equal(format(bump(current, decision.type)), '2.0.0');
});

test('breaking bumps minor while major is 0', () => {
  const current = parseTag('v0.3.1');
  const decision = decideBump({ breaking: true, added: false, total: 1 }, current);
  assert.equal(decision.type, 'minor');
  assert.equal(format(bump(current, decision.type)), '0.4.0');
});

test('added bumps minor, anything else bumps patch', () => {
  const current = parseTag('v1.4.2');
  assert.equal(decideBump({ breaking: false, added: true, total: 1 }, current).type, 'minor');
  assert.equal(format(bump(current, 'minor')), '1.5.0');
  assert.equal(decideBump({ breaking: false, added: false, total: 2 }, current).type, 'patch');
  assert.equal(format(bump(current, 'patch')), '1.4.3');
});

test('first release starts from 0.0.0', () => {
  assert.equal(format(bump(ZERO, 'minor')), '0.1.0');
  assert.equal(format(bump(ZERO, 'patch')), '0.0.1');
});

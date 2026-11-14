'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseChangelog,
  isBreaking,
  aggregate,
  renderSections,
  renderPullRequests,
} = require('../src/changelog.cjs');

const TEMPLATE = `## Summary

Some text.

## 📋 Changelog Entry

### Added
- New login page
### Changed
-
### Deprecated
-
### Removed
-
### Fixed
- Crash on startup
### Security
-

## Checklist
- [x] Tests
`;

test('parses the template with an emoji heading', () => {
  const result = parseChangelog(TEMPLATE);
  assert.deepEqual(result.Added, ['New login page']);
  assert.deepEqual(result.Fixed, ['Crash on startup']);
  assert.deepEqual(result.Changed, []);
  assert.deepEqual(result.Security, []);
});

test('stops at the next h2 heading', () => {
  const result = parseChangelog(TEMPLATE);
  const all = Object.values(result).flat();
  assert.ok(!all.some((item) => item.includes('Tests')));
});

test('handles CRLF line endings', () => {
  const result = parseChangelog(TEMPLATE.replace(/\n/g, '\r\n'));
  assert.deepEqual(result.Added, ['New login page']);
  assert.deepEqual(result.Fixed, ['Crash on startup']);
});

test('skips placeholders and empty bullets', () => {
  const body = [
    '## Changelog Entry',
    '### Changed',
    '-',
    '- N/A',
    '* none',
    '- None',
    '-   ',
    '* Real change',
  ].join('\n');
  assert.deepEqual(parseChangelog(body).Changed, ['Real change']);
});

test('appends indented continuation lines to the previous bullet', () => {
  const body = [
    '## Changelog Entry',
    '### Fixed',
    '- Fixed a long',
    '  standing bug',
    '\twith tabs',
    '- Second item',
    'not indented, ends the item',
  ].join('\n');
  assert.deepEqual(parseChangelog(body).Fixed, ['Fixed a long standing bug with tabs', 'Second item']);
});

test('matches headings case-insensitively and ignores unknown sections', () => {
  const body = [
    '## changelog entry (required)',
    '### ADDED',
    '- upper',
    '### Notes',
    '- ignored',
    '### security',
    '- patched',
  ].join('\n');
  const result = parseChangelog(body);
  assert.deepEqual(result.Added, ['upper']);
  assert.deepEqual(result.Security, ['patched']);
  assert.ok(!Object.values(result).flat().includes('ignored'));
});

test('ignores HTML comments in the template', () => {
  const body = ['## Changelog Entry', '### Added', '<!-- - describe here -->', '- real'].join('\n');
  assert.deepEqual(parseChangelog(body).Added, ['real']);
});

test('returns empty sections without a changelog block', () => {
  for (const body of [null, '', '## Summary\n- item']) {
    assert.equal(Object.values(parseChangelog(body)).flat().length, 0);
  }
});

test('detects breaking changes', () => {
  assert.ok(isBreaking({ title: 'x', body: '**Breaking Change:** Yes' }));
  assert.ok(isBreaking({ title: 'x', body: '**breaking change:**   yes' }));
  assert.ok(isBreaking({ title: 'x', body: 'BREAKING CHANGE: api removed' }));
  assert.ok(isBreaking({ title: 'feat(api)!: drop v1', body: '' }));
  assert.ok(isBreaking({ title: 'fix!: thing', body: null }));
  assert.ok(!isBreaking({ title: 'feat: thing', body: '**Breaking Change:** No' }));
  assert.ok(!isBreaking({ title: 'feat: thing', body: 'breaking change mentioned in lowercase' }));
});

test('aggregates and renders entries with pull request numbers', () => {
  const prs = [
    { number: 3, title: 'Add login', body: '## Changelog Entry\n### Added\n- Login' },
    { number: 5, title: 'fix!: crash', body: '## Changelog Entry\n### Fixed\n- Crash' },
  ];
  const agg = aggregate(prs);
  assert.equal(agg.total, 2);
  assert.equal(agg.breaking, true);
  assert.equal(renderSections(agg), '### Added\n\n- Login (#3)\n\n### Fixed\n\n- Crash (#5)');
  assert.equal(renderSections(agg, 2).split('\n')[0], '## Added');
  assert.equal(renderPullRequests(prs), '- #3 Add login\n- #5 fix!: crash');
});

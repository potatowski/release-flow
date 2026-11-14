'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gh = require('../src/github.cjs');
const { createFakeOctokit, mergedPr } = require('./fake-octokit.cjs');

const owner = 'acme';
const repo = 'app';

test('filterPullRequests keeps merged PRs in range and drops sync/deploy heads', () => {
  const prs = [
    mergedPr(1, { sha: 'a' }),
    mergedPr(2, { sha: 'zzz' }),
    { ...mergedPr(3, { sha: 'b' }), merged_at: null },
    mergedPr(4, { sha: 'c', head: 'dev', base: 'main' }),
    mergedPr(5, { sha: 'd', head: 'main', base: 'dev' }),
    mergedPr(6, { sha: 'e', base: 'main' }),
    mergedPr(7, { sha: 'f', head: 'dev', headRepo: 'someone/app' }),
  ];
  const kept = gh.filterPullRequests(prs, {
    shas: ['a', 'b', 'c', 'd', 'e', 'f'],
    excludeHeads: ['dev', 'main'],
    fullName: 'acme/app',
  });
  assert.deepEqual(kept.map((pr) => pr.number), [1, 6, 7]);
});

test('compareCommits follows pagination', async () => {
  const shas = Array.from({ length: 250 }, (_, i) => `s${i}`);
  const { octokit, calls } = createFakeOctokit({ compare: { 'main...dev': shas } });
  const result = await gh.compareCommits(octokit, { owner, repo, base: 'main', head: 'dev' });
  assert.equal(result.aheadBy, 250);
  assert.deepEqual(result.commits.map((c) => c.sha), shas);
  assert.equal(calls.length, 3);
});

test('listCommits stops at the cap', async () => {
  const commits = Array.from({ length: 2300 }, (_, i) => `c${i}`);
  const { octokit } = createFakeOctokit({ commits });
  const result = await gh.listCommits(octokit, { owner, repo, sha: 'head' });
  assert.equal(result.length, 2000);
});

test('findMergedPullRequests searches every base and dedupes', async () => {
  const { octokit } = createFakeOctokit({
    pulls: [mergedPr(2, { sha: 'b', base: 'main' }), mergedPr(1, { sha: 'a' }), mergedPr(9, { sha: 'x' })],
  });
  const prs = await gh.findMergedPullRequests(octokit, {
    owner,
    repo,
    bases: ['dev', 'main'],
    excludeHeads: ['dev', 'main'],
    commits: [{ sha: 'a' }, { sha: 'b' }],
  });
  assert.deepEqual(prs.map((pr) => pr.number), [1, 2]);
});

const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString();

function stalePulls(count, newestDay) {
  return Array.from({ length: count }, (_, i) => ({
    ...mergedPr(5000 + i, { sha: `x${i}` }),
    updated_at: day(newestDay - i / 10),
  }));
}

test('findMergedPullRequests stops once pull requests predate the range', async () => {
  const { octokit, calls } = createFakeOctokit({ pulls: stalePulls(500, 10) });
  const log = { warnings: [], warning(m) { this.warnings.push(m); } };
  await gh.findMergedPullRequests(octokit, {
    owner,
    repo,
    bases: ['dev'],
    excludeHeads: ['dev', 'main'],
    commits: [{ sha: 'nope', date: day(8) }],
    log,
  });
  assert.equal(calls.filter(([name]) => name === 'pulls.list').length, 1);
  assert.deepEqual(log.warnings, []);
});

test('findMergedPullRequests stops once every commit is matched', async () => {
  const { octokit, calls } = createFakeOctokit({ pulls: stalePulls(500, 10) });
  const prs = await gh.findMergedPullRequests(octokit, {
    owner,
    repo,
    bases: ['dev', 'main'],
    excludeHeads: ['dev', 'main'],
    commits: [{ sha: 'x3' }],
  });
  assert.deepEqual(prs.map((pr) => pr.number), [5003]);
  assert.equal(calls.length, 1);
});

test('findMergedPullRequests warns when the page cap is hit', async () => {
  const { octokit, calls } = createFakeOctokit({ pulls: stalePulls(1100, 1000) });
  const log = { warnings: [], warning(m) { this.warnings.push(m); } };
  await gh.findMergedPullRequests(octokit, {
    owner,
    repo,
    bases: ['dev'],
    excludeHeads: ['dev', 'main'],
    commits: [{ sha: 'nope', date: day(0) }],
    log,
  });
  assert.equal(calls.length, 10);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /after 10 pages/);
});

test('findLatestVersion uses the highest of release tags and repository tags', async () => {
  const fake = createFakeOctokit({ releases: [{ tag_name: 'v1.2.0' }], tags: ['v1.2.0', 'v1.3.0'] });
  assert.equal((await gh.findLatestVersion(fake.octokit, { owner, repo })).tag, 'v1.3.0');
});

test('getTagCommit resolves lightweight and annotated tags', async () => {
  const { octokit } = createFakeOctokit({
    refs: { 'tags/v1.0.0': 'c1', 'tags/v2.0.0': 'tagobj' },
    tagObjects: { tagobj: 'c2' },
  });
  assert.equal(await gh.getTagCommit(octokit, { owner, repo, tag: 'v1.0.0' }), 'c1');
  assert.equal(await gh.getTagCommit(octokit, { owner, repo, tag: 'v2.0.0' }), 'c2');
  assert.equal(await gh.getTagCommit(octokit, { owner, repo, tag: 'v3.0.0' }), null);
});

test('findLatestVersion ignores drafts and prereleases, falls back to tags', async () => {
  let fake = createFakeOctokit({
    releases: [
      { tag_name: 'v2.0.0', draft: true },
      { tag_name: 'v1.5.0', prerelease: true },
      { tag_name: 'v1.2.0' },
    ],
  });
  assert.equal((await gh.findLatestVersion(fake.octokit, { owner, repo })).tag, 'v1.2.0');

  fake = createFakeOctokit({ tags: ['v0.1.0', 'v0.3.0', 'latest'] });
  assert.equal((await gh.findLatestVersion(fake.octokit, { owner, repo })).tag, 'v0.3.0');

  fake = createFakeOctokit();
  assert.equal(await gh.findLatestVersion(fake.octokit, { owner, repo }), null);
});

test('upsertTagRef creates then updates', async () => {
  const { octokit, repo: state } = createFakeOctokit();
  assert.equal(await gh.upsertTagRef(octokit, { owner, repo, tag: 'v1', sha: 'a' }), 'created');
  assert.equal(await gh.upsertTagRef(octokit, { owner, repo, tag: 'v1', sha: 'b' }), 'updated');
  assert.equal(state.refs['tags/v1'], 'b');
});

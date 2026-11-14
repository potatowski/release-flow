'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPhase, runPrepare, runFinalize, DEPLOY_MARKER } = require('../src/phases.cjs');
const { createFakeOctokit, mergedPr } = require('./fake-octokit.cjs');

const inputs = { stagingBranch: 'dev', mainBranch: 'main', updateMajorTag: false };
const context = (sha = 'headsha') => ({ repo: { owner: 'acme', repo: 'app' }, ref: 'refs/heads/dev', sha });
const mainContext = () => ({ ...context(), ref: 'refs/heads/main' });
const entry = (section, text) => `## 📋 Changelog Entry\n\n### ${section}\n- ${text}\n`;

test('detectPhase maps refs and honours overrides', () => {
  const branches = { stagingBranch: 'dev', mainBranch: 'main' };
  assert.equal(detectPhase({ ref: 'refs/heads/dev', ...branches }), 'prepare');
  assert.equal(detectPhase({ ref: 'refs/heads/main', ...branches }), 'finalize');
  assert.equal(detectPhase({ ref: 'refs/heads/feature', ...branches }), null);
  assert.equal(detectPhase({ ref: 'refs/tags/v1.0.0', ...branches }), null);
  assert.equal(detectPhase({ override: 'Finalize', ref: 'refs/heads/dev', ...branches }), 'finalize');
  assert.throws(() => detectPhase({ override: 'deploy', ref: 'refs/heads/dev', ...branches }), /Invalid phase/);
});

test('prepare exits when staging is not ahead of main', async () => {
  const { octokit, calls } = createFakeOctokit();
  const result = await runPrepare({ octokit, context: context(), inputs });
  assert.equal(result.status, 'skipped');
  assert.ok(!calls.some(([name]) => name.startsWith('pulls.')));
});

test('prepare creates the deploy pull request', async () => {
  const { octokit, repo } = createFakeOctokit({
    compare: { 'main...dev': ['a', 'b', 'sync'] },
    releases: [{ tag_name: 'v0.1.0' }],
    pulls: [
      mergedPr(10, { sha: 'a', title: 'Add search', body: entry('Added', 'Search page') }),
      mergedPr(11, { sha: 'b', title: 'Fix crash', body: entry('Fixed', 'Crash on load') }),
      mergedPr(12, { sha: 'sync', head: 'main', base: 'dev', body: entry('Added', 'Should not appear') }),
      mergedPr(13, { sha: 'old', body: entry('Added', 'Already deployed') }),
    ],
  });

  const result = await runPrepare({ octokit, context: context(), inputs });

  assert.equal(result.status, 'created');
  assert.equal(result.nextVersion, 'v0.2.0');
  const pr = repo.pulls.find((p) => p.number === result.pullRequest);
  assert.equal(pr.title, 'Deploy to production');
  assert.equal(pr.head.ref, 'dev');
  assert.equal(pr.base.ref, 'main');
  assert.ok(pr.body.startsWith(`${DEPLOY_MARKER}\n\n# Deploy to production — v0.2.0`));
  assert.match(pr.body, /2 pull requests/);
  assert.match(pr.body, /\*\*minor\*\*/);
  assert.match(pr.body, /## Changelog Entry\n\n### Added\n\n- Search page \(#10\)\n\n### Fixed\n\n- Crash on load \(#11\)/);
  assert.match(pr.body, /## Pull Requests\n\n- #10 Add search\n- #11 Fix crash/);
  assert.doesNotMatch(pr.body, /Should not appear|Already deployed/);
});

test('prepare updates the existing deploy pull request', async () => {
  const { octokit, calls } = createFakeOctokit({
    compare: { 'main...dev': ['a'] },
    pulls: [
      mergedPr(10, { sha: 'a', body: entry('Fixed', 'Bug') }),
      { number: 7, state: 'open', title: 'old', body: 'old', head: { ref: 'dev' }, base: { ref: 'main' } },
    ],
  });

  const result = await runPrepare({ octokit, context: context(), inputs });

  assert.equal(result.status, 'updated');
  assert.equal(result.pullRequest, 7);
  assert.equal(result.nextVersion, 'v0.0.1');
  assert.ok(calls.some(([name, p]) => name === 'pulls.update' && p.pull_number === 7));
  assert.ok(!calls.some(([name]) => name === 'pulls.create'));
});

test('prepare without entries still opens the PR but projects no version', async () => {
  const { octokit } = createFakeOctokit({
    compare: { 'main...dev': ['a'] },
    pulls: [mergedPr(10, { sha: 'a', body: 'no template' })],
  });
  const result = await runPrepare({ octokit, context: context(), inputs });
  assert.equal(result.nextVersion, '');
  assert.match(result.body, /will not create a release/);
});

test('finalize creates a release from PRs since the latest tag', async () => {
  const { octokit, repo, calls } = createFakeOctokit({
    releases: [{ tag_name: 'v1.2.3' }],
    compare: { 'v1.2.3...headsha': ['a', 'b', 'deploy'] },
    pulls: [
      mergedPr(20, { sha: 'a', title: 'feat(api)!: drop v1', body: entry('Removed', 'v1 API') }),
      mergedPr(21, { sha: 'b', body: entry('Added', 'v2 API') }),
      mergedPr(22, { sha: 'deploy', head: 'dev', base: 'main', body: entry('Added', 'Deploy body') }),
    ],
  });

  const result = await runFinalize({ octokit, context: mainContext(), inputs });

  assert.equal(result.status, 'created');
  assert.equal(result.nextVersion, 'v2.0.0');
  const release = repo.releases.find((r) => r.tag_name === 'v2.0.0');
  assert.equal(release.name, 'v2.0.0');
  assert.equal(release.target_commitish, 'headsha');
  assert.equal(
    release.body,
    '## Added\n\n- v2 API (#21)\n\n## Removed\n\n- v1 API (#20)\n\n## Pull Requests\n\n- #20 feat(api)!: drop v1\n- #21 PR 21\n',
  );
  assert.ok(!calls.some(([name]) => name === 'git.createRef' || name === 'git.updateRef'));
});

test('finalize without tags walks the commit history', async () => {
  const { octokit, calls } = createFakeOctokit({
    commits: ['headsha', 'a'],
    pulls: [mergedPr(1, { sha: 'a', base: 'main', body: entry('Added', 'First') })],
  });
  const result = await runFinalize({ octokit, context: mainContext(), inputs });
  assert.equal(result.nextVersion, 'v0.1.0');
  assert.ok(calls.some(([name, p]) => name === 'repos.listCommits' && p.sha === 'headsha'));
});

test('finalize without tags starts from the since input when given', async () => {
  const { octokit, calls } = createFakeOctokit({
    compare: { 'abc123...headsha': ['a'] },
    pulls: [mergedPr(1, { sha: 'a', base: 'main', body: entry('Fixed', 'Bug') })],
  });
  const result = await runFinalize({ octokit, context: mainContext(), inputs: { ...inputs, since: 'abc123' } });
  assert.equal(result.nextVersion, 'v0.0.1');
  assert.ok(!calls.some(([name]) => name === 'repos.listCommits'));
});

test('finalize exits when there is nothing to release', async () => {
  const { octokit, calls } = createFakeOctokit({
    releases: [{ tag_name: 'v1.0.0' }],
    compare: { 'v1.0.0...headsha': ['a'] },
    pulls: [mergedPr(1, { sha: 'a', body: entry('Fixed', '-') })],
  });
  const result = await runFinalize({ octokit, context: mainContext(), inputs });
  assert.equal(result.status, 'skipped');
  assert.ok(!calls.some(([name]) => name === 'repos.createRelease'));
});

test('finalize is idempotent when the release already exists', async () => {
  const { octokit, calls } = createFakeOctokit({
    releases: [{ tag_name: 'v1.0.0' }, { tag_name: 'v1.0.1', prerelease: true }],
    compare: { 'v1.0.0...headsha': ['a'] },
    pulls: [mergedPr(1, { sha: 'a', body: entry('Fixed', 'Bug') })],
  });
  const result = await runFinalize({ octokit, context: mainContext(), inputs });
  assert.equal(result.status, 'exists');
  assert.ok(!calls.some(([name]) => name === 'repos.createRelease'));
});

test('finalize moves the major tag only when enabled', async () => {
  const setup = () =>
    createFakeOctokit({
      releases: [{ tag_name: 'v1.0.0' }],
      compare: { 'v1.0.0...headsha': ['a'] },
      pulls: [mergedPr(1, { sha: 'a', body: entry('Added', 'Thing') })],
      refs: { 'tags/v1': 'oldsha' },
    });

  let fake = setup();
  await runFinalize({ octokit: fake.octokit, context: mainContext(), inputs });
  assert.equal(fake.repo.refs['tags/v1'], 'oldsha');

  fake = setup();
  await runFinalize({ octokit: fake.octokit, context: mainContext(), inputs: { ...inputs, updateMajorTag: true } });
  assert.equal(fake.repo.refs['tags/v1'], 'headsha');
});

test('finalize refuses when the tag already points at another commit', async () => {
  const { octokit, calls } = createFakeOctokit({
    releases: [{ tag_name: 'v1.0.0' }],
    compare: { 'v1.0.0...headsha': ['a'] },
    pulls: [mergedPr(1, { sha: 'a', body: entry('Fixed', 'Bug') })],
    refs: { 'tags/v1.0.1': 'othersha' },
  });
  await assert.rejects(runFinalize({ octokit, context: mainContext(), inputs }), /v1\.0\.1 already exists at othersha/);
  assert.ok(!calls.some(([name]) => name === 'repos.createRelease'));
});

test('finalize creates the release for an existing tag at the same commit', async () => {
  const { octokit, repo } = createFakeOctokit({
    releases: [{ tag_name: 'v1.0.0' }],
    compare: { 'v1.0.0...headsha': ['a'] },
    pulls: [mergedPr(1, { sha: 'a', body: entry('Fixed', 'Bug') })],
    refs: { 'tags/v1.0.1': 'headsha' },
  });
  const result = await runFinalize({ octokit, context: mainContext(), inputs });
  assert.equal(result.status, 'created');
  assert.ok(repo.releases.some((r) => r.tag_name === 'v1.0.1'));
});

test('forced finalize from another ref releases the main branch head', async () => {
  const { octokit, repo } = createFakeOctokit({
    releases: [{ tag_name: 'v1.0.0' }],
    refs: { 'heads/main': 'mainhead' },
    compare: { 'v1.0.0...mainhead': ['a'] },
    pulls: [mergedPr(1, { sha: 'a', body: entry('Fixed', 'Bug') })],
  });
  const result = await runFinalize({ octokit, context: context('devsha'), inputs });
  assert.equal(result.status, 'created');
  assert.equal(repo.releases.find((r) => r.tag_name === 'v1.0.1').target_commitish, 'mainhead');
});

'use strict';

const changelog = require('./changelog.cjs');
const version = require('./version.cjs');
const gh = require('./github.cjs');

const DEPLOY_MARKER = '<!-- release-flow:deploy -->';
const DEPLOY_TITLE = 'Deploy to production';
const PHASES = ['prepare', 'finalize'];

const silentLog = { info() {}, warning() {} };

/**
 * Resolves the phase from an explicit override or from the pushed ref.
 * Returns null when the ref does not match either branch.
 */
function detectPhase({ override, ref, stagingBranch, mainBranch }) {
  const explicit = String(override || '').trim().toLowerCase();
  if (explicit) {
    if (!PHASES.includes(explicit)) {
      throw new Error(`Invalid phase "${override}". Expected one of: ${PHASES.join(', ')}`);
    }
    return explicit;
  }
  if (ref === `refs/heads/${stagingBranch}`) return 'prepare';
  if (ref === `refs/heads/${mainBranch}`) return 'finalize';
  return null;
}

/**
 * Computes the release plan for the pull requests merged in `shas`.
 */
async function plan(octokit, { owner, repo, inputs, shas, latest }) {
  const prs = await gh.findMergedPullRequests(octokit, {
    owner,
    repo,
    bases: [inputs.stagingBranch, inputs.mainBranch],
    excludeHeads: [inputs.stagingBranch, inputs.mainBranch],
    shas,
  });
  const agg = changelog.aggregate(prs);
  const current = latest ? latest.version : version.ZERO;
  const bump = version.decideBump(
    { breaking: agg.breaking, added: agg.sections.Added.length > 0, total: agg.total },
    current,
  );
  const next = bump ? `v${version.format(version.bump(current, bump.type))}` : null;
  return { prs, agg, current, bump, next };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function renderDeployBody({ prs, agg, current, bump, next }) {
  const parts = [DEPLOY_MARKER, next ? `# ${DEPLOY_TITLE} — ${next}` : `# ${DEPLOY_TITLE}`];

  const included = `This deploy includes ${plural(prs.length, 'pull request')}.`;
  if (bump) {
    parts.push(
      `${included} Version bump: **${bump.type}** (${bump.reason}), from v${version.format(current)} to ${next}.`,
    );
    parts.push(`## Changelog Entry\n\n${changelog.renderSections(agg, 3)}`);
  } else {
    parts.push(`${included} No changelog entries were found, so merging will not create a release.`);
  }

  if (prs.length > 0) {
    parts.push(`## Pull Requests\n\n${changelog.renderPullRequests(prs)}`);
  }
  return `${parts.join('\n\n')}\n`;
}

/**
 * Staging push: opens or updates the deploy pull request (staging -> main).
 */
async function runPrepare({ octokit, context, inputs, log = silentLog }) {
  const { owner, repo } = context.repo;
  const { stagingBranch, mainBranch } = inputs;

  const range = await gh.compareCommits(octokit, {
    owner,
    repo,
    base: mainBranch,
    head: stagingBranch,
  });
  if (range.aheadBy === 0 || range.shas.length === 0) {
    log.info(`${stagingBranch} has no commits ahead of ${mainBranch}; nothing to deploy.`);
    return { status: 'skipped' };
  }

  const latest = await gh.findLatestVersion(octokit, { owner, repo });
  const result = await plan(octokit, { owner, repo, inputs, shas: range.shas, latest });
  const body = renderDeployBody(result);

  const existing = await gh.findOpenPullRequest(octokit, {
    owner,
    repo,
    head: stagingBranch,
    base: mainBranch,
  });

  let pr;
  if (existing) {
    ({ data: pr } = await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: existing.number,
      title: DEPLOY_TITLE,
      body,
    }));
    log.info(`Updated deploy pull request #${pr.number}.`);
  } else {
    ({ data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      head: stagingBranch,
      base: mainBranch,
      title: DEPLOY_TITLE,
      body,
    }));
    log.info(`Opened deploy pull request #${pr.number}.`);
  }

  return {
    status: existing ? 'updated' : 'created',
    nextVersion: result.next || '',
    body,
    pullRequest: pr.number,
  };
}

function renderReleaseBody({ prs, agg }) {
  return `${changelog.renderSections(agg, 2)}\n\n## Pull Requests\n\n${changelog.renderPullRequests(prs)}\n`;
}

/**
 * Main push: publishes a release for the pull requests merged since the
 * latest version tag.
 */
async function runFinalize({ octokit, context, inputs, log = silentLog }) {
  const { owner, repo } = context.repo;
  const sha = context.sha;

  const latest = await gh.findLatestVersion(octokit, { owner, repo });
  const shas = latest
    ? (await gh.compareCommits(octokit, { owner, repo, base: latest.tag, head: sha })).shas
    : await gh.listCommitShas(octokit, { owner, repo, sha });

  const result = await plan(octokit, { owner, repo, inputs, shas, latest });
  if (!result.bump) {
    log.info('No changelog entries since the latest release; nothing to release.');
    return { status: 'skipped' };
  }

  const tag = result.next;
  const body = renderReleaseBody(result);

  if (await gh.getReleaseByTag(octokit, { owner, repo, tag })) {
    log.info(`Release ${tag} already exists; nothing to do.`);
    return { status: 'exists', nextVersion: tag, body };
  }

  await octokit.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    name: tag,
    target_commitish: sha,
    body,
  });
  log.info(`Created release ${tag} (${result.bump.type}: ${result.bump.reason}).`);

  if (inputs.updateMajorTag) {
    const major = tag.split('.')[0];
    const action = await gh.upsertTagRef(octokit, { owner, repo, tag: major, sha });
    log.info(`Major tag ${major} ${action} at ${sha}.`);
  }

  return { status: 'created', nextVersion: tag, body };
}

module.exports = {
  DEPLOY_MARKER,
  DEPLOY_TITLE,
  detectPhase,
  plan,
  renderDeployBody,
  renderReleaseBody,
  runPrepare,
  runFinalize,
};

'use strict';

const { latestTag } = require('./version.cjs');

const PER_PAGE = 100;
const MAX_PR_PAGES = 10;
const MAX_COMPARE_PAGES = 100;
const MAX_LIST_PAGES = 10;

/**
 * Lists the commits of `base...head`, following compare pagination.
 * Returns { aheadBy, shas }.
 */
async function compareCommits(octokit, { owner, repo, base, head }) {
  const shas = [];
  let aheadBy = 0;
  for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
      per_page: PER_PAGE,
      page,
    });
    aheadBy = data.ahead_by;
    const commits = data.commits || [];
    for (const commit of commits) shas.push(commit.sha);
    if (commits.length < PER_PAGE || shas.length >= (data.total_commits || 0)) break;
  }
  return { aheadBy, shas };
}

/**
 * Lists commit SHAs reachable from `sha`, newest first, up to `cap`.
 */
async function listCommitShas(octokit, { owner, repo, sha, cap = 2000 }) {
  const shas = [];
  for (let page = 1; shas.length < cap; page += 1) {
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha,
      per_page: PER_PAGE,
      page,
    });
    for (const commit of data) shas.push(commit.sha);
    if (data.length < PER_PAGE) break;
  }
  return shas.slice(0, cap);
}

function isSameRepo(pr, fullName) {
  return Boolean(pr.head && pr.head.repo && pr.head.repo.full_name === fullName);
}

/**
 * Keeps merged pull requests whose merge commit is in `shas`, dropping those
 * opened from one of `excludeHeads` in this repository (deploy and sync
 * pull requests). Fork branches with the same names are kept.
 */
function filterPullRequests(prs, { shas, excludeHeads, fullName }) {
  const shaSet = shas instanceof Set ? shas : new Set(shas);
  return prs.filter(
    (pr) =>
      pr.merged_at &&
      pr.merge_commit_sha &&
      shaSet.has(pr.merge_commit_sha) &&
      !(excludeHeads.includes(pr.head && pr.head.ref) && isSameRepo(pr, fullName)),
  );
}

/**
 * Finds merged pull requests targeting any of `bases` whose merge commit
 * is in `shas`. Returns them deduplicated and sorted by number.
 */
async function findMergedPullRequests(octokit, { owner, repo, bases, excludeHeads, shas }) {
  const shaSet = new Set(shas);
  const found = new Map();
  const fullName = `${owner}/${repo}`;
  for (const base of bases) {
    for (let page = 1; page <= MAX_PR_PAGES; page += 1) {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        base,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: PER_PAGE,
        page,
      });
      for (const pr of filterPullRequests(data, { shas: shaSet, excludeHeads, fullName })) {
        found.set(pr.number, pr);
      }
      if (data.length < PER_PAGE) break;
    }
  }
  return [...found.values()].sort((a, b) => a.number - b.number);
}

async function listNames(fetchPage, pick) {
  const names = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const { data } = await fetchPage(page);
    for (const item of data) {
      const name = pick(item);
      if (name) names.push(name);
    }
    if (data.length < PER_PAGE) break;
  }
  return names;
}

/**
 * Returns the highest `vX.Y.Z` among published releases (no drafts or
 * prereleases), falling back to the tags list. Null when none exists.
 */
async function findLatestVersion(octokit, { owner, repo }) {
  const releaseTags = await listNames(
    (page) => octokit.rest.repos.listReleases({ owner, repo, per_page: PER_PAGE, page }),
    (release) => (release.draft || release.prerelease ? null : release.tag_name),
  );
  const fromReleases = latestTag(releaseTags);
  if (fromReleases) return fromReleases;

  const tags = await listNames(
    (page) => octokit.rest.repos.listTags({ owner, repo, per_page: PER_PAGE, page }),
    (tag) => tag.name,
  );
  return latestTag(tags);
}

async function getReleaseByTag(octokit, { owner, repo, tag }) {
  try {
    const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
    return data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function findOpenPullRequest(octokit, { owner, repo, head, base }) {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: 'open',
    head: `${owner}:${head}`,
    base,
    per_page: PER_PAGE,
  });
  return data.find((pr) => pr.head.ref === head && pr.base.ref === base) || null;
}

/**
 * Points `refs/tags/<tag>` at `sha`, creating the ref if it does not exist.
 */
async function upsertTagRef(octokit, { owner, repo, tag, sha }) {
  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
  } catch (error) {
    if (error.status !== 404) throw error;
    await octokit.rest.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha });
    return 'created';
  }
  await octokit.rest.git.updateRef({ owner, repo, ref: `tags/${tag}`, sha, force: true });
  return 'updated';
}

module.exports = {
  compareCommits,
  listCommitShas,
  filterPullRequests,
  findMergedPullRequests,
  findLatestVersion,
  getReleaseByTag,
  findOpenPullRequest,
  upsertTagRef,
};

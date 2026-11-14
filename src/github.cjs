'use strict';

const { latestTag } = require('./version.cjs');

const PER_PAGE = 100;
const MAX_PR_PAGES = 10;
const MAX_COMPARE_PAGES = 100;
const MAX_LIST_PAGES = 10;

const toCommit = (commit) => ({
  sha: commit.sha,
  date: (commit.commit && commit.commit.committer && commit.commit.committer.date) || null,
});

/**
 * Lists the commits of `base...head`, following compare pagination.
 * Returns { aheadBy, commits } where each commit is { sha, date }.
 */
async function compareCommits(octokit, { owner, repo, base, head }) {
  const commits = [];
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
    const batch = data.commits || [];
    commits.push(...batch.map(toCommit));
    if (batch.length < PER_PAGE || commits.length >= (data.total_commits || 0)) break;
  }
  return { aheadBy, commits };
}

/**
 * Lists commits reachable from `sha`, newest first, up to `cap`.
 */
async function listCommits(octokit, { owner, repo, sha, cap = 2000 }) {
  const commits = [];
  for (let page = 1; commits.length < cap; page += 1) {
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      sha,
      per_page: PER_PAGE,
      page,
    });
    commits.push(...data.map(toCommit));
    if (data.length < PER_PAGE) break;
  }
  return commits.slice(0, cap);
}

/**
 * Oldest committer date among `commits`, or null when unknown.
 */
function oldestDate(commits) {
  let oldest = null;
  for (const { date } of commits) {
    if (!date) return null;
    const time = Date.parse(date);
    if (oldest === null || time < oldest) oldest = time;
  }
  return oldest;
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
 * is in `commits`. Returns them deduplicated and sorted by number.
 *
 * Closed pull requests are scanned newest-updated first, so the scan stops
 * once every commit is matched or once pull requests were last updated
 * before the oldest commit in the range.
 */
async function findMergedPullRequests(octokit, { owner, repo, bases, excludeHeads, commits, log }) {
  const shaSet = new Set(commits.map((commit) => commit.sha));
  const unmatched = new Set(shaSet);
  const cutoff = oldestDate(commits);
  const found = new Map();
  const fullName = `${owner}/${repo}`;

  for (const base of bases) {
    for (let page = 1; page <= MAX_PR_PAGES && unmatched.size > 0; page += 1) {
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
      for (const pr of data) {
        if (pr.merged_at) unmatched.delete(pr.merge_commit_sha);
      }

      if (data.length < PER_PAGE) break;
      const last = data[data.length - 1];
      if (cutoff !== null && last.updated_at && Date.parse(last.updated_at) < cutoff) break;
      if (page === MAX_PR_PAGES && log) {
        log.warning(
          `Stopped scanning closed pull requests into ${base} after ${MAX_PR_PAGES} pages; older pull requests may be missing.`,
        );
      }
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
 * Returns the highest `vX.Y.Z` among published release tags (no drafts or
 * prereleases) and repository tags. Null when none exists.
 */
async function findLatestVersion(octokit, { owner, repo }) {
  const releaseTags = await listNames(
    (page) => octokit.rest.repos.listReleases({ owner, repo, per_page: PER_PAGE, page }),
    (release) => (release.draft || release.prerelease ? null : release.tag_name),
  );
  const tags = await listNames(
    (page) => octokit.rest.repos.listTags({ owner, repo, per_page: PER_PAGE, page }),
    (tag) => tag.name,
  );
  return latestTag([...releaseTags, ...tags]);
}

/**
 * Returns the commit SHA a tag points at (dereferencing annotated tags),
 * or null when the tag does not exist.
 */
async function getTagCommit(octokit, { owner, repo, tag }) {
  let object;
  try {
    ({ data: { object } } = await octokit.rest.git.getRef({ owner, repo, ref: `tags/${tag}` }));
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  if (object.type === 'tag') {
    const { data } = await octokit.rest.git.getTag({ owner, repo, tag_sha: object.sha });
    return data.object.sha;
  }
  return object.sha;
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
  listCommits,
  filterPullRequests,
  findMergedPullRequests,
  findLatestVersion,
  getTagCommit,
  getReleaseByTag,
  findOpenPullRequest,
  upsertTagRef,
};

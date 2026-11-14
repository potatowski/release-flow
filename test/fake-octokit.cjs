'use strict';

function notFound() {
  const error = new Error('Not Found');
  error.status = 404;
  return error;
}

function toApiCommit(item) {
  if (typeof item === 'string') return { sha: item };
  return { sha: item.sha, commit: { committer: { date: item.date } } };
}

function page(items, { page = 1, per_page = 30 }) {
  return items.slice((page - 1) * per_page, page * per_page);
}

/**
 * Minimal in-memory stand-in for the Octokit REST methods the action uses.
 * Every call is recorded in `calls` as [method, params].
 */
function createFakeOctokit(state = {}) {
  const repo = {
    compare: {},
    commits: [],
    pulls: [],
    releases: [],
    tags: [],
    refs: {},
    tagObjects: {},
    ...state,
  };
  const calls = [];
  const record = (name, fn) => async (params) => {
    calls.push([name, params]);
    return fn(params);
  };
  let nextNumber = 1000;

  const octokit = {
    rest: {
      repos: {
        compareCommitsWithBasehead: record('repos.compareCommitsWithBasehead', (params) => {
          const shas = repo.compare[params.basehead] || [];
          return {
            data: {
              ahead_by: shas.length,
              total_commits: shas.length,
              commits: page(shas, params).map(toApiCommit),
            },
          };
        }),
        listCommits: record('repos.listCommits', (params) => ({
          data: page(repo.commits, params).map(toApiCommit),
        })),
        listReleases: record('repos.listReleases', (params) => ({
          data: page(repo.releases, params),
        })),
        listTags: record('repos.listTags', (params) => ({
          data: page(repo.tags.map((name) => ({ name })), params),
        })),
        getReleaseByTag: record('repos.getReleaseByTag', ({ tag }) => {
          const release = repo.releases.find((r) => r.tag_name === tag);
          if (!release) throw notFound();
          return { data: release };
        }),
        createRelease: record('repos.createRelease', (params) => {
          const release = { ...params, draft: false, prerelease: false };
          repo.releases.push(release);
          return { data: release };
        }),
      },
      pulls: {
        list: record('pulls.list', (params) => {
          let prs = repo.pulls.filter((pr) => pr.state === params.state);
          if (params.base) prs = prs.filter((pr) => pr.base.ref === params.base);
          if (params.head) prs = prs.filter((pr) => `${params.owner}:${pr.head.ref}` === params.head);
          return { data: page(prs, params) };
        }),
        create: record('pulls.create', (params) => {
          const pr = {
            number: (nextNumber += 1),
            state: 'open',
            title: params.title,
            body: params.body,
            head: { ref: params.head },
            base: { ref: params.base },
          };
          repo.pulls.push(pr);
          return { data: pr };
        }),
        update: record('pulls.update', (params) => {
          const pr = repo.pulls.find((p) => p.number === params.pull_number);
          Object.assign(pr, { title: params.title, body: params.body });
          return { data: pr };
        }),
      },
      git: {
        getRef: record('git.getRef', ({ ref }) => {
          if (!repo.refs[ref]) throw notFound();
          const sha = repo.refs[ref];
          const type = repo.tagObjects[sha] ? 'tag' : 'commit';
          return { data: { ref: `refs/${ref}`, object: { sha, type } } };
        }),
        getTag: record('git.getTag', ({ tag_sha }) => ({
          data: { sha: tag_sha, object: { sha: repo.tagObjects[tag_sha], type: 'commit' } },
        })),
        createRef: record('git.createRef', ({ ref, sha }) => {
          repo.refs[ref.replace(/^refs\//, '')] = sha;
          return { data: {} };
        }),
        updateRef: record('git.updateRef', ({ ref, sha }) => {
          repo.refs[ref] = sha;
          return { data: {} };
        }),
      },
    },
  };

  return { octokit, repo, calls };
}

function mergedPr(
  number,
  { base = 'dev', head = `feature-${number}`, sha = `m${number}`, title, body = '', headRepo = 'acme/app' } = {},
) {
  return {
    number,
    state: 'closed',
    title: title || `PR ${number}`,
    body,
    merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: sha,
    head: { ref: head, repo: { full_name: headRepo } },
    base: { ref: base },
  };
}

module.exports = { createFakeOctokit, mergedPr };

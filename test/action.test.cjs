'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAction } = require('../src/action.cjs');

const BROKER = 'https://broker.example/token';

function fakeCore(inputs = {}) {
  const record = { info: [], warning: [], outputs: {}, failed: null, secrets: [], idCalls: 0 };
  const core = {
    getInput: (name) => inputs[name] || '',
    info: (msg) => record.info.push(msg),
    warning: (msg) => record.warning.push(msg),
    setOutput: (name, value) => { record.outputs[name] = value; },
    setFailed: (msg) => { record.failed = msg; },
    setSecret: (value) => record.secrets.push(value),
    getIDToken: async () => { record.idCalls += 1; return 'jwt'; },
  };
  return { core, record };
}

function fakeGithub(ref) {
  const tokens = [];
  return {
    tokens,
    github: {
      context: { ref, repo: { owner: 'acme', repo: 'app' }, sha: 'headsha' },
      getOctokit: (token) => { tokens.push(token); return { fake: true }; },
    },
  };
}

function fakePhases(result = { nextVersion: 'v1.2.0', body: 'notes' }) {
  const runs = [];
  return {
    runs,
    phases: {
      detectPhase: require('../src/phases.cjs').detectPhase,
      runPrepare: async (args) => { runs.push(['prepare', args]); return result; },
      runFinalize: async (args) => { runs.push(['finalize', args]); return result; },
    },
  };
}

function fakeFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ token: 'ghs_x' }), { status: 200 });
  };
  return { fetch, calls };
}

const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_API_URL: 'https://api.github.com' };

test('does not request a token for unrelated refs', async () => {
  const { core, record } = fakeCore({ token_broker_url: BROKER });
  const { github, tokens } = fakeGithub('refs/heads/feature');
  const { fetch, calls } = fakeFetch();
  await runAction({ core, github, env, fetch, phases: fakePhases().phases });
  assert.equal(record.idCalls, 0);
  assert.equal(calls.length, 0);
  assert.equal(tokens.length, 0);
  assert.equal(record.failed, null);
});

test('uses the broker token, masks it and revokes it', async () => {
  const { core, record } = fakeCore({ token_broker_url: BROKER });
  const { github, tokens } = fakeGithub('refs/heads/dev');
  const { fetch, calls } = fakeFetch();
  const { phases, runs } = fakePhases();
  await runAction({ core, github, env, fetch, phases });

  assert.deepEqual(tokens, ['ghs_x']);
  assert.deepEqual(record.secrets, ['ghs_x']);
  assert.ok(record.info.includes('Using Changelog Release Flow app token.'));
  assert.equal(runs[0][0], 'prepare');
  assert.deepEqual(record.outputs, { next_version: 'v1.2.0', release_body: 'notes' });
  assert.deepEqual(calls, [
    { url: BROKER, method: 'POST' },
    { url: 'https://api.github.com/installation/token', method: 'DELETE' },
  ]);
});

test('revokes the broker token even when the phase fails', async () => {
  const { core, record } = fakeCore({ token_broker_url: BROKER });
  const { github } = fakeGithub('refs/heads/main');
  const { fetch, calls } = fakeFetch();
  const phases = {
    ...fakePhases().phases,
    runFinalize: async () => { throw new Error('tag points elsewhere'); },
  };
  await runAction({ core, github, env, fetch, phases });
  assert.equal(record.failed, 'tag points elsewhere');
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('keeps the given github_token and never revokes it', async () => {
  const { core, record } = fakeCore({ github_token: 'ghp_own', token_broker_url: BROKER });
  const { github, tokens } = fakeGithub('refs/heads/dev');
  const { fetch, calls } = fakeFetch();
  await runAction({ core, github, env, fetch, phases: fakePhases().phases });
  assert.deepEqual(tokens, ['ghp_own']);
  assert.equal(record.idCalls, 0);
  assert.equal(calls.length, 0);
});

test('reports token resolution failures', async () => {
  const { core, record } = fakeCore({ token_broker_url: BROKER });
  const { github } = fakeGithub('refs/heads/dev');
  const ghes = { ...env, GITHUB_SERVER_URL: 'https://ghe.acme.com' };
  await runAction({ core, github, env: ghes, fetch: fakeFetch().fetch, phases: fakePhases().phases });
  assert.match(record.failed, /only supports github\.com/);
});

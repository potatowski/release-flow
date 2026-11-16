import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.js';
import { InvalidTokenError, EventNotAllowedError } from '../src/oidc.js';
import { NotInstalledError, GitHubApiError } from '../src/github-app.js';

const JWT = 'header.payload.signature';
const claims = { repository: 'acme/app', repositoryId: '123', owner: 'acme', repo: 'app' };

function deps({ verify, mintToken } = {}) {
  return {
    verify: verify || (async () => claims),
    mintToken: mintToken || (async () => ({ token: 'ghs_x', expiresAt: '2026-11-16T13:00:00Z' })),
    appSlug: 'release-flow',
  };
}

function request(path = '/token', { method = 'POST', auth = `Bearer ${JWT}` } = {}) {
  const headers = auth ? { Authorization: auth } : {};
  return new Request(`https://broker.example${path}`, { method, headers });
}

async function send(req, d = deps()) {
  const response = await handleRequest(req, d);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.json() };
}

test('rejects other methods', async () => {
  assert.deepEqual(await send(request('/token', { method: 'GET' })), {
    status: 405,
    body: { error: 'Method not allowed' },
  });
});

test('rejects other paths', async () => {
  assert.deepEqual(await send(request('/other')), { status: 404, body: { error: 'Not found' } });
});

test('requires a bearer token', async () => {
  const expected = { status: 400, body: { error: 'Missing bearer token' } };
  assert.deepEqual(await send(request('/token', { auth: null })), expected);
  assert.deepEqual(await send(request('/token', { auth: 'Basic abc' })), expected);
});

test('maps invalid OIDC tokens to 401', async () => {
  const d = deps({ verify: async () => { throw new InvalidTokenError('bad'); } });
  assert.deepEqual(await send(request(), d), { status: 401, body: { error: 'Invalid OIDC token' } });
});

test('maps missing installations to 403 with the install link', async () => {
  const d = deps({ mintToken: async () => { throw new NotInstalledError('nope'); } });
  const { status, body } = await send(request(), d);
  assert.equal(status, 403);
  assert.match(body.error, /acme\/app/);
  assert.match(body.error, /https:\/\/github\.com\/apps\/release-flow\/installations\/new/);
});

test('maps GitHub API failures to 502', async () => {
  const d = deps({ mintToken: async () => { throw new GitHubApiError(500); } });
  assert.deepEqual(await send(request(), d), { status: 502, body: { error: 'GitHub API error (500)' } });
});

test('maps unexpected failures to 500', async () => {
  const d = deps({ mintToken: async () => { throw new TypeError('boom'); } });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await send(request(), d), { status: 500, body: { error: 'Internal error' } });
  } finally {
    console.error = originalError;
  }
});

test('returns the installation token', async () => {
  let seen;
  const d = deps({ verify: async (jwt) => { seen = jwt; return claims; } });
  assert.deepEqual(await send(request(), d), {
    status: 200,
    body: { token: 'ghs_x', expires_at: '2026-11-16T13:00:00Z' },
  });
  assert.equal(seen, JWT);
});

test('never echoes the bearer token', async () => {
  const failures = [
    deps({ verify: async () => { throw new InvalidTokenError(JWT); } }),
    deps({ mintToken: async () => { throw new NotInstalledError(JWT); } }),
  ];
  for (const d of failures) {
    const { body } = await send(request(), d);
    assert.ok(!JSON.stringify(body).includes(JWT));
  }
});

test('explains rejected events with 403', async () => {
  const d = deps({ verify: async () => { throw new EventNotAllowedError('pull_request_target'); } });
  const { status, body } = await send(request(), d);
  assert.equal(status, 403);
  assert.match(body.error, /pull_request_target/);
  assert.match(body.error, /push, workflow_dispatch, schedule/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { jwtVerify } from 'jose';
import {
  createAppJwt,
  createInstallationToken,
  NotInstalledError,
  GitHubApiError,
} from '../src/github-app.js';
import { createTestKeys } from './keys.js';

const keys = await createTestKeys();

/**
 * Fake fetch answering by "METHOD /path". Records every call.
 */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: pathname, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const route = routes[`${method} ${pathname}`] || { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

const installed = {
  'GET /repos/acme/app/installation': { status: 200, body: { id: 42 } },
  'POST /app/installations/42/access_tokens': {
    status: 201,
    body: { token: 'ghs_x', expires_at: '2026-11-16T13:00:00Z' },
  },
};
const mint = (fetch) =>
  createInstallationToken({ owner: 'acme', repo: 'app', repositoryId: '123', appJwt: 'app.jwt', fetch });

test('createAppJwt signs with the client id', async () => {
  const jwt = await createAppJwt({ clientId: 'Iv1.test', privateKeyPem: keys.privateKeyPem });
  const { payload, protectedHeader } = await jwtVerify(jwt, keys.publicKey);
  assert.equal(protectedHeader.alg, 'RS256');
  assert.equal(payload.iss, 'Iv1.test');
  assert.equal(payload.exp - payload.iat, 600);
  assert.ok(payload.iat <= Math.floor(Date.now() / 1000) - 59);
});

test('createAppJwt rejects PKCS#1 keys with a conversion hint', async () => {
  await assert.rejects(
    createAppJwt({ clientId: 'Iv1.test', privateKeyPem: keys.pkcs1Pem }),
    /openssl pkcs8 -topk8/,
  );
});

test('createInstallationToken looks up the installation and scopes the token', async () => {
  const { fetch, calls } = fakeFetch(installed);
  const result = await mint(fetch);

  assert.deepEqual(result, { token: 'ghs_x', expiresAt: '2026-11-16T13:00:00Z' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET /repos/acme/app/installation', 'POST /app/installations/42/access_tokens'],
  );
  assert.deepEqual(calls[1].body, {
    repository_ids: [123],
    permissions: { contents: 'write', pull_requests: 'write' },
  });
  for (const { headers } of calls) {
    assert.equal(headers.Authorization, 'Bearer app.jwt');
    assert.equal(headers.Accept, 'application/vnd.github+json');
    assert.equal(headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(headers['User-Agent'], 'release-flow-broker');
  }
});

test('createInstallationToken maps 404 to NotInstalledError', async () => {
  const { fetch } = fakeFetch({});
  await assert.rejects(mint(fetch), NotInstalledError);
});

test('createInstallationToken maps 422 to NotInstalledError', async () => {
  const { fetch } = fakeFetch({
    ...installed,
    'POST /app/installations/42/access_tokens': { status: 422, body: { message: 'There is at least one repository that does not exist or is not accessible' } },
  });
  await assert.rejects(mint(fetch), NotInstalledError);
});

test('createInstallationToken maps 5xx to GitHubApiError', async () => {
  const { fetch } = fakeFetch({ 'GET /repos/acme/app/installation': { status: 503, body: {} } });
  const error = await mint(fetch).catch((e) => e);
  assert.ok(error instanceof GitHubApiError);
  assert.equal(error.status, 503);
});

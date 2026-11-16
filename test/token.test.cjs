'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveToken, revokeToken, AUDIENCE } = require('../src/token.cjs');

const BROKER = 'https://broker.example/token';

function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function options(overrides = {}) {
  const idCalls = [];
  return {
    idCalls,
    opts: {
      githubToken: '',
      brokerUrl: BROKER,
      audience: AUDIENCE,
      serverUrl: 'https://github.com',
      getIDToken: async (aud) => {
        idCalls.push(aud);
        return 'jwt';
      },
      fetch: async () => jsonResponse(200, { token: 'ghs_x', expires_at: 'later' }),
      ...overrides,
    },
  };
}

test('AUDIENCE matches the broker audience', () => {
  assert.equal(AUDIENCE, 'release-flow');
});

test('uses github_token when provided', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, {}));
  const { opts, idCalls } = options({ githubToken: 'ghp_x', fetch });
  assert.deepEqual(await resolveToken(opts), { token: 'ghp_x', fromBroker: false });
  assert.equal(idCalls.length, 0);
  assert.equal(calls.length, 0);
});

test('exchanges the OIDC token at the broker', async () => {
  const { fetch, calls } = fakeFetch(() => jsonResponse(200, { token: 'ghs_x', expires_at: 'later' }));
  const { opts, idCalls } = options({ fetch });
  assert.deepEqual(await resolveToken(opts), { token: 'ghs_x', fromBroker: true });
  assert.deepEqual(idCalls, ['release-flow']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, BROKER);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer jwt');
});

test('explains missing id-token permission', async () => {
  const { opts } = options({
    getIDToken: async () => {
      throw new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable');
    },
  });
  await assert.rejects(resolveToken(opts), (error) => {
    assert.match(error.message, /id-token: write/);
    assert.match(error.message, /github_token/);
    return true;
  });
});

test('refuses the broker on GHES', async () => {
  const { opts, idCalls } = options({ serverUrl: 'https://ghe.acme.com' });
  await assert.rejects(resolveToken(opts), /only supports github\.com/);
  assert.equal(idCalls.length, 0);
});

test('surfaces broker errors', async () => {
  const json = options({ fetch: async () => jsonResponse(403, { error: 'Install the app...' }) });
  await assert.rejects(resolveToken(json.opts), { message: 'Token broker returned 403: Install the app...' });

  const text = options({ fetch: async () => new Response('Bad gateway', { status: 502 }) });
  await assert.rejects(resolveToken(text.opts), { message: 'Token broker returned 502: Bad gateway' });
});

test('rejects broker response without token', async () => {
  const { opts } = options({ fetch: async () => jsonResponse(200, {}) });
  await assert.rejects(resolveToken(opts), /no token/);
});

test('revokeToken sends DELETE /installation/token', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
  assert.equal(await revokeToken({ token: 'ghs_x', apiUrl: 'https://api.github.com', fetch }), true);
  assert.equal(calls[0].url, 'https://api.github.com/installation/token');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ghs_x');

  const failing = async () => {
    throw new Error('network down');
  };
  assert.equal(await revokeToken({ token: 'ghs_x', apiUrl: 'https://api.github.com', fetch: failing }), false);
});

test('rejects non-HTTPS broker URLs before requesting credentials', async () => {
  for (const brokerUrl of ['http://broker.example/token', '', 'not a url']) {
    const { fetch, calls } = fakeFetch(() => jsonResponse(200, { token: 'ghs_x' }));
    const { opts, idCalls } = options({ brokerUrl, fetch });
    await assert.rejects(resolveToken(opts), /token_broker_url must be an HTTPS URL/, brokerUrl);
    assert.equal(idCalls.length, 0, brokerUrl);
    assert.equal(calls.length, 0, brokerUrl);
  }
});

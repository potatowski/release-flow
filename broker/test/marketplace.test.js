import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleMarketplace } from '../src/marketplace.js';

const secret = 'test-secret';
const purchase = JSON.stringify({ action: 'purchased', marketplace_purchase: { plan: { name: 'Free' } } });

function sign(body, key = secret) {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

function request(body = purchase, { method = 'POST', event = 'marketplace_purchase', sig = sign(body) } = {}) {
  const headers = { 'X-GitHub-Event': event };
  if (sig) headers['X-Hub-Signature-256'] = sig;
  return new Request('https://broker.example/marketplace', {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
  });
}

async function send(req, s = secret) {
  const response = await handleMarketplace(req, { secret: s });
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.json() };
}

function quiet(fn) {
  return async () => {
    const { log, error } = console;
    console.log = () => {};
    console.error = () => {};
    try {
      await fn();
    } finally {
      Object.assign(console, { log, error });
    }
  };
}

test('rejects other methods', async () => {
  assert.deepEqual(await send(request(purchase, { method: 'GET' })), {
    status: 405,
    body: { error: 'Method not allowed' },
  });
});

test('fails closed when the secret is not set', quiet(async () => {
  assert.deepEqual(await send(request(), ''), { status: 503, body: { error: 'Webhook not configured' } });
}));

test('rejects missing or wrong signatures', async () => {
  const expected = { status: 401, body: { error: 'Invalid signature' } };
  assert.deepEqual(await send(request(purchase, { sig: null })), expected);
  assert.deepEqual(await send(request(purchase, { sig: sign(purchase, 'other') })), expected);
  assert.deepEqual(await send(request(purchase, { sig: sign('tampered') })), expected);
});

test('answers the ping sent when the webhook is created', async () => {
  const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
  assert.deepEqual(await send(request(body, { event: 'ping' })), { status: 200, body: { ok: true } });
});

test('accepts marketplace purchase events', quiet(async () => {
  assert.deepEqual(await send(request()), { status: 200, body: { ok: true } });
}));

test('ignores other events', async () => {
  const body = '{}';
  assert.deepEqual(await send(request(body, { event: 'installation' })), {
    status: 202,
    body: { ignored: 'installation' },
  });
});

test('rejects invalid JSON with a valid signature', async () => {
  assert.deepEqual(await send(request('not json')), { status: 400, body: { error: 'Invalid JSON' } });
});

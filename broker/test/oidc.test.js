import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyActionsToken, InvalidTokenError, EventNotAllowedError } from '../src/oidc.js';
import { createTestKeys, without } from './keys.js';

const keys = await createTestKeys();
const verify = (jwt) => verifyActionsToken(jwt, { jwks: keys.jwks, audience: 'release-flow' });

test('accepts a valid token', async () => {
  const claims = await verify(await keys.signOidc());
  assert.deepEqual(claims, { repository: 'acme/app', repositoryId: '123', owner: 'acme', repo: 'app' });
});

test('rejects wrong audience', async () => {
  await assert.rejects(verify(await keys.signOidc({ aud: 'sts.amazonaws.com' })), InvalidTokenError);
});

test('rejects wrong issuer', async () => {
  await assert.rejects(verify(await keys.signOidc({ iss: 'https://evil.example' })), InvalidTokenError);
});

test('rejects expired token', async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  await assert.rejects(verify(await keys.signOidc({ exp: past })), InvalidTokenError);
});

test('rejects token signed by another key', async () => {
  await assert.rejects(verify(await keys.signOidc({}, { privateKey: keys.otherKey })), InvalidTokenError);
});

test('rejects malformed repository claim', async () => {
  await assert.rejects(verify(await keys.signOidc({ repository: 'noslash' })), InvalidTokenError);
  await assert.rejects(verify(await keys.signOidc(without('repository_id'))), InvalidTokenError);
  await assert.rejects(verify(await keys.signOidc({ repository_id: 'abc' })), InvalidTokenError);
});

test('rejects garbage without echoing it', async () => {
  const error = await verify('not-a-jwt').catch((e) => e);
  assert.ok(error instanceof InvalidTokenError);
  assert.ok(!error.message.includes('not-a-jwt'));
});

test('accepts push, workflow_dispatch and schedule events', async () => {
  for (const event_name of ['push', 'workflow_dispatch', 'schedule']) {
    const claims = await verify(await keys.signOidc({ event_name }));
    assert.equal(claims.repository, 'acme/app');
  }
});

test('rejects events that can run untrusted code', async () => {
  for (const event_name of ['pull_request_target', 'workflow_run', 'issue_comment', 'pull_request']) {
    await assert.rejects(verify(await keys.signOidc({ event_name })), EventNotAllowedError, event_name);
  }
  await assert.rejects(verify(await keys.signOidc(without('event_name'))), InvalidTokenError);
});

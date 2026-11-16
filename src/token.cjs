'use strict';

const AUDIENCE = 'release-flow';

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Returns the token for API calls: `githubToken` when given, otherwise an
 * installation token of the Release Flow app obtained by exchanging the
 * workflow's OIDC token at the broker.
 */
async function resolveToken({ githubToken, brokerUrl, audience, serverUrl, getIDToken, fetch }) {
  if (githubToken) return { token: githubToken, fromBroker: false };

  if (serverUrl.replace(/\/+$/, '') !== 'https://github.com') {
    throw new Error(
      `The Release Flow token broker only supports github.com (this is ${serverUrl}). Pass github_token instead.`,
    );
  }

  if (!isHttpsUrl(brokerUrl)) {
    throw new Error(`token_broker_url must be an HTTPS URL (got "${brokerUrl}").`);
  }

  let idToken;
  try {
    idToken = await getIDToken(audience);
  } catch (error) {
    throw new Error(
      `Could not get an OIDC token (${error.message}). Add "id-token: write" to the workflow permissions, or pass github_token.`,
    );
  }

  const response = await fetch(brokerUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}` },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = body && typeof body.error === 'string' ? body.error : text;
    throw new Error(`Token broker returned ${response.status}: ${detail}`);
  }
  if (!body || typeof body.token !== 'string' || !body.token) {
    throw new Error('Token broker returned no token.');
  }
  return { token: body.token, fromBroker: true };
}

/**
 * Revokes an installation token. Never throws; returns whether it worked.
 */
async function revokeToken({ token, apiUrl, fetch }) {
  try {
    const response = await fetch(`${apiUrl}/installation/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

module.exports = { AUDIENCE, resolveToken, revokeToken };

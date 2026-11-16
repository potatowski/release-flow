import { SignJWT, importPKCS8 } from 'jose';

const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write' };

export class NotInstalledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotInstalledError';
  }
}

export class GitHubApiError extends Error {
  constructor(status) {
    super(`GitHub API error (${status})`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

/**
 * Signs the short-lived JWT that authenticates as the GitHub App.
 * GitHub allows at most 10 minutes; iat is backdated 60s for clock drift.
 */
export async function createAppJwt({ clientId, privateKeyPem, now = Date.now }) {
  if (privateKeyPem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'APP_PRIVATE_KEY must be PKCS#8; convert it with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem',
    );
  }
  const key = await importPKCS8(privateKeyPem, 'RS256');
  const seconds = Math.floor(now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(clientId)
    .setIssuedAt(seconds - 60)
    .setExpirationTime(seconds + 540)
    .sign(key);
}

async function call(fetch, url, appJwt, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'release-flow-broker',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * Mints an installation token restricted to one repository with
 * contents and pull_requests write access.
 */
export async function createInstallationToken({
  owner,
  repo,
  repositoryId,
  appJwt,
  fetch,
  apiUrl = 'https://api.github.com',
}) {
  const notInstalled = () =>
    new NotInstalledError(`The Release Flow app is not installed on ${owner}/${repo}`);

  const lookup = await call(fetch, `${apiUrl}/repos/${owner}/${repo}/installation`, appJwt);
  if (lookup.status === 404) throw notInstalled();
  if (lookup.status !== 200) throw new GitHubApiError(lookup.status);

  const created = await call(fetch, `${apiUrl}/app/installations/${lookup.body.id}/access_tokens`, appJwt, {
    method: 'POST',
    body: JSON.stringify({ repository_ids: [Number(repositoryId)], permissions: TOKEN_PERMISSIONS }),
  });
  // 422: the repository is not among the installation's selected repositories.
  if (created.status === 404 || created.status === 422) throw notInstalled();
  if (created.status !== 201) throw new GitHubApiError(created.status);

  return { token: created.body.token, expiresAt: created.body.expires_at };
}

import { InvalidTokenError, EventNotAllowedError } from './oidc.js';
import { NotInstalledError, PermissionsNotGrantedError, GitHubApiError } from './github-app.js';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * POST /token: exchanges a GitHub Actions OIDC token (Authorization: Bearer)
 * for an installation token scoped to the repository the OIDC token names.
 * Error bodies never include the bearer token.
 */
export async function handleRequest(request, { verify, mintToken, appSlug }) {
  if (new URL(request.url).pathname !== '/token') return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') || '');
  if (!match) return json(400, { error: 'Missing bearer token' });

  let claims;
  try {
    claims = await verify(match[1]);
  } catch (error) {
    if (error instanceof InvalidTokenError) return json(401, { error: 'Invalid OIDC token' });
    if (error instanceof EventNotAllowedError) return json(403, { error: error.message });
    throw error;
  }

  try {
    const { token, expiresAt } = await mintToken(claims);
    return json(200, { token, expires_at: expiresAt });
  } catch (error) {
    if (error instanceof NotInstalledError) {
      return json(403, {
        error: `The Changelog Release Flow app is not installed on ${claims.repository}. Install it: https://github.com/apps/${appSlug}/installations/new`,
      });
    }
    if (error instanceof PermissionsNotGrantedError) {
      return json(403, {
        error: `The Changelog Release Flow app installation on ${claims.repository} has not granted the permissions it needs. An owner must accept the app's requested permissions in the installation settings: https://github.com/apps/${appSlug}/installations/new`,
      });
    }
    if (error instanceof GitHubApiError) return json(502, { error: error.message });
    console.error(`Token exchange failed: ${error.message}`);
    return json(500, { error: 'Internal error' });
  }
}

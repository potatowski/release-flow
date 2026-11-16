import { jwtVerify } from 'jose';

export const ISSUER = 'https://token.actions.githubusercontent.com';

export class InvalidTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * Verifies a GitHub Actions OIDC token and returns the repository it was
 * issued for. Throws InvalidTokenError on any failure; messages never
 * include the token itself.
 */
export async function verifyActionsToken(jwt, { jwks, audience }) {
  let payload;
  try {
    ({ payload } = await jwtVerify(jwt, jwks, { issuer: ISSUER, audience, algorithms: ['RS256'] }));
  } catch (error) {
    throw new InvalidTokenError(`OIDC token rejected (${error.code || error.name})`);
  }

  const { repository, repository_id: repositoryId } = payload;
  if (typeof repository !== 'string' || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new InvalidTokenError('OIDC token has no valid repository claim');
  }
  if (typeof repositoryId !== 'string' || !/^\d+$/.test(repositoryId)) {
    throw new InvalidTokenError('OIDC token has no valid repository_id claim');
  }
  const [owner, repo] = repository.split('/');
  return { repository, repositoryId, owner, repo };
}

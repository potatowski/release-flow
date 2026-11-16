import { jwtVerify } from 'jose';

export const ISSUER = 'https://token.actions.githubusercontent.com';
export const ALLOWED_EVENTS = ['push', 'workflow_dispatch', 'schedule'];

export class InvalidTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/**
 * The token is valid but was issued for an event that can run untrusted code.
 */
export class EventNotAllowedError extends Error {
  constructor(eventName) {
    super(
      `OIDC tokens from "${eventName}" events are not accepted; run the action on ${ALLOWED_EVENTS.join(', ')}`,
    );
    this.name = 'EventNotAllowedError';
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
  // Only events whose code comes from the repository's own branches. Events such
  // as pull_request_target or workflow_run can run untrusted pull request code.
  if (typeof payload.event_name !== 'string') {
    throw new InvalidTokenError('OIDC token has no event_name claim');
  }
  if (!ALLOWED_EVENTS.includes(payload.event_name)) {
    throw new EventNotAllowedError(payload.event_name);
  }
  const [owner, repo] = repository.split('/');
  return { repository, repositoryId, owner, repo };
}

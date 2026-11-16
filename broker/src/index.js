import { createRemoteJWKSet } from 'jose';
import { handleRequest } from './handler.js';
import { ISSUER, verifyActionsToken } from './oidc.js';
import { createAppJwt, createInstallationToken } from './github-app.js';

// Module scope so the key set is cached across requests in the same isolate.
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, {
        appSlug: env.APP_SLUG,
        verify: (jwt) => verifyActionsToken(jwt, { jwks, audience: env.OIDC_AUDIENCE }),
        mintToken: async ({ owner, repo, repositoryId }) => {
          const appJwt = await createAppJwt({ clientId: env.APP_CLIENT_ID, privateKeyPem: env.APP_PRIVATE_KEY });
          return createInstallationToken({ owner, repo, repositoryId, appJwt, fetch });
        },
      });
    } catch (error) {
      console.error(`Unhandled error: ${error.message}`);
      return new Response(JSON.stringify({ error: 'Internal error' }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  },
};

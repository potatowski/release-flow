import { createPrivateKey } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair } from 'jose';

export const ISSUER = 'https://token.actions.githubusercontent.com';

const DEFAULT_CLAIMS = {
  repository: 'acme/app',
  repository_id: '123',
  repository_owner: 'acme',
};

async function keyPair(kid) {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { publicKey, privateKey, jwk };
}

/**
 * Test keys: a local JWKS standing in for GitHub's and a signer for fake
 * Actions OIDC tokens. `opts.privateKey` signs with another key.
 */
export async function createTestKeys() {
  const main = await keyPair('test-key');
  const privateKeyPem = await exportPKCS8(main.privateKey);
  const pkcs1Pem = createPrivateKey(privateKeyPem).export({ type: 'pkcs1', format: 'pem' });

  async function signOidc(claims = {}, opts = {}) {
    const now = Math.floor(Date.now() / 1000);
    const { iss = ISSUER, aud = 'release-flow', exp = now + 300, ...rest } = claims;
    return new SignJWT({ ...DEFAULT_CLAIMS, ...rest })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt(now - 10)
      .setExpirationTime(exp)
      .sign(opts.privateKey || main.privateKey);
  }

  return {
    jwks: createLocalJWKSet({ keys: [main.jwk] }),
    publicKey: main.publicKey,
    signOidc,
    privateKeyPem,
    pkcs1Pem,
    otherKey: (await keyPair('other')).privateKey,
  };
}

/**
 * Removes a claim from the defaults by signing with it set to undefined.
 */
export function without(name) {
  return { [name]: undefined };
}

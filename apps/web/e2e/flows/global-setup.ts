import type { FullConfig } from '@playwright/test';

export const MOCK_GOOGLE_PORT = 9099;

/**
 * Starts a mock OIDC provider on :9099 that the app's Google provider is
 * pointed at (AUTH_GOOGLE_ISSUER). It auto-approves /authorize and signs an
 * id_token for a fresh user each run, so a real authorization-code flow
 * (discovery, PKCE, token exchange, id_token verification) runs end to end.
 * The email is shared with the tests through process.env, which Playwright
 * passes from global setup to its workers.
 */
export default async function globalSetup(_config: FullConfig) {
  const { OAuth2Server } = await import('oauth2-mock-server');
  const server = new OAuth2Server();
  await server.issuer.keys.generate('RS256');

  const email = `google-${Date.now()}@wolff.test`;
  process.env.E2E_GOOGLE_EMAIL = email;

  const profile = () => {
    return {
      sub: `google-${email}`,
      email,
      email_verified: true,
      name: 'Google E2E User',
      picture: 'https://lh3.googleusercontent.com/a/e2e',
    };
  };

  server.service.on('beforeTokenSigning', (token) => {
    Object.assign(token.payload, profile());
  });
  server.service.on('beforeUserinfo', (response) => {
    response.body = profile();
  });

  await server.start(MOCK_GOOGLE_PORT, 'localhost');
  return async () => {
    await server.stop();
  };
}

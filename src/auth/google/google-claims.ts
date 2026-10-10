export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export class GoogleIdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleIdTokenError';
  }
}

const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * Reads and checks an id_token received DIRECTLY from Google's token endpoint.
 *
 * The signature is deliberately not verified: OIDC Core §3.1.3.7 lets TLS
 * stand in for it when the token comes straight from the token endpoint over
 * an authenticated (client-secret) channel — which is the only way this code
 * ever obtains one. Never call this on a token that arrived from a browser.
 */
export function readIdTokenClaims(
  idToken: string,
  clientId: string,
  nowSeconds: number,
): GoogleClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleIdTokenError('malformed id_token');

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleIdTokenError('unreadable id_token payload');
  }

  if (typeof payload.iss !== 'string' || !ISSUERS.has(payload.iss)) {
    throw new GoogleIdTokenError('unexpected issuer');
  }
  if (payload.aud !== clientId)
    throw new GoogleIdTokenError('unexpected audience');
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    throw new GoogleIdTokenError('id_token expired');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new GoogleIdTokenError('id_token has no sub');
  }
  if (typeof payload.email !== 'string' || !payload.email) {
    throw new GoogleIdTokenError('id_token has no email');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name:
      typeof payload.name === 'string' && payload.name ? payload.name : null,
  };
}

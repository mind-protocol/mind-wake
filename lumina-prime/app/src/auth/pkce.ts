// PKCE (RFC 7636) sans dépendance native : les octets aléatoires et le SHA-256
// sont fournis par l'appelant (expo-crypto dans l'app, node:crypto dans les tests).

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64FromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
}

export function base64UrlFromBase64(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlFromBytes(bytes: Uint8Array): string {
  return base64UrlFromBase64(base64FromBytes(bytes));
}

/** 32 octets aléatoires → 43 caractères base64url, conforme à 43..128 caractères non réservés. */
export function codeVerifierFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 32 || bytes.length > 96) throw new RangeError('PKCE: 32 à 96 octets requis');
  return base64UrlFromBytes(bytes);
}

export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** code_challenge S256 = BASE64URL(SHA256(ASCII(code_verifier))). */
export async function codeChallengeS256(verifier: string, sha256Base64: (input: string) => Promise<string>): Promise<string> {
  if (!isValidCodeVerifier(verifier)) throw new Error('PKCE: code_verifier invalide');
  return base64UrlFromBase64(await sha256Base64(verifier));
}

export function randomState(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new RangeError('state: au moins 16 octets');
  return base64UrlFromBytes(bytes);
}

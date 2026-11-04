// Server-only. `identity` arguments MUST come from a verified provider response,
// never from client-submitted profile JSON. No provider credentials are stored.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuthError } from './core.mjs';

const PROVIDERS = new Set(['x', 'telegram', 'whatsapp']);
const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');

export function createIdentityStore({ filename, now = Date.now, sessionTtlMs = 30 * 24 * 3600_000, linkTtlMs = 5 * 60_000 } = {}) {
  if (typeof filename !== 'string' || !filename) throw Error('Explicit SQLite filename required.');
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS mind_accounts (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS linked_identities (
      provider TEXT NOT NULL CHECK(provider IN ('x','telegram','whatsapp')),
      provider_sub TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES mind_accounts(id),
      handle TEXT NOT NULL, display_name TEXT, verified_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_sub)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS identities_by_account ON linked_identities(account_id);
    CREATE TABLE IF NOT EXISTS mind_sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES mind_accounts(id),
      provider TEXT NOT NULL, provider_sub TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, revoked_at INTEGER,
      FOREIGN KEY(provider, provider_sub) REFERENCES linked_identities(provider, provider_sub)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS identity_links (
      challenge_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES mind_accounts(id),
      session_hash TEXT NOT NULL REFERENCES mind_sessions(token_hash),
      provider TEXT NOT NULL CHECK(provider IN ('x','telegram','whatsapp')),
      expires_at INTEGER NOT NULL, consumed_at INTEGER
    ) STRICT;
  `);
  const q = sql => db.prepare(sql);
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function validIdentity(value) {
    if (!value || !PROVIDERS.has(value.provider) || typeof value.providerUserId !== 'string' || !value.providerUserId || value.providerUserId.length > 256
      || typeof value.handle !== 'string' || !value.handle || value.handle.length > 256
      || (value.displayName !== null && (typeof value.displayName !== 'string' || value.displayName.length > 256))
      || typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt))) throw new AuthError('invalid_identity', 400);
    const verified = Date.parse(value.verifiedAt);
    if (verified > now() + 60_000 || verified < now() - 5 * 60_000) throw new AuthError('expired_proof', 401);
    return value;
  }
  function publicIdentity(row) {
    return { provider: row.provider, providerUserId: row.provider_sub, handle: row.handle, displayName: row.display_name, verifiedAt: row.verified_at };
  }
  function account(accountId) {
    const identities = q('SELECT * FROM linked_identities WHERE account_id = ? ORDER BY provider, provider_sub').all(accountId).map(publicIdentity);
    return { mindUserId: accountId, identities };
  }
  function findSession(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return q('SELECT * FROM mind_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(hash(token), now()) ?? null;
  }
  function requireSession(token) {
    const session = findSession(token);
    if (!session) throw new AuthError('unauthorized', 401);
    return session;
  }
  function sessionIdentity(session) {
    return publicIdentity(q('SELECT * FROM linked_identities WHERE provider = ? AND provider_sub = ? AND account_id = ?').get(session.provider, session.provider_sub, session.account_id));
  }
  function issueToken(accountId, identity) {
    const sessionToken = opaque(); const expires = now() + sessionTtlMs;
    q('INSERT INTO mind_sessions(token_hash,account_id,provider,provider_sub,created_at,expires_at) VALUES(?,?,?,?,?,?)')
      .run(hash(sessionToken), accountId, identity.provider, identity.providerUserId, now(), expires);
    return { schemaVersion: 1, sessionToken, expiresAt: new Date(expires).toISOString(), identity, ...account(accountId) };
  }
  function bind(accountId, identity) {
    const existing = q('SELECT account_id FROM linked_identities WHERE provider = ? AND provider_sub = ?').get(identity.provider, identity.providerUserId);
    if (existing && existing.account_id !== accountId) throw new AuthError('identity_already_linked', 409);
    if (!existing && q('SELECT count(*) AS count FROM linked_identities WHERE account_id = ?').get(accountId).count >= 20) throw new AuthError('identity_limit', 409);
    q(`INSERT INTO linked_identities(provider,provider_sub,account_id,handle,display_name,verified_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(provider,provider_sub) DO UPDATE SET handle=excluded.handle,display_name=excluded.display_name,verified_at=excluded.verified_at`)
      .run(identity.provider, identity.providerUserId, accountId, identity.handle, identity.displayName, identity.verifiedAt);
  }
  return {
    issue(verifiedIdentity) {
      const identity = validIdentity(verifiedIdentity);
      return transaction(() => {
        const existing = q('SELECT account_id FROM linked_identities WHERE provider = ? AND provider_sub = ?').get(identity.provider, identity.providerUserId);
        const accountId = existing?.account_id ?? randomUUID();
        if (!existing) q('INSERT INTO mind_accounts(id,created_at) VALUES(?,?)').run(accountId, now());
        bind(accountId, identity);
        return issueToken(accountId, identity);
      });
    },
    lookup(token) {
      const session = findSession(token);
      return session ? { identity: sessionIdentity(session), expiresAt: new Date(session.expires_at).toISOString(), ...account(session.account_id) } : null;
    },
    startLink(token, provider) {
      if (!PROVIDERS.has(provider)) throw new AuthError('invalid_request', 400);
      return transaction(() => {
        const session = requireSession(token); const challenge = opaque(); const expires = now() + linkTtlMs;
        q('INSERT INTO identity_links(challenge_hash,account_id,session_hash,provider,expires_at) VALUES(?,?,?,?,?)')
          .run(hash(challenge), session.account_id, session.token_hash, provider, expires);
        return { linkChallenge: challenge, provider, expiresAt: new Date(expires).toISOString() };
      });
    },
    link(token, challenge, verifiedIdentity) {
      const identity = validIdentity(verifiedIdentity);
      if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new AuthError('invalid_request', 400);
      return transaction(() => {
        const session = requireSession(token);
        const pending = q('SELECT * FROM identity_links WHERE challenge_hash = ?').get(hash(challenge));
        if (!pending || pending.consumed_at !== null || pending.expires_at <= now()) throw new AuthError('expired_link', 410);
        if (pending.session_hash !== session.token_hash || pending.account_id !== session.account_id || pending.provider !== identity.provider) throw new AuthError('invalid_link', 403);
        bind(session.account_id, identity);
        q('UPDATE identity_links SET consumed_at = ? WHERE challenge_hash = ?').run(now(), hash(challenge));
        q('UPDATE mind_sessions SET revoked_at = ? WHERE token_hash = ?').run(now(), session.token_hash);
        return issueToken(session.account_id, identity);
      });
    },
    revoke(token) {
      if (typeof token !== 'string') return false;
      return q('UPDATE mind_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(now(), hash(token)).changes > 0;
    },
    close() { db.close(); },
  };
}

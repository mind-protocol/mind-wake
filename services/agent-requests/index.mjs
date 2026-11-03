import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { isAddress } from '@solana/kit';

export const MIND_MINT = 'EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p';
export const NETWORK = 'solana-mainnet';
export const STATES = ['requested', 'seen', 'declined'];
const TYPES = ['free_trial', 'faucet'];
const COMMON = ['version', 'id', 'type', 'agent', 'purpose', 'created_at', 'reply_to'];
const FINANCIAL = ['wallet', 'network', 'mint', 'amount', 'amount_mode'];
const MAX_U64 = (1n << 64n) - 1n;

export class RequestError extends Error {
  constructor(code, message) { super(message); this.name = 'RequestError'; this.code = code; }
}
function fail(message) { throw new RequestError('INVALID_REQUEST', message); }
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(`Invalid ${name}`);
  return value.trim();
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail('Invalid id');
  return value;
}
export function amountAtomic(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,9})?$/u.test(value)) fail('amount must be a positive decimal string with at most 9 decimal places');
  const [whole, fraction = ''] = value.split('.');
  const atomic = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (atomic <= 0n || atomic > MAX_U64) fail('amount is outside the Token-2022 u64 range');
  return atomic.toString();
}

/** Public claims only. Validation establishes syntax, not identity, ownership or funding. */
export function validateRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Expected an object');
  if (raw.version !== 1 || !TYPES.includes(raw.type)) fail('Unsupported version or type');
  const allowed = raw.type === 'faucet' ? [...COMMON, ...FINANCIAL] : COMMON;
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail('Unknown fields are not accepted');
  const created = text(raw.created_at, 'created_at', 30);
  const parsedDate = new Date(created);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(created) || !Number.isFinite(parsedDate.getTime())) fail('created_at must be a UTC ISO timestamp');
  const canonicalDate = created.replace(/(?:\.(\d{1,3}))?Z$/u, (_match, fraction) => `.${(fraction || '').padEnd(3, '0')}Z`);
  if (parsedDate.toISOString() !== canonicalDate) fail('created_at must name a real UTC date');
  const result = {
    version: 1, id: requestId(raw.id), type: raw.type,
    agent: text(raw.agent, 'agent', 120), purpose: text(raw.purpose, 'purpose', 2000),
    created_at: parsedDate.toISOString(),
  };
  if (raw.reply_to !== undefined) result.reply_to = text(raw.reply_to, 'reply_to', 300);
  if (raw.type === 'faucet') {
    if (raw.network !== NETWORK || raw.mint !== MIND_MINT) fail('Unsupported network or mint');
    if (typeof raw.wallet !== 'string' || !isAddress(raw.wallet)) fail('Invalid Solana public address');
    if (!['gross', 'net'].includes(raw.amount_mode)) fail('amount_mode must be gross or net');
    amountAtomic(raw.amount);
    Object.assign(result, { wallet: raw.wallet, network: NETWORK, mint: MIND_MINT, amount: raw.amount, amount_mode: raw.amount_mode });
  }
  return result;
}

export function createRequest(fields) {
  return validateRequest({ version: 1, id: randomUUID(), created_at: new Date().toISOString(), ...fields });
}
export function defaultDataDir(env = process.env) {
  const base = env.LOCALAPPDATA || env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(base, 'mind-wake', 'manual-agent-requests');
}
export function registryPath(dataDir = defaultDataDir()) { return join(dataDir, 'requests.sqlite'); }

/** Private, local queue. It deliberately has no settled/paid/approved state. */
export class RequestRegistry {
  constructor(dataDir = defaultDataDir(), { readOnly = false } = {}) {
    this.path = registryPath(dataDir);
    if (!readOnly) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
    }
    this.db = new Database(this.path, { timeout: 5000, readonly: readOnly, fileMustExist: readOnly });
    try {
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      const initialVersion = this.db.pragma('user_version', { simple: true });
      if (![0, 1].includes(initialVersion)) throw new RequestError('REGISTRY_VERSION', 'Unsupported registry version');
      if (initialVersion === 0 && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new RequestError('REGISTRY_VERSION', 'Unsupported registry schema');
      if (!readOnly) {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = FULL');
        this.db.transaction(() => {
          const version = this.db.pragma('user_version', { simple: true });
          if (version === 1) return;
          if (version !== 0 || this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) throw new RequestError('REGISTRY_VERSION', 'Unsupported registry schema');
          this.db.exec(`
          CREATE TABLE IF NOT EXISTS requests (
            id TEXT PRIMARY KEY, digest TEXT NOT NULL, envelope TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('requested','seen','declined')),
            recorded_at TEXT NOT NULL, updated_at TEXT NOT NULL, review_reason TEXT
          );
          CREATE TABLE IF NOT EXISTS reviews (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id TEXT NOT NULL REFERENCES requests(id),
            state TEXT NOT NULL CHECK(state IN ('requested','seen','declined')),
            at TEXT NOT NULL, reason TEXT
          );
          PRAGMA user_version = 1;
          `);
        }).immediate();
        if (process.platform !== 'win32') chmodSync(this.path, 0o600);
      }
      if (this.db.pragma('user_version', { simple: true }) !== 1) throw new RequestError('REGISTRY_VERSION', 'Unsupported registry version');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  #decode(row) {
    if (!row) return null;
    return { request: JSON.parse(row.envelope), state: row.state, recorded_at: row.recorded_at, updated_at: row.updated_at,
      ...(row.review_reason !== null ? { review_reason: row.review_reason } : {}), funding: 'not_processed' };
  }
  get(id) { return this.#decode(this.db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId(id))); }
  list({ state, type } = {}) {
    if (state !== undefined && !STATES.includes(state)) throw new RequestError('INVALID_FILTER', 'Invalid state');
    if (type !== undefined && !TYPES.includes(type)) throw new RequestError('INVALID_FILTER', 'Invalid type');
    return this.db.prepare('SELECT * FROM requests ORDER BY recorded_at, id').all().map(row => this.#decode(row))
      .filter(row => (state === undefined || row.state === state) && (type === undefined || row.request.type === type));
  }
  history(id) {
    return this.db.prepare('SELECT state,at,reason FROM reviews WHERE request_id = ? ORDER BY seq').all(requestId(id));
  }
  record(raw) {
    const request = validateRequest(raw);
    const envelope = JSON.stringify(request);
    const digest = createHash('sha256').update(envelope).digest('hex');
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(request.id);
      if (existing) {
        if (existing.digest !== digest) throw new RequestError('ID_CONFLICT', 'This id already names a different request');
        return { inserted: false, record: this.#decode(existing) };
      }
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO requests(id,digest,envelope,state,recorded_at,updated_at) VALUES(?,?,?,\'requested\',?,?)').run(request.id, digest, envelope, now, now);
      this.db.prepare('INSERT INTO reviews(request_id,state,at) VALUES(?,\'requested\',?)').run(request.id, now);
      return { inserted: true, record: this.get(request.id) };
    }).immediate();
  }
  review(id, state, reason) {
    requestId(id);
    if (!['seen', 'declined'].includes(state)) throw new RequestError('INVALID_STATE', 'Only seen or declined are review states');
    const cleanReason = state === 'declined' ? text(reason, 'reason', 1000) : undefined;
    return this.db.transaction(() => {
      const current = this.get(id);
      if (!current) throw new RequestError('NOT_FOUND', 'Request not found');
      if (current.state === state) {
        if (state === 'declined' && current.review_reason !== cleanReason) throw new RequestError('REVIEW_CONFLICT', 'A different refusal is already recorded');
        return { changed: false, record: current };
      }
      if (current.state === 'declined') throw new RequestError('INVALID_TRANSITION', 'A declined request cannot be reopened');
      const now = new Date().toISOString();
      this.db.prepare('UPDATE requests SET state=?,updated_at=?,review_reason=? WHERE id=?').run(state, now, cleanReason ?? null, id);
      this.db.prepare('INSERT INTO reviews(request_id,state,at,reason) VALUES(?,?,?,?)').run(id, state, now, cleanReason ?? null);
      return { changed: true, record: this.get(id) };
    }).immediate();
  }
}

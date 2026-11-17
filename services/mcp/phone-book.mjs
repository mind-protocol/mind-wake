import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {phoneRingtone,ringtoneCapabilities} from './phone-ringtones.mjs';

export function humanHandle(raw = 'nlr') {
  const value = raw.trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9][a-z0-9_.-]{0,60}$/.test(value)) throw Error('Handle humain invalide');
  return value === 'nlr-ai' ? 'nlr' : value;
}

export function openPhoneBook(dir) {
  const db = new DatabaseSync(path.join(dir, 'mobile-calls.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS phones(session TEXT PRIMARY KEY, human TEXT NOT NULL, token TEXT UNIQUE, until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY, human TEXT NOT NULL, caller TEXT NOT NULL,
      label TEXT NOT NULL, until INTEGER NOT NULL, decision TEXT);
    CREATE TABLE IF NOT EXISTS phone_push_leases(invite TEXT, token TEXT, until INTEGER, PRIMARY KEY(invite,token));
    CREATE TABLE IF NOT EXISTS phone_deliveries(invite TEXT, token TEXT, PRIMARY KEY(invite,token));`);
  const now = Date.now();
  db.prepare('DELETE FROM phones WHERE until <= ?').run(now);
  db.prepare('DELETE FROM invitations WHERE until <= ?').run(now - 60000);
  db.exec("DELETE FROM phone_deliveries WHERE invite NOT IN (SELECT id FROM invitations)");
  db.prepare('DELETE FROM phone_push_leases WHERE until<=?').run(now);
  let hasCaps = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='phone_ringtone_caps'").get());
  const capabilities = (session, human) => {
    if(!session || !hasCaps)return [];
    const row=db.prepare('SELECT c.keys FROM phone_ringtone_caps c JOIN phones p ON p.session=c.session WHERE p.session=? AND p.human=? AND p.until>?').get(session,human,Date.now());
    try{return ringtoneCapabilities(row ? JSON.parse(row.keys) : []);}catch{return [];}
  };
  if(hasCaps)db.exec('DELETE FROM phone_ringtone_caps WHERE session NOT IN (SELECT session FROM phones)');
  return {
    close: () => db.close(),
    disconnect: key => { if(hasCaps)db.prepare('DELETE FROM phone_ringtone_caps WHERE session=?').run(key); return db.prepare('DELETE FROM phones WHERE session=?').run(key); },
    register(key, human, token, until) {
      if (token && !/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,200}\]$/.test(token)) throw Error('Invalid push token');
      db.prepare('INSERT OR REPLACE INTO phones VALUES(?,?,?,?)').run(key, humanHandle(human), token, until);
      if(hasCaps)db.prepare('INSERT OR REPLACE INTO phone_ringtone_caps VALUES(?,?)').run(key,'[]');
    },
    setRingtoneCapabilities(session,human,keys) {
      const caps=ringtoneCapabilities(keys);
      if(!db.prepare('SELECT 1 FROM phones WHERE session=? AND human=? AND until>?').get(session,humanHandle(human),Date.now()))throw Error('Appareil non enregistré');
      if(!hasCaps){db.exec('CREATE TABLE IF NOT EXISTS phone_ringtone_caps(session TEXT PRIMARY KEY, keys TEXT NOT NULL)');hasCaps=true;}
      db.prepare('INSERT OR REPLACE INTO phone_ringtone_caps VALUES(?,?)').run(session,JSON.stringify(caps));
    },
    invite(to, caller, label) {
      const human = humanHandle(to);
      if (human !== 'nlr' && !db.prepare('SELECT 1 FROM phones WHERE human=? AND until>?').get(human, Date.now()))
        throw Error('Aucun appareil enregistré pour @' + human);
      const id = randomUUID(), until = Date.now() + 45000;
      db.prepare('INSERT INTO invitations(id,human,caller,label,until) VALUES(?,?,?,?,?)').run(id,human,caller,label,until);
      return { id, human, caller, expiresAt: new Date(until).toISOString(), status: 'queued' };
    },
    pending(human, session) {
      const invite=db.prepare('SELECT id, caller, label, until FROM invitations WHERE human=? AND decision IS NULL AND until>? ORDER BY rowid LIMIT 1').get(human, Date.now());
      return invite ? {...invite,ringtone:phoneRingtone(invite.caller,capabilities(session,human)).key} : null;
    },
    decide(human, id, decision) {
      return db.prepare('UPDATE invitations SET decision=? WHERE human=? AND id=? AND decision IS NULL AND until>? RETURNING caller')
        .get(decision, human, id, Date.now());
    },
    async push(send) {
      const candidates = db.prepare(`SELECT i.id, i.human, i.caller, i.label, i.until, p.token, p.session FROM invitations i
        JOIN phones p ON p.human=i.human AND p.token IS NOT NULL
        WHERE i.decision IS NULL AND i.until>? AND p.until>?
        AND NOT EXISTS (SELECT 1 FROM phone_deliveries d WHERE d.invite=i.id AND d.token=p.token)
        ORDER BY i.rowid LIMIT 100`).all(Date.now(), Date.now());
      const claim = db.prepare(`INSERT INTO phone_push_leases VALUES(?,?,?)
        ON CONFLICT(invite,token) DO UPDATE SET until=excluded.until WHERE phone_push_leases.until<=?`);
      const rows = candidates.filter(row => claim.run(row.id, row.token, Date.now()+8000, Date.now()).changes === 1);
      if (!rows.length) return;
      const tickets = await send(rows.map(row => ({
        to: row.token, title: row.label + ' t’appelle', body: 'Ouvrir pour décrocher',
        sound: phoneRingtone(row.caller,capabilities(row.session,row.human)).sound, channelId: phoneRingtone(row.caller,capabilities(row.session,row.human)).channelId, priority: 'high',
        ttl: Math.max(1, Math.ceil((row.until-Date.now())/1000)), data: {callId: row.id},
      })));
      rows.forEach((row, index) => {
        const ticket = tickets[index];
        if (ticket?.status === 'ok') db.prepare('INSERT OR IGNORE INTO phone_deliveries VALUES(?,?)').run(row.id,row.token);
        if (ticket?.details?.error === 'DeviceNotRegistered') db.prepare('UPDATE phones SET token=NULL WHERE token=?').run(row.token);
      });
    },
  };
}

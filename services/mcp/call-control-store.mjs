import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HANDLE = /^[a-z0-9][a-z0-9_.-]{0,60}$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const identity = caller => typeof caller === 'string' && HANDLE.test(caller) ? caller : fail('call_caller_invalid');
const keys = input => {
  if (!Array.isArray(input) || !input.length || input.length > 64) fail('call_participants_invalid');
  return [...new Set(input.map(identity))].sort();
};
const callKey = ({id, epoch}) => {
  if (typeof id !== 'string' || !UUID.test(id) || epoch !== 1) fail('call_identity_invalid');
  return id;
};

/** Only public caller identities and lifecycle metadata; no token, audio or transcript. */
export function openCallControls(dir, {now = Date.now, idleMs = 120_000} = {}) {
  const db = new DatabaseSync(path.join(dir, 'mobile-call-control.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS call_control_sessions(
      id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, state TEXT NOT NULL,
      participants TEXT NOT NULL, started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      ended_at INTEGER, ended_by TEXT);
    CREATE TABLE IF NOT EXISTS call_invite_requests(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      caller TEXT NOT NULL, caller_label TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL,
      requested_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', result TEXT, settled_at INTEGER);`);
  const row = id => db.prepare('SELECT * FROM call_control_sessions WHERE id=?').get(id);
  const expire = () => db.prepare("UPDATE call_control_sessions SET state='ended',ended_at=?,ended_by='expired' WHERE state='active' AND last_seen<?").run(now(), now() - idleMs);
  const view = value => value ? {id:value.id, epoch:value.epoch, state:value.state, status:value.state,
    ...(value.ended_at == null ? {} : {endedAt:new Date(value.ended_at).toISOString()})} : null;
  function existing(input) { const id = callKey(input); expire(); return row(id); }
  const inviteView = value => value ? {request:value.seq, call_id:value.call_id, epoch:value.epoch, target:value.target,
    state:value.state, ...(value.result ? JSON.parse(value.result) : {})} : null;
  const short = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    close: () => db.close(),
    registerCall(input) {
      const id = callKey(input), participants = keys(input.participants), at = now();
      expire();
      db.prepare("INSERT OR IGNORE INTO call_control_sessions VALUES(?,?,'active',?,?,?,NULL,NULL)")
        .run(id, input.epoch, JSON.stringify(participants), at, at);
      const current = row(id);
      if (current.state !== 'active') fail('call_ended');
      // Repeated initial registration cannot change the caller authority.
      if (current.participants !== JSON.stringify(participants)) fail('call_participants_mismatch');
      return view(current);
    },
    addParticipants(input) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = existing(input);
        if (!current || current.state !== 'active') fail('call_ended');
        const participants = keys([...JSON.parse(current.participants), ...keys(input.participants)]);
        const updated = db.prepare("UPDATE call_control_sessions SET participants=?,last_seen=? WHERE id=? AND epoch=? AND state='active' RETURNING *")
          .get(JSON.stringify(participants), now(), input.id, input.epoch);
        if (!updated) fail('call_ended');
        db.exec('COMMIT');
        return view(updated);
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
    replaceParticipants(input) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = existing(input);
        if (!current || current.state !== 'active') fail('call_ended');
        const participants = keys(input.participants);
        const updated = db.prepare("UPDATE call_control_sessions SET participants=?,last_seen=? WHERE id=? AND epoch=? AND state='active' RETURNING *")
          .get(JSON.stringify(participants), now(), input.id, input.epoch);
        if (!updated) fail('call_ended');
        db.exec('COMMIT');
        return view(updated);
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
    control(input) {
      const current = existing(input);
      if (!current) return null;
      if (current.state === 'active') db.prepare("UPDATE call_control_sessions SET last_seen=? WHERE id=? AND state='active'").run(now(), input.id);
      return view(current);
    },
    markEnded(input) {
      const id = callKey(input), at = now();
      // A late registration/upload must never resurrect a call already closed.
      db.prepare("INSERT OR IGNORE INTO call_control_sessions VALUES(?,?,'ended','[]',?,?,?,?)")
        .run(id, input.epoch, at, at, at, 'human');
      db.prepare("UPDATE call_control_sessions SET state='ended',ended_at=?,ended_by='human' WHERE id=? AND epoch=? AND state='active'")
        .run(at, id, input.epoch);
      return view(row(id));
    },
    listForCaller(caller) {
      identity(caller); expire();
      return db.prepare("SELECT * FROM call_control_sessions WHERE state='active' AND EXISTS(SELECT 1 FROM json_each(participants) WHERE value=?) ORDER BY last_seen DESC LIMIT 20")
        .all(caller).map(view);
    },
    /**
     * Invitation par un agent (outil MCP invite_to_call) : seulement une demande. Le serveur de l'app,
     * qui tient l'appel, l'exécute avec ses propres droits (chat-call-invites.mjs) ; aucun jeton ici.
     * Sans `id`, l'appel actif le plus récent (de préférence un appel dont l'agent fait partie).
     */
    requestInvite(input) {
      const caller = identity(input.caller), target = identity(input.target);
      const label = short(input.callerLabel || caller, 80), reason = short(input.reason, 200);
      expire();
      let current;
      if (input.id !== undefined) {
        current = row(callKey({id:input.id, epoch:input.epoch ?? 1}));
        if (!current) fail('call_unknown');
        if (current.state !== 'active') fail('call_ended');
      } else {
        const active = db.prepare("SELECT * FROM call_control_sessions WHERE state='active' ORDER BY last_seen DESC LIMIT 20").all();
        current = active.find(c => JSON.parse(c.participants).includes(caller)) ?? active[0];
        if (!current) fail('no_active_call');
      }
      if (JSON.parse(current.participants).includes(target))
        return {call_id:current.id, epoch:current.epoch, target, state:'settled', status:'already_joined'};
      const pending = db.prepare("SELECT * FROM call_invite_requests WHERE call_id=? AND target=? AND state='pending' AND requested_at>=?")
        .get(current.id, target, now() - 60_000);
      if (pending) return inviteView(pending);
      const created = db.prepare('INSERT INTO call_invite_requests(call_id,epoch,caller,caller_label,target,reason,requested_at) VALUES(?,?,?,?,?,?,?) RETURNING *')
        .get(current.id, current.epoch, caller, label, target, reason, now());
      return inviteView(created);
    },
    /** Demandes en attente (moins d'une minute) ; plus vieilles : expirées, jamais exécutées en retard. */
    pendingInvites() {
      db.prepare("UPDATE call_invite_requests SET state='settled',result=?,settled_at=? WHERE state='pending' AND requested_at<?")
        .run(JSON.stringify({status:'expired'}), now(), now() - 60_000);
      return db.prepare("SELECT * FROM call_invite_requests WHERE state='pending' ORDER BY seq LIMIT 20").all()
        .map(v => ({request:v.seq, id:v.call_id, epoch:v.epoch, caller:v.caller, callerLabel:v.caller_label, target:v.target, reason:v.reason}));
    },
    settleInvite(request, result) {
      db.prepare("UPDATE call_invite_requests SET state='settled',result=?,settled_at=? WHERE seq=? AND state='pending'")
        .run(JSON.stringify(result ?? {}), now(), request);
      return inviteView(db.prepare('SELECT * FROM call_invite_requests WHERE seq=?').get(request));
    },
    invite(request) { return inviteView(db.prepare('SELECT * FROM call_invite_requests WHERE seq=?').get(request)); },
    requestHangup(input) {
      identity(input.caller);
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = existing(input);
        if (!current) fail('call_unknown');
        if (!JSON.parse(current.participants).includes(input.caller)) fail('call_forbidden');
        const updated = db.prepare("UPDATE call_control_sessions SET state='ended',ended_at=?,ended_by=? WHERE id=? AND epoch=? AND state='active' RETURNING *")
          .get(now(), input.caller, input.id, input.epoch);
        const result = {...view(updated ?? row(input.id)), changed:Boolean(updated), duplicate:!updated};
        db.exec('COMMIT');
        return result;
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

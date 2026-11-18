/**
 * Invitations d'agents dans l'appel en cours (outil MCP `invite_to_call`, services/mcp/agent-hangup.ts).
 * L'agent ne dépose qu'une demande dans le magasin partagé des appels (mobile-call-control.sqlite) ;
 * ce serveur, qui tient l'appel, l'exécute avec ses propres droits : aucune clé ni jeton ne passe par
 * l'agent. Résultat réglé dans le magasin : added | already_joined | target_unknown | call_unknown | failed.
 */
const CODES = new Map([
  ['call_target_unknown', 'target_unknown'], ['call_target_invalid', 'target_invalid'],
  ['call_session_unknown', 'call_unknown'], ['call_session_invalid', 'call_unknown'], ['call_ended', 'call_ended'],
  ['call_revision_conflict', 'retry'],
]);

export async function processCallInvites({ controls, call }) {
  if (!controls?.pendingInvites || !call?.inviteSession) return [];
  const settled = [];
  for (const request of controls.pendingInvites()) {
    let result;
    try {
      const state = call.inviteSession(request.id, request.epoch, request.target, { by: request.callerLabel, reason: request.reason });
      if (state.status === 'added') {
        controls.addParticipants({ id: request.id, epoch: request.epoch, participants: call.identityKeys(state.handles) });
        try { await call.syncInvited?.(request.id); }
        catch { /* Pairs distants : resynchronisés au prochain sondage de l'app. */ }
      }
      result = { status: state.status, label: state.label, revision: state.revision };
    } catch (error) {
      const status = CODES.get(error?.code) ?? 'failed';
      if (status === 'retry') continue; // L'app modifie les participants au même instant : passage suivant.
      result = { status, error: String(error?.code ?? error?.message ?? error).slice(0, 120) };
    }
    settled.push(controls.settleInvite(request.request, result));
  }
  return settled;
}

/** Passage régulier (1 s) ; un passage à la fois. */
export function startCallInvites({ controls, call, intervalMs = 1000 }) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processCallInvites({ controls, call }).catch(error => console.error('Call invites failed:', error.message))
      .finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

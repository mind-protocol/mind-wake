import type { AuthProviderId, AuthState, FlowPhase, MindSession } from './types.ts';

export type AuthEvent =
  | { type: 'restored'; session: MindSession | null; now: number }
  | { type: 'flow'; flow: FlowPhase }
  | { type: 'signed_in'; session: MindSession; now: number }
  | { type: 'failed'; provider: AuthProviderId; message: string }
  | { type: 'signed_out' }
  | { type: 'reset_flow' };

export const initialAuthState: AuthState = { session: { status: 'restoring' }, flow: { phase: 'idle' } };

export function isSessionUsable(session: MindSession | null | undefined, now: number): session is MindSession {
  return !!session && Date.parse(session.expiresAt) > now;
}

export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case 'restored':
      // une restauration tardive ne doit pas écraser une connexion obtenue entre-temps
      if (state.session.status === 'signed_in') return state;
      return { ...state, session: isSessionUsable(event.session, event.now) ? { status: 'signed_in', session: event.session } : { status: 'signed_out' } };
    case 'flow':
      return { ...state, flow: event.flow };
    case 'signed_in':
      if (Date.parse(event.session.expiresAt) <= event.now) return { ...state, flow: { phase: 'error', provider: event.session.identity.provider, message: 'Session expirée reçue du serveur.' } };
      return { session: { status: 'signed_in', session: event.session }, flow: { phase: 'idle' } };
    case 'failed':
      return { ...state, flow: { phase: 'error', provider: event.provider, message: event.message } };
    case 'signed_out':
      return { session: { status: 'signed_out' }, flow: { phase: 'idle' } };
    case 'reset_flow':
      return { ...state, flow: { phase: 'idle' } };
  }
}

/** Un fournisseur est « occupé » pendant une ouverture, un échange ou une vérification. */
export function isBusy(flow: FlowPhase): boolean {
  return flow.phase === 'opening' || flow.phase === 'exchanging' || flow.phase === 'verifying';
}

export type ProviderView = 'unconfigured' | 'idle' | 'pending' | 'error' | 'connected';

export function providerView(state: AuthState, provider: AuthProviderId, configured: boolean): ProviderView {
  if (state.session.status === 'signed_in' && (state.session.session.identities ?? [state.session.session.identity]).some(item => item.provider === provider)) return 'connected';
  if (!configured) return 'unconfigured';
  const flow = state.flow;
  if (flow.phase !== 'idle' && flow.provider === provider) return flow.phase === 'error' ? 'error' : 'pending';
  return 'idle';
}

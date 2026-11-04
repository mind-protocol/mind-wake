// Types partagés de l'authentification sociale. Aucun import React Native ici :
// ce fichier est chargé tel quel par les tests node (--experimental-strip-types).

export type AuthProviderId = 'x' | 'telegram' | 'whatsapp';

export const AUTH_PROVIDERS: readonly AuthProviderId[] = ['x', 'telegram', 'whatsapp'];

/** Configuration publique (EXPO_PUBLIC_*) : jamais de secret. */
export type PublicAuthEnv = {
  authUrl?: string;
  xClientId?: string;
  telegramClientId?: string;
  whatsappBusinessNumber?: string;
};

export type ProviderConfig =
  | { provider: AuthProviderId; configured: false; missing: string[] }
  | { provider: 'x'; configured: true; authUrl: string; clientId: string }
  | { provider: 'telegram'; configured: true; authUrl: string; clientId: string }
  | { provider: 'whatsapp'; configured: true; authUrl: string; businessNumber: string };

/** Identité sociale reliée au compte MIND, telle que confirmée par le serveur. */
export type LinkedIdentity = {
  provider: AuthProviderId;
  /** Identifiant stable chez le fournisseur (id X, id Telegram, numéro E.164 WhatsApp). */
  providerUserId: string;
  /** @username X/Telegram, ou numéro masqué pour WhatsApp. */
  handle: string;
  displayName: string | null;
  verifiedAt: string;
};

/** Session MIND émise par le serveur d'auth après vérification. */
export type MindSession = {
  schemaVersion: 1;
  sessionToken: string;
  expiresAt: string;
  identity: LinkedIdentity;
  mindUserId?: string;
  identities?: LinkedIdentity[];
};

export type LinkContext = { sessionToken: string; linkChallenge: string };

export type SessionState =
  | { status: 'restoring' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; session: MindSession };

export type FlowPhase =
  | { phase: 'idle' }
  | { phase: 'opening'; provider: AuthProviderId }
  | { phase: 'exchanging'; provider: AuthProviderId }
  | { phase: 'awaiting_code'; provider: 'whatsapp'; challengeId: string; expiresAt: string; maskedPhone: string; notice?: string }
  | { phase: 'awaiting_wa_message'; provider: 'whatsapp'; challengeId: string; expiresAt: string; waLink: string; userCode: string; notice?: string }
  | { phase: 'verifying'; provider: AuthProviderId }
  | { phase: 'error'; provider: AuthProviderId; message: string };

export type AuthState = { session: SessionState; flow: FlowPhase };

/** Vérification en attente d'un retour OAuth (X ou Telegram). */
export type PendingOAuth = {
  provider: 'x' | 'telegram';
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  link?: LinkContext;
  generation?: number;
};

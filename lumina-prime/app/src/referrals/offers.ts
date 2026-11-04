import type { DataMode } from '../data/types.ts';

export type ReferralOffer = {
  username: string;
  status: 'example' | 'unconfigured';
  potentialTokens: string | null;
  source: string;
  observedAt: string | null;
  conditions: readonly string[];
};

const EXAMPLES: Readonly<Record<string, string>> = { alice: '100', noe: '60', sora: '40', mae: '25' };
const USERNAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Fixture produit : prime potentielle du PARRAIN, distincte de l’offre d’accueil de l’invité. */
export function referralOffer(username: string, mode: DataMode): ReferralOffer {
  const amount = mode === 'demo' && USERNAME.test(username) ? EXAMPLES[username] : undefined;
  return amount ? {
    username, status: 'example', potentialTokens: amount,
    source: 'Scénario de démonstration · aucun budget réservé', observedAt: '2026-11-04T17:00:00.000Z',
    conditions: ['Exemple de prime après une arrivée vérifiée.', 'Une personne, une seule attribution. Conditions et financement réels à fixer.'],
  } : {
    username, status: 'unconfigured', potentialTokens: null,
    source: 'Aucune offre de parrainage fournie', observedAt: null,
    conditions: ['Aucune prime disponible n’est établie pour cette personne.'],
  };
}

/** Route distincte de compose/don. Aucun montant ni droit à une prime dans le lien. */
export function demoInvitePath(username: string): string {
  if (!USERNAME.test(username)) throw Error('Identifiant invalide.');
  return `invite/${encodeURIComponent(username)}?demo=1`;
}

export function demoInvitationText(name: string, url: string): string {
  return `Découvre MIND avec moi, ${name}.\n${url}\n\nInvitation de démonstration : aucun gain ni paiement réel.`;
}

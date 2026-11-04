import type { Snapshot } from './types.ts';

const observedAt = '2026-11-04T12:00:00.000Z';
const signal = (label: string, value: string, detail: string) => ({ label, value, detail, source: 'Scénario fictif de démonstration', observedAt });

/** Fixtures exclusivement : aucune métrique de ce fichier ne provient d’un compte réel. */
export const demoSnapshot: Snapshot = {
  schemaVersion: 1, mode: 'demo', network: 'solana-devnet', observedAt,
  username: 'vous', balance: '120',
  creators: [
    { username: 'alice', name: 'Alice', initials: 'A', role: 'Artiste & exploratrice', category: 'Créateurs',
      color: '#F1BB98', title: 'Des idées qui deviennent des lieux.',
      description: 'Alice fabrique un petit jardin sonore que l’on compose à plusieurs. Sa première version est prête à être explorée.',
      momentum: 84, spark: [12, 19, 15, 29, 26, 40, 48, 43, 63, 77],
      reasons: ['Une première création à découvrir', 'De nouveaux soutiens indépendants', 'Une communauté qui revient'],
      signals: [signal('Nouveaux soutiens', '+6', 'Six soutiens dans ce scénario, sur les dernières 24 heures.'),
        signal('Création', '1', 'Un jardin sonore fictif, utilisé ici pour présenter le parcours.'),
        signal('Premiers achats', '2', 'Deux achats fictifs. Ces signaux ne promettent aucune prime.')],
      tags: ['Art génératif', 'Collectif'] },
    { username: 'noe', name: 'Noé', initials: 'N', role: 'Bâtisseur d’outils', category: 'Bâtisseurs',
      color: '#C3D7F3', title: 'Un atelier pour les choses utiles.',
      description: 'Il imagine des outils simples pour faire travailler les idées ensemble. Son carnet de prototypes invite à participer.',
      momentum: 72, spark: [14, 11, 24, 20, 31, 42, 37, 55, 60, 68],
      reasons: ['Un nouvel outil ouvert', 'Des retours précis de ses utilisateurs'],
      signals: [signal('Nouveaux soutiens', '+4', 'Quatre soutiens fictifs dans la journée.'),
        signal('Prototype', '1', 'Un outil fictif montré dans la démonstration.')], tags: ['Outils', 'Open source'] },
    { username: 'sora', name: 'Sora', initials: 'S', role: 'Chercheuse de liens', category: 'Explorateurs',
      color: '#D8C7E8', title: 'Cartographier ce qui nous relie.',
      description: 'Une recherche sensible sur les rencontres dans la ville. Elle partage ses notes et cherche des regards nouveaux.',
      momentum: 65, spark: [8, 15, 12, 28, 32, 25, 39, 42, 56, 60],
      reasons: ['Des notes de recherche partagées', 'Des rencontres qui ouvrent un projet'],
      signals: [signal('Nouveaux soutiens', '+3', 'Trois soutiens fictifs dans la journée.'),
        signal('Notes', '4', 'Quatre notes fictives pour illustrer les signaux de recherche.')], tags: ['Recherche', 'Rencontres'] },
    { username: 'mae', name: 'Maé', initials: 'M', role: 'Designer de communautés', category: 'Créateurs',
      color: '#CEE4BB', title: 'Une place pour les premières fois.',
      description: 'Elle invente un lieu où présenter une idée encore fragile, rencontrer des complices et faire un premier essai.',
      momentum: 58, spark: [6, 10, 16, 12, 24, 26, 32, 40, 38, 50],
      reasons: ['Un espace d’accueil proposé', 'Des premières contributions'],
      signals: [signal('Nouveaux soutiens', '+2', 'Deux soutiens fictifs dans la journée.'),
        signal('Contributions', '3', 'Trois contributions fictives à son idée.')], tags: ['Design', 'Communautés'] },
  ],
  positions: [
    { id: 'demo-position-alice', username: 'alice', name: 'Alice', principal: '10', returned: '0', status: 'pending',
      endsAt: '2026-11-05T12:00:00.000Z', activation: null, purchase: null, donations: null, proof: null },
    { id: 'demo-position-noe', username: 'noe', name: 'Noé', principal: '5', returned: '5', status: 'settled',
      endsAt: '2026-11-03T12:00:00.000Z', activation: '1', purchase: '0', donations: '1', proof: 'Reçu fictif DEMO-002' },
  ],
  receipts: [
    { id: 'demo-receipt-1', title: 'Soutien à Alice', detail: 'Round d’exemple ouvert · aucune mise réelle', amount: '-10', at: observedAt, status: 'pending' },
    { id: 'demo-receipt-2', title: 'Mise rendue · Noé', detail: 'Principal remboursé en premier · reçu fictif', amount: '+5', at: '2026-11-03T12:00:00.000Z', status: 'confirmed' },
    { id: 'demo-receipt-3', title: 'Primes d’exemple · Noé', detail: 'Activation 1 ◈ · dons 1 ◈ · barème illustratif', amount: '+2', at: '2026-11-03T12:00:00.000Z', status: 'confirmed' },
  ],
};

export const disconnectedSnapshot: Snapshot = {
  schemaVersion: 1, mode: 'live', network: 'solana-devnet', observedAt: '', username: 'vous',
  balance: null, creators: [], positions: [], receipts: [],
};

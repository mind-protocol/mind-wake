import type { Creator, Snapshot } from './types.ts';

const MAX = (1n << 64n) - 1n;
export function parseAmount(text: string): { decimal: string; raw: string } {
  if (!/^\d+(?:[.,]\d{1,9})?$/.test(text.trim())) throw Error('Choisis un montant positif, avec au plus 9 décimales.');
  const [whole, fraction = ''] = text.trim().replace(',', '.').split('.');
  const raw = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (raw <= 0n || raw > MAX) throw Error('Ce montant est hors limites.');
  const decimals = fraction.replace(/0+$/, '');
  return { decimal: `${BigInt(whole)}${decimals ? `.${decimals}` : ''}`, raw: raw.toString() };
}

export function formatMind(value: string | null): string {
  if (value === null) return '—';
  if (!/^[+-]?\d+(?:\.\d{1,9})?$/.test(value)) return '—';
  const [whole, decimals] = value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + (decimals ? `,${decimals.replace(/0+$/, '')}`.replace(/,$/, '') : '');
}

export function buildGiftDraft(creator: Pick<Creator, 'username' | 'name' | 'title'>, amount: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(creator.username)) throw Error('Destinataire invalide.');
  const parsed = parseAmount(amount);
  return `${creator.title}\nJe découvre @${creator.username} et je soutiens son travail.\n\n+${parsed.decimal} MIND @${creator.username}`;
}

export function xDraftUrl(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

export function validateDraftCommand(text: string, username: string, amount: string): string | null {
  const commands = text.split(/\r?\n/).map(line => line.trim()).filter(line => /^\+\S+[ \t]+MIND\b/i.test(line));
  if (commands.length !== 1) return 'Garde une seule commande de soutien dans ce brouillon.';
  const match = /^\+(\d+(?:[.,]\d{1,9})?)[ \t]+MIND[ \t]+@([a-z0-9][a-z0-9_-]{0,31})$/i.exec(commands[0]);
  if (!match || match[2].toLowerCase() !== username) return 'Le destinataire du texte doit correspondre à la personne choisie.';
  try { if (parseAmount(match[1]).raw !== parseAmount(amount).raw) return 'Le montant du texte doit correspondre au montant choisi.'; }
  catch { return 'Corrige le montant de la commande.'; }
  return null;
}

export function filterCreators(creators: Creator[], category: string, query: string): Creator[] {
  const normalized = query.trim().toLocaleLowerCase('fr');
  return creators.filter(person => (category === 'Tout' || person.category === category)
    && `${person.name} ${person.username} ${person.role} ${person.tags.join(' ')}`.toLocaleLowerCase('fr').includes(normalized));
}

export function validateLiveSnapshot(input: unknown): Snapshot {
  const s = input as Partial<Snapshot> | null;
  if (!s || s.schemaVersion !== 1 || s.mode !== 'live' || s.network !== 'solana-devnet'
      || !Array.isArray(s.creators) || !Array.isArray(s.positions) || !Array.isArray(s.receipts)
      || typeof s.username !== 'string' || typeof s.observedAt !== 'string'
      || !(s.balance === null || (typeof s.balance === 'string' && /^\d+(?:\.\d{1,9})?$/.test(s.balance)))) {
    throw Error('Les données reçues ne permettent pas d’afficher un solde vérifié.');
  }
  for (const person of s.creators) {
    if (!person || typeof person.username !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(person.username)
        || typeof person.name !== 'string' || !Array.isArray(person.signals) || !Array.isArray(person.tags)
        || !Array.isArray(person.reasons) || !Array.isArray(person.spark)
        || !['initials', 'role', 'category', 'color', 'title', 'description'].every(key => typeof person[key as keyof typeof person] === 'string')
        || !person.spark.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        || !person.tags.every((value: unknown) => typeof value === 'string') || !person.reasons.every((value: unknown) => typeof value === 'string')
        || !person.signals.every((signal: unknown) => signal && typeof signal === 'object' && ['label', 'value', 'detail', 'source', 'observedAt'].every(key => typeof (signal as Record<string, unknown>)[key] === 'string')))
      throw Error('Un profil reçu est incomplet.');
  }
  const decimal = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d{1,9})?$/.test(value);
  for (const position of s.positions) {
    if (!position || !['id', 'username', 'name', 'endsAt'].every(key => typeof position[key as keyof typeof position] === 'string')
        || !decimal(position.principal) || !decimal(position.returned) || !['pending', 'settled'].includes(position.status)
        || ![position.activation, position.purchase, position.donations].every(value => value === null || decimal(value))
        || !(position.proof === null || typeof position.proof === 'string') || (position.status === 'settled' && !position.proof))
      throw Error('Un soutien reçu ne possède pas les informations nécessaires.');
  }
  for (const receipt of s.receipts) {
    if (!receipt || !['id', 'title', 'detail', 'at'].every(key => typeof receipt[key as keyof typeof receipt] === 'string')
        || !['pending', 'confirmed'].includes(receipt.status)
        || !(receipt.amount === null || typeof receipt.amount === 'string' && /^[+-]?\d+(?:\.\d{1,9})?$/.test(receipt.amount)))
      throw Error('Un reçu est incomplet.');
  }
  return s as Snapshot;
}

export async function fetchLiveSnapshot(endpoint: string | undefined, options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {}): Promise<Snapshot> {
  if (!endpoint) throw Error('Ton compte n’est pas encore relié. Les soldes et signaux réels apparaîtront après connexion.');
  const url = new URL(endpoint);
  if (url.username || url.password || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw Error('Le point de connexion doit être sécurisé.');
  }
  const response = await (options.fetchImpl ?? fetch)(url.toString(), { method: 'GET', signal: options.signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw Error('La connexion est momentanément indisponible. Ton solde reste inconnu.');
  return validateLiveSnapshot(await response.json());
}

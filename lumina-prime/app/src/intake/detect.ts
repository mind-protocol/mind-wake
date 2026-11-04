/**
 * Texte lu (OCR, collage) -> commandes de soutien candidates.
 * Une candidate est une DÉTECTION D'INTENTION : elle pré-remplit le compositeur,
 * l'utilisateur relit montant et destinataire puis agit lui-même. Aucune
 * autorisation n'est créée ici (authorization reste "not_granted").
 * Module pur : aucune dépendance native.
 */
import {
  preparePaymentCommand,
  type PaymentCommandOrigin,
  type PreparedPaymentCommand,
} from '../domain/payment-command.ts';

export type Repair =
  | 'chiffre_corrige' // O/o lu à la place de 0, l/I/| à la place de 1
  | 'mot_mind_corrige' // M1ND, mind, MlND…
  | 'arobase_absente' // « +10 MIND alice »
  | 'arobase_corrigee' // © lu à la place de @
  | 'casse_identifiant' // @Alice -> alice
  | 'espaces_corriges' // « + 10 », « 10MIND », « @ alice »
  | 'multiligne'; // commande coupée par un retour à la ligne

export const REPAIR_LABELS: Readonly<Record<Repair, string>> = Object.freeze({
  chiffre_corrige: 'Montant relu : une lettre a été lue comme un chiffre (O→0, l→1).',
  mot_mind_corrige: 'Le mot MIND a été reconnu malgré une lecture imparfaite.',
  arobase_absente: 'Le @ manquait devant le destinataire.',
  arobase_corrigee: 'Un symbole a été lu à la place du @.',
  casse_identifiant: 'Le nom a été mis en minuscules.',
  espaces_corriges: 'Des espaces ont été corrigés dans la commande.',
  multiligne: 'La commande était coupée sur plusieurs lignes.',
});

export type Candidate = Readonly<{
  key: string;
  amount: string;
  amountAtomic: string;
  recipientUsername: string;
  canonicalCommand: string;
  excerpt: string;
  repairs: readonly Repair[];
  occurrences: number;
  payment: PreparedPaymentCommand;
}>;

export type RejectedFragment = Readonly<{ excerpt: string; reason: string }>;

export type Detection = Readonly<{
  candidates: readonly Candidate[];
  rejected: readonly RejectedFragment[];
  truncated: boolean;
}>;

export const MAX_INPUT = 20_000;
export const MAX_CANDIDATES = 20;

const REASONS: Record<string, string> = {
  zero_amount: 'Montant nul.',
  amount_overflow: 'Montant hors limites.',
  invalid_command: 'Commande illisible.',
  invalid_origin: 'Provenance invalide.',
};

// Amount: digits, or letters OCR commonly confuses with digits.
const AMT = '([0-9OolI|][0-9OolI|]*(?:[.,][0-9OolI|]{1,12})?)';
const MIND = '([Mm][IiLl1|][Nn][Dd])';
// @ (or a common misread), optional space, then the handle.
const USER = '(@|©)?([ \\n]*)([A-Za-z0-9][A-Za-z0-9_-]*)(?![A-Za-z0-9_@-]|\\.[A-Za-z0-9])';
const WS = '[ \\n]*';
// +10 MIND @alice
const PLUS_FORM = new RegExp(`\\+(${WS})${AMT}(${WS})${MIND}(${WS})${USER}`, 'g');
// ◈ 10 @alice  /  $MIND 10 @alice
const SYMBOL_FORM = new RegExp(`(◈|\\$ ?${MIND.replace('(', '(?:')})(${WS})${AMT}(${WS})${USER}`, 'g');

/** Normalise the raw OCR text without guessing content. */
export function normalizeOcrText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/ *\n */g, '\n');
}

function fixDigits(token: string): { value: string; fixed: boolean } {
  const value = token.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
  return { value, fixed: value !== token };
}

type Raw = { index: number; excerpt: string; amount: string; mind: string | null;
  spaces: string[]; at: string | undefined; user: string };

function collect(text: string): Raw[] {
  const out: Raw[] = [];
  for (const m of text.matchAll(PLUS_FORM)) {
    const [whole, s1, amount, s2, mind, s3, at, s4, user] = m;
    out.push({ index: m.index ?? 0, excerpt: whole, amount, mind, spaces: [s1, s2, s3, s4], at, user });
  }
  for (const m of text.matchAll(SYMBOL_FORM)) {
    const [whole, symbol, s1, amount, s2, at, s3, user] = m;
    const mind = symbol === '◈' ? null : symbol.replace(/^\$ ?/, '');
    const spaces = [s1, s2, s3, symbol.includes(' ') ? ' ' : ''];
    out.push({ index: m.index ?? 0, excerpt: whole, amount, mind, spaces, at, user });
  }
  return out.sort((a, b) => a.index - b.index);
}

function spacingRepaired(raw: Raw, plus: boolean): boolean {
  const [a, b, c, d] = raw.spaces.map(value => value.replace(/\n+/g, ' '));
  if (plus) {
    // canonical: "+10 MIND @alice"
    return a !== '' || b !== ' ' || (raw.at ? c !== ' ' || d !== '' : false);
  }
  // canonical: "◈ 10 @alice"
  return a !== ' ' || (raw.at ? b !== ' ' || c !== '' : false) || d !== '';
}

/**
 * Detect payment commands in free text. The origin describes where the text
 * comes from ("ocr" for a capture, "unknown" for pasted text); it never
 * authorizes anything.
 */
export function detectPaymentCandidates(
  rawText: string,
  origin: PaymentCommandOrigin = 'ocr',
): Detection {
  const truncated = rawText.length > MAX_INPUT;
  const text = normalizeOcrText(truncated ? rawText.slice(0, MAX_INPUT) : rawText);
  const byKey = new Map<string, { candidate: Candidate; count: number }>();
  const rejected: RejectedFragment[] = [];
  const takenUntil: number[] = [];

  for (const raw of collect(text)) {
    // Skip a match overlapping an earlier one (both forms can see "$MIND").
    if (takenUntil.some(end => raw.index < end)) continue;
    takenUntil.push(raw.index + raw.excerpt.length);

    const excerpt = raw.excerpt.replace(/\n/g, ' ⏎ ').slice(0, 120);
    const repairs = new Set<Repair>();
    const plus = raw.excerpt.startsWith('+');
    const digits = fixDigits(raw.amount);
    if (digits.fixed) repairs.add('chiffre_corrige');
    if (raw.mind !== null && raw.mind !== 'MIND') repairs.add('mot_mind_corrige');
    if (!raw.at) {
      // Without @, require a real separator so "MINDalice" is not split.
      const sep = plus ? raw.spaces[2] : raw.spaces[1];
      if (sep === '') continue;
      // « +10 MIND pour @alice » : the handle is further away, do not guess.
      if (/^\s+[@©]/.test(text.slice(raw.index + raw.excerpt.length))) continue;
      repairs.add('arobase_absente');
    } else if (raw.at === '©') repairs.add('arobase_corrigee');
    if (raw.excerpt.includes('\n')) repairs.add('multiligne');
    if (spacingRepaired(raw, plus)) repairs.add('espaces_corriges');
    const user = raw.user.toLowerCase();
    if (user !== raw.user) repairs.add('casse_identifiant');

    if (user.length > 32) {
      rejected.push(Object.freeze({ excerpt, reason: 'Nom de destinataire trop long.' }));
      continue;
    }
    const result = preparePaymentCommand(`◈ ${digits.value} @${user}`, origin);
    if (!result.ok) {
      rejected.push(Object.freeze({ excerpt, reason: REASONS[result.error] ?? 'Commande illisible.' }));
      continue;
    }
    const payment = result.payment;
    const key = `${payment.amountAtomic}:${payment.recipientUsername}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    if (byKey.size >= MAX_CANDIDATES) continue;
    byKey.set(key, {
      count: 1,
      candidate: {
        key,
        amount: payment.amount,
        amountAtomic: payment.amountAtomic,
        recipientUsername: payment.recipientUsername,
        canonicalCommand: payment.canonicalCommand,
        excerpt,
        repairs: Object.freeze([...repairs]),
        occurrences: 1,
        payment,
      },
    });
  }

  const candidates = [...byKey.values()].map(({ candidate, count }) =>
    Object.freeze({ ...candidate, occurrences: count }));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    rejected: Object.freeze(rejected),
    truncated,
  });
}

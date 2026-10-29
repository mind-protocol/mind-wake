/**
 * Prépare le kit de test devnet : `npm run devnet:kit`. Réseau devnet uniquement ; aucune
 * clé réelle, aucun mainnet. Le faucet public peut refuser (limite de débit) : relancer
 * plus tard, ou financer l'adresse du payeur affichée via faucet.solana.com.
 */

import { DEFAULT_KIT_PATH, ensureKit } from "./kit.js";

const path = process.argv[2] ?? DEFAULT_KIT_PATH;
ensureKit(path, undefined, (line) => {
  console.log(line);
}).catch((error: unknown) => {
  console.error(`échec : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

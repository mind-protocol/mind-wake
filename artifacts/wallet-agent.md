# Wallet de l’agent

Vérifié le 4 novembre 2026 avec `showWallet` : coffre rouvert et correspondance clé/adresse contrôlée.

- Adresse publique : `CpWa8Ep8VLN9wS817Nn8gdiXTBgmmFNzGc72Vo6EaZhk`.
- Coffre existant : `C:/Users/reyno/AppData/Local/mind-wake-essai/credentials/wallet-solana/wallet.json`.
- Clé chiffrée avec Windows DPAPI CurrentUser. Conserver ce coffre et le profil Windows ; cette note publique ne constitue pas une sauvegarde de récupération de la clé.
- Réouverture : `node scripts/wallet-solana.mjs show --home C:/Users/reyno/AppData/Local/mind-wake-essai/credentials/wallet-solana`.
- L’adresse peut recevoir sur devnet ; le helper `inspect` existant ne consulte que mainnet.

## Crédit devnet demandé

L’humain a demandé 100 $MIND de test sur devnet. Aucun crédit effectué : le mint historique `2CSCaMuniWJ4Wj4jp75TAS2HzsLLVPRtM4B2dh9bad57` est absent du devnet interrogé le 4 novembre ; le payeur du kit dispose de 0 lamport. Le faucet RPC officiel a refusé la demande avec HTTP 410 Gone.

Reprise : financer via le faucet officiel `https://faucet.solana.com` le payeur devnet `9JsmQfeq6UAyrgLCaUgacCtCDE3o2XJfM4XhyXtnHjA7` (au moins 0,2 SOL de test), puis lancer `npm run devnet:kit`. Le script local `.local/solana-devnet/fund-agent-100.mjs` prépare une émission de 100 jetons vers le wallet ci-dessus, vérifie le réseau et sauvegarde la signature avant l’envoi dans `.local/solana-devnet/agent-funding-100-20261104.json`. Si ce reçu existe, vérifier sa signature sans émettre une seconde fois. Les clés du kit sont locales et ne doivent pas être copiées dans cette note.

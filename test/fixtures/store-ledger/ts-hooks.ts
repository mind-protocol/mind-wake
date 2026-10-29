/**
 * Hooks de résolution pour exécuter les sources TypeScript dans un processus enfant
 * (type stripping natif de Node 24+) : `./x.js` est résolu vers `./x.ts` s'il n'existe
 * pas de fichier `.js`. Réservé aux tests multi-processus.
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && specifier.endsWith(".js")) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});

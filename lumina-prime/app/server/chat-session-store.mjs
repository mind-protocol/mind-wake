import fs from 'node:fs';
import path from 'node:path';
/** Only token digests, never bearer tokens, are persisted outside the repository. */
export function createChatSessionStore(file) {
  return {
    load() {
      if (!fs.existsSync(file)) return [];
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(value) || value.length > 100 || value.some(row => !Array.isArray(row)
        || !/^[a-f0-9]{64}$/.test(row[0]) || !Number.isFinite(row[1]?.expiresAt))) throw Error('Invalid private session store');
      return value.filter(row => row[1].expiresAt > Date.now());
    },
    save(value) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.pending', JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(file + '.pending', file);
    },
  };
}

import type { LibraryEntry, AuroreSyncStatus } from "./document-library.js";
export interface AuroreCatalog {
  state?: string;
  version?: string;
  entries: LibraryEntry[];
  truncated?: boolean;
  sync?: AuroreSyncStatus;
}
/** A local catalogue probe may finish after navigation. Apply only to its original generation. */
export async function refreshAuroreCatalog(
  read: () => Promise<AuroreCatalog>,
  accepts: () => boolean,
  apply: (catalog: AuroreCatalog) => Promise<void>,
): Promise<void> {
  const catalog = await read();
  if (accepts()) await apply(catalog);
}

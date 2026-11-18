export const STATUS: { readonly PENDING: "en attente"; readonly DELIVERED: "livré"; readonly FAILED: "échec" };
export const BODY_MAX: number;
export const HEARTBEAT_FRESH_MS: number;
export interface PontSettings { enabled: boolean; name: string | null; annuaire: boolean; updatedAt: string | null }
export interface PontPaths {
  dataDir: string; settings: string; key: string; state: string; carnet: string; outbox: string; seen: string;
  conflicts: string; status: string; pid: string; log: string; requests: string; results: string; received: string; tmp: string;
}
export function pontPaths(dataDir: string): PontPaths;
export function readSettings(dataDir: string): PontSettings;
export function serviceAlive(dataDir: string, now?: number): boolean;
export function newMessageId(): string;
export function enqueueRequest(dataDir: string, op: Record<string, unknown>): string;
export function awaitResult(dataDir: string, rid: string, ms?: number): Promise<Record<string, unknown> | null>;
export function messageStatus(dataDir: string, id: string): Record<string, unknown> & { ok: boolean };
export function resolveFromDisk(dataDir: string, addr: string): Record<string, unknown> & { ok: boolean };
export function fingerprint(publicKey: string | null | undefined): string | null;

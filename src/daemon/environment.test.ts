import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSnapshot, RuntimeAdapter, RuntimeGroup } from "../contracts/index.js";
import { QUOTA_CACHE_MS, RuntimeEnvironment } from "./environment.js";

const SNAPSHOT = {
  windowKey: "claude:session",
  windowDurationMs: 18_000_000,
  usedBasisPoints: 2_100,
  resetsAt: "2026-10-29T15:59:59.000Z",
  observedAt: "2026-10-29T14:05:38.000Z",
  provenance: "measured",
} as ProviderQuotaSnapshot;

function environment(readQuota: () => Promise<readonly ProviderQuotaSnapshot[]>) {
  const adapter = { readQuota } as unknown as RuntimeAdapter;
  return new RuntimeEnvironment(
    adapter,
    {} as RuntimeGroup,
    { kind: "subscription_quota" },
    () => true,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("jauge de quota du daemon", () => {
  it("une seule lecture en vol : les tours pendant la lecture la partagent", async () => {
    let resolve: (value: readonly ProviderQuotaSnapshot[]) => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<readonly ProviderQuotaSnapshot[]>((r) => {
          resolve = r;
        }),
    );
    const env = environment(read);
    const first = env.quotaSnapshots();
    const second = env.quotaSnapshots();
    expect(read).toHaveBeenCalledTimes(1);
    resolve([SNAPSHOT]);
    expect(await first).toEqual([SNAPSHOT]);
    expect(await second).toEqual([SNAPSHOT]);
  });

  it("lecture réussie réutilisée pendant la durée du cache, relue ensuite", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-29T14:05:38Z") });
    const read = vi.fn(() => Promise.resolve([SNAPSHOT]));
    const env = environment(read);
    await env.quotaSnapshots();
    await env.quotaSnapshots();
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(QUOTA_CACHE_MS + 1);
    await env.quotaSnapshots();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("lecture vide : jamais mise en cache, relue au tour suivant", async () => {
    const read = vi.fn(() => Promise.resolve([] as readonly ProviderQuotaSnapshot[]));
    const env = environment(read);
    expect(await env.quotaSnapshots()).toEqual([]);
    await env.quotaSnapshots();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

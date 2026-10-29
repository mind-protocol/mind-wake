import { describe, expect, it } from "vitest";
import type {
  JournalEvent,
  JournalEventInput,
  JournalRepository,
  ProfileId,
  UtcTimestamp,
} from "../contracts/index.js";
import { ALL_SECRETS, SECRET_TRAPS, SENSITIVE_KEY_TRAPS } from "../../test/fixtures/secrets.js";
import { MemoryJournalRepository } from "./memory.js";
import { DEFAULT_METADATA_LIMITS, MAX_REASON_LENGTH, TRUNCATED_KEY } from "./sanitize.js";
import { JournalError, JournalWriter, type JournalRecordRequest } from "./writer.js";

const profileId = "default" as ProfileId;
const at = "2026-10-29T10:00:00.000Z" as UtcTimestamp;

function request(overrides: Partial<JournalRecordRequest> = {}): JournalRecordRequest {
  return { type: "error", at, profileId, reason: "test", metadata: {}, ...overrides };
}

describe("JournalWriter", () => {
  it("attribue des séquences strictement croissantes", () => {
    const writer = new JournalWriter(new MemoryJournalRepository());
    const sequences = [1, 2, 3].map(() => writer.record(request()).sequence);
    expect(sequences).toEqual([1, 2, 3]);
  });

  it("refuse un dépôt qui renvoie une séquence non croissante", () => {
    const stuck: JournalRepository = {
      append: (event: JournalEventInput): JournalEvent => ({
        ...event,
        schemaVersion: 1,
        sequence: 7,
      }),
      list: () => [],
    };
    const writer = new JournalWriter(stuck);
    writer.record(request());
    expect(() => writer.record(request())).toThrow(JournalError);
  });

  it("refuse un type inconnu ou un horodatage non UTC", () => {
    const writer = new JournalWriter(new MemoryJournalRepository());
    expect(() => writer.record(request({ type: "made_up" as JournalEventInput["type"] }))).toThrow(
      JournalError,
    );
    expect(() =>
      writer.record(request({ at: "2026-10-29T10:00:00+01:00" as UtcTimestamp })),
    ).toThrow(JournalError);
  });

  it("ne laisse aucun secret piège atteindre le dépôt", () => {
    const repo = new MemoryJournalRepository();
    const writer = new JournalWriter(repo);
    for (const trap of SECRET_TRAPS) {
      writer.record(
        request({ reason: trap.text, metadata: { detail: trap.text, [trap.name]: [trap.text] } }),
      );
    }
    writer.record(request({ reason: "clés sensibles", metadata: SENSITIVE_KEY_TRAPS }));
    writer.record(
      request({ reason: "erreur", metadata: { error: new Error(SECRET_TRAPS[0]?.text) } }),
    );
    const stored = JSON.stringify(repo.list(profileId));
    for (const secret of ALL_SECRETS) expect(stored).not.toContain(secret);
  });

  it("borne la taille des métadonnées et du motif", () => {
    const repo = new MemoryJournalRepository();
    const writer = new JournalWriter(repo);
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    const manyKeys = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${String(i)}`, i]),
    );
    const event = writer.record(
      request({
        reason: "r".repeat(10_000),
        metadata: {
          long: "y".repeat(10_000),
          deep,
          manyKeys,
          list: Array.from({ length: 100 }, () => 1),
        },
      }),
    );
    expect(event.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    const bytes = Buffer.byteLength(JSON.stringify(event.metadata), "utf8");
    expect(bytes).toBeLessThanOrEqual(DEFAULT_METADATA_LIMITS.maxTotalBytes);
    expect(JSON.stringify(event.metadata)).toContain("tronqué");
    expect(JSON.stringify(event.metadata)).toContain("profondeur maximale");
  });

  it("remplace des métadonnées trop volumineuses après bornage par un marqueur", () => {
    const repo = new MemoryJournalRepository();
    const writer = new JournalWriter(repo);
    const big = Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [`k${String(i)}`, "z".repeat(400)]),
    );
    const event = writer.record(request({ metadata: big }));
    expect(Object.keys(event.metadata)).toEqual([TRUNCATED_KEY]);
  });

  it("convertit les valeurs non JSON", () => {
    const writer = new JournalWriter(new MemoryJournalRepository());
    const event = writer.record(
      request({
        metadata: {
          nan: Number.NaN,
          big: 10n,
          date: new Date(at),
          fn: () => 1,
          undef: undefined,
        },
      }),
    );
    expect(event.metadata).toEqual({ nan: null, big: "10", date: at, fn: null, undef: null });
  });

  it("met le motif sur une seule ligne", () => {
    const writer = new JournalWriter(new MemoryJournalRepository());
    expect(writer.record(request({ reason: "a\nb\r\nc" })).reason).toBe("a b c");
  });
});

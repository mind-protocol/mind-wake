import { describe, expect, it } from "vitest";
import { CALL_LOAD_LIMIT_MS, CALL_RETRY_MS, callWaitStatus, shouldReopenCall } from "./call-frame.js";

describe("iframe d'appel", () => {
  it("ne relance pas un chargement lent encore en cours (WebView2 chargé)", () => {
    expect(shouldReopenCall({ hidden: true, loaded: false, openedAt: 0, now: CALL_RETRY_MS + 5000 })).toBe(false);
    expect(callWaitStatus({ hidden: true, loaded: false, openedAt: 0, now: 10_000 })).toBe("loading");
  });
  it("réessaie après un chargement fini sans ready", () => {
    expect(shouldReopenCall({ hidden: true, loaded: true, openedAt: 0, now: CALL_RETRY_MS })).toBe(true);
    expect(callWaitStatus({ hidden: true, loaded: true, openedAt: 0, now: 10_000 })).toBe("unavailable");
  });
  it("réessaie si load n'arrive jamais, au-delà de la limite", () => {
    expect(shouldReopenCall({ hidden: true, loaded: false, openedAt: 0, now: CALL_LOAD_LIMIT_MS })).toBe(true);
    expect(callWaitStatus({ hidden: true, loaded: false, openedAt: 0, now: CALL_LOAD_LIMIT_MS })).toBe("unavailable");
  });
  it("ne touche pas un écran d'appel affiché", () => {
    expect(shouldReopenCall({ hidden: false, loaded: true, openedAt: 0, now: 10 * CALL_LOAD_LIMIT_MS })).toBe(false);
  });
});

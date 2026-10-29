import { describe, expect, it } from "vitest";
import {
  SECRET_TRAPS,
  SENSITIVE_KEY_SECRETS,
  SENSITIVE_KEY_TRAPS,
} from "../../test/fixtures/secrets.js";
import {
  isSensitiveKey,
  MAX_SCANNED_STRING_LENGTH,
  REDACTED,
  redactString,
  redactValue,
} from "./redact.js";

describe("redactString", () => {
  for (const trap of SECRET_TRAPS) {
    it(`masque : ${trap.name}`, () => {
      const output = redactString(trap.text);
      expect(output).not.toContain(trap.secret);
      expect(output).toContain(REDACTED);
    });
  }

  it("laisse intact un texte sans secret", () => {
    const texts = [
      "session terminée : 1200 tokens mesurés, checkpoint 3 publié",
      "tokensPerSession=5000 checkpointTokens=200",
      "authMode: chatgpt, provider: openai",
      "fenêtre 22:00-06:00 Europe/Paris",
      "C:\\Users\\wake\\explorations\\notes.md",
    ];
    for (const text of texts) expect(redactString(text)).toBe(text);
  });

  it("omet une chaîne trop longue au lieu de la couper", () => {
    const huge = "a".repeat(MAX_SCANNED_STRING_LENGTH + 1);
    expect(redactString(huge)).toMatch(/^\[valeur omise : \d+ caractères\]$/);
  });

  it("reste linéaire sur une entrée pathologique", () => {
    const inputs = [
      "a".repeat(MAX_SCANNED_STRING_LENGTH),
      "password".repeat(MAX_SCANNED_STRING_LENGTH / 8),
      "x://".repeat(MAX_SCANNED_STRING_LENGTH / 4),
      "-----BEGIN PRIVATE KEY-----" + " ".repeat(MAX_SCANNED_STRING_LENGTH - 40),
    ];
    const started = performance.now();
    for (const input of inputs) redactString(input);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("clés sensibles", () => {
  it("reconnaît les noms de secrets, pas les compteurs de tokens", () => {
    for (const key of [
      "apiKey",
      "OPENAI_API_KEY",
      "accessToken",
      "client_secret",
      "Authorization",
      "DB_PASSWORD",
      "connectionString",
      "x-api-key",
      "Cookie",
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
    for (const key of [
      "tokensPerSession",
      "checkpointTokens",
      "userReserveTokens",
      "tokenBreakdown",
      "authMode",
      "sessionId",
      "PATH",
    ]) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it("remplace la valeur entière d'une clé sensible, à toute profondeur", () => {
    const output = JSON.stringify(redactValue(SENSITIVE_KEY_TRAPS));
    for (const secret of SENSITIVE_KEY_SECRETS) expect(output).not.toContain(secret);
    expect(output).toContain("C:\\\\Windows");
  });
});

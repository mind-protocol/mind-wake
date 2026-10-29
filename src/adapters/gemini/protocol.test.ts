import { describe, expect, it } from "vitest";
import { buildArgs, policyDocument, settingsDocument } from "./config.js";
import { decideLaunch } from "./launch.js";
import { classifyError, classifyExitCode, parseStreamLine, retryDelayMs } from "./protocol.js";

describe("parseStreamLine", () => {
  it("lit les six types documentés et tolère l'inconnu", () => {
    expect(parseStreamLine('{"type":"init","session_id":"abc","model":"m"}')).toEqual({
      kind: "init",
      sessionId: "abc",
      model: "m",
    });
    expect(parseStreamLine('{"type":"tool_use","tool_name":"glob","tool_id":"1"}')).toMatchObject({
      kind: "tool_use",
      toolName: "glob",
    });
    expect(parseStreamLine('{"type":"later"}')).toEqual({ kind: "unknown", type: "later" });
    expect(parseStreamLine('{"type":"result","status":"succ')).toEqual({ kind: "malformed" });
    expect(parseStreamLine("[1,2]")).toEqual({ kind: "malformed" });
  });

  it("refuse des statistiques incomplètes ou négatives", () => {
    const result = parseStreamLine(
      '{"type":"result","status":"success","stats":{"total_tokens":-1,"input_tokens":1,"output_tokens":1}}',
    );
    expect(result).toMatchObject({ kind: "result", stats: null });
  });
});

describe("classification des erreurs", () => {
  it("reconnaît les limitations de quota et leur délai", () => {
    expect(classifyError("TerminalQuotaError", "x")).toEqual({
      kind: "rate_limited",
      retryAfterMs: null,
    });
    expect(classifyError("", "429 Too Many Requests. Please retry in 2.5s")).toEqual({
      kind: "rate_limited",
      retryAfterMs: 2_500,
    });
    expect(retryDelayMs("Suggested retry after 60s.")).toBe(60_000);
    expect(retryDelayMs("rien")).toBeNull();
  });

  it("reconnaît l'authentification et les codes de sortie", () => {
    expect(classifyError("FatalAuthenticationError", "")).toEqual({
      kind: "error",
      code: "auth_failed",
    });
    expect(classifyError("ApiError", "500 internal")).toEqual({ kind: "error", code: "transient" });
    expect(classifyExitCode(41).code).toBe("auth_failed");
    expect(classifyExitCode(42).code).toBe("incompatible");
    expect(classifyExitCode(55).code).toBe("incompatible");
    expect(classifyExitCode(54).code).toBe("fatal");
    expect(classifyExitCode(1).code).toBe("transient");
  });
});

describe("configuration", () => {
  it("construit les arguments documentés", () => {
    expect(
      buildArgs({
        prompt: "bonjour",
        model: "gemini-2.5-pro",
        approvalMode: "default",
        resumeSessionId: "8f1c2b7e-4d3a-4f6b-9a21-0c5e7d9b1a33",
      }),
    ).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "gemini-2.5-pro",
      "--approval-mode",
      "default",
      "--skip-trust",
      "--resume",
      "8f1c2b7e-4d3a-4f6b-9a21-0c5e7d9b1a33",
      "--prompt=bonjour",
    ]);
    expect(() =>
      buildArgs({ prompt: "x", model: "m", approvalMode: "default", resumeSessionId: "latest" }),
    ).toThrow(/invalide/);
    expect(() => buildArgs({ prompt: "x", model: "--yolo", approvalMode: "default" })).toThrow();
    expect(() => buildArgs({ prompt: "", model: "m", approvalMode: "default" })).toThrow();
  });

  it("produit des réglages et une politique sans injection", () => {
    const settings = settingsDocument({
      model: "gemini-2.5-pro",
      maxSessionTurns: 10,
      coreTools: ["read_file"],
      excludedTools: ["web_fetch"],
    });
    expect(settings["tools"]).toEqual({ core: ["read_file"], exclude: ["web_fetch"] });
    expect(() => policyDocument(['x"\ndecision = "allow'])).toThrow(/refusé/);
    expect(() => settingsDocument({ model: "m", maxSessionTurns: 0, excludedTools: [] })).toThrow();
  });
});

describe("decideLaunch", () => {
  const verified = { verified: true, detail: "ok" };
  const unverified = { verified: false, detail: "non" };

  it("n'autorise le lancement manuel sans approbation qu'en sandbox vérifiée", () => {
    expect(
      decideLaunch({
        mode: "manual",
        approvalMode: "yolo",
        portKind: "sandbox",
        isolation: verified,
        providerQuotaReading: "none",
      }),
    ).toEqual({ allowed: true, approvalMode: "yolo" });
    expect(
      decideLaunch({
        mode: "manual",
        approvalMode: "yolo",
        portKind: "host",
        isolation: verified,
        providerQuotaReading: "none",
      }),
    ).toMatchObject({ allowed: false, refusal: "approval_outside_sandbox" });
    expect(
      decideLaunch({
        mode: "manual",
        approvalMode: "default",
        portKind: "host",
        isolation: unverified,
        providerQuotaReading: "none",
      }),
    ).toEqual({ allowed: true, approvalMode: "default" });
  });

  it("n'autorise l'autonomie qu'avec isolation vérifiée et lecture officielle du quota", () => {
    const base = { mode: "autonomous", approvalMode: "yolo", portKind: "sandbox" } as const;
    expect(
      decideLaunch({ ...base, isolation: verified, providerQuotaReading: "none" }),
    ).toMatchObject({ allowed: false, refusal: "no_quota_reading" });
    expect(
      decideLaunch({
        ...base,
        approvalMode: "default",
        isolation: unverified,
        providerQuotaReading: "official",
      }),
    ).toMatchObject({ allowed: false, refusal: "isolation_unverified" });
    expect(
      decideLaunch({ ...base, isolation: verified, providerQuotaReading: "official" }),
    ).toEqual({ allowed: true, approvalMode: "yolo" });
  });
});

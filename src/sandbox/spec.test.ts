import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertExecutableInRoots,
  assertLimit,
  resolveRoots,
  sandboxEnvironment,
  SandboxSpecError,
} from "./spec.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "mindwake-spec-"));
const work = path.join(base, "work");
const data = path.join(base, "data");
fs.mkdirSync(work);
fs.mkdirSync(path.join(data, "runtime"), { recursive: true });

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof SandboxSpecError ? error.code : "other";
  }
  return undefined;
}

describe("racines", () => {
  it("résout les racines valides en chemins réels", () => {
    const roots = resolveRoots({ readWrite: [work], readOnly: [path.join(data, "runtime")] }, [
      data,
    ]);
    expect(roots.readWrite).toEqual([fs.realpathSync.native(work)]);
  });

  it("refuse une racine qui contient un chemin protégé", () => {
    expect(code(() => resolveRoots({ readWrite: [base], readOnly: [] }, [data]))).toBe(
      "root_overlaps_protected",
    );
    expect(code(() => resolveRoots({ readWrite: [data], readOnly: [] }, [data]))).toBe(
      "root_overlaps_protected",
    );
  });

  it("refuse une racine trop large, relative ou absente", () => {
    expect(code(() => resolveRoots({ readWrite: [path.parse(base).root], readOnly: [] }, []))).toBe(
      "root_too_broad",
    );
    expect(code(() => resolveRoots({ readWrite: [base], readOnly: [] }, [], base))).toBe(
      "root_too_broad",
    );
    expect(code(() => resolveRoots({ readWrite: ["relatif"], readOnly: [] }, []))).toBe(
      "root_invalid",
    );
    expect(
      code(() => resolveRoots({ readWrite: [path.join(base, "nope")], readOnly: [] }, [])),
    ).toBe("root_invalid");
  });

  it.runIf(process.platform === "win32")(
    "suit une jonction : la cible, pas le lien, est comparée aux chemins protégés",
    () => {
      const link = path.join(work, "to-data");
      fs.symlinkSync(data, link, "junction");
      expect(code(() => resolveRoots({ readWrite: [link], readOnly: [] }, [data]))).toBe(
        "root_overlaps_protected",
      );
    },
  );

  it("exige un exécutable dans une racine accordée", () => {
    const roots = { readWrite: [work], readOnly: [] };
    expect(
      code(() => {
        assertExecutableInRoots(path.join(work, "a.exe"), roots);
      }),
    ).toBeUndefined();
    expect(
      code(() => {
        assertExecutableInRoots(path.join(data, "a.exe"), roots);
      }),
    ).toBe("executable_outside_roots");
  });
});

describe("environnement", () => {
  it("n'hérite de rien hors des variables système minimales", () => {
    const env = sandboxEnvironment(
      { HOME_HINT: "x" },
      { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "sk-test", PATH: "C:\\x", LOCALAPPDATA: "L" },
    );
    expect(env).toEqual({ SystemRoot: "C:\\Windows", LOCALAPPDATA: "L", HOME_HINT: "x" });
  });

  it("refuse un nom de secret ou une variable invalide", () => {
    for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "MY_SECRET", "AUTH"]) {
      expect(
        code(() => sandboxEnvironment({ [key]: "v" }, {})),
        key,
      ).toBe("env_secret_name");
    }
    expect(code(() => sandboxEnvironment({ "A=B": "v" }, {}))).toBe("env_invalid");
    expect(code(() => sandboxEnvironment({ A: "v\n" }, {}))).toBe("env_invalid");
  });
});

describe("limites", () => {
  it("refuse une limite nulle, négative, fractionnaire ou excessive", () => {
    for (const value of [0, -1, 1.5, 2_000]) {
      expect(
        code(() => {
          assertLimit("maxProcesses", value, 1_000);
        }),
      ).toBe("limit_invalid");
    }
    expect(
      code(() => {
        assertLimit("maxProcesses", undefined, 1_000);
      }),
    ).toBeUndefined();
    expect(
      code(() => {
        assertLimit("maxProcesses", 8, 1_000);
      }),
    ).toBeUndefined();
  });
});

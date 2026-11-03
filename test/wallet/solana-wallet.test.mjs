import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { address } from "@solana/kit";
import {
  GENESIS,
  MINT,
  TOKEN_PROGRAM,
  decimalAmount,
  initWallet,
  inspectAddress,
  showWallet,
} from "../../scripts/wallet-solana/wallet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "scripts/wallet-solana.mjs");
const OWNER = "11111111111111111111111111111111";
const isWindows = process.platform === "win32";
const hash = (data) => createHash("sha256").update(data).digest("hex");
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mind-wallet-test-"));
  t.after(async () => {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("mind-wallet-test-")
    )
      throw new Error("Unsafe test cleanup target.");
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return path.join(directory, "vault");
}
function cli(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function rpcFixture({
  wrongNetwork = false,
  accountPresent = false,
  tokenRaw = null,
  wrongProgram = false,
  missingAtaRead = false,
} = {}) {
  const [ata] = await findAssociatedTokenPda({
    owner: address(OWNER),
    mint: address(MINT),
    tokenProgram: address(TOKEN_PROGRAM),
  });
  const mintInfo = {
    decimals: 9,
    isInitialized: true,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: [
      {
        extension: "transferFeeConfig",
        state: {
          olderTransferFee: {
            epoch: 922n,
            transferFeeBasisPoints: 100,
            maximumFee: 1000000000000000000n,
          },
          newerTransferFee: {
            epoch: 1077n,
            transferFeeBasisPoints: 125,
            maximumFee: 1000000000000000000n,
          },
          transferFeeConfigAuthority: OWNER,
          withdrawWithheldAuthority: OWNER,
        },
      },
    ],
  };
  const token = {
    owner: TOKEN_PROGRAM,
    data: {
      parsed: {
        type: "account",
        info: {
          owner: OWNER,
          mint: MINT,
          tokenAmount: { decimals: 9, amount: tokenRaw },
          state: "initialized",
          extensions: [{ extension: "transferFeeAmount", state: { withheldAmount: "7" } }],
        },
      },
    },
  };
  let accountReads = 0;
  const send = (value) => ({ send: async () => value });
  return {
    getGenesisHash: () => send(wrongNetwork ? "wrong" : GENESIS),
    getEpochInfo: () => send({ epoch: 1076n }),
    getAccountInfo: (pubkey) => {
      accountReads++;
      if (pubkey === MINT)
        return send({
          context: { slot: 10n },
          value: {
            owner: wrongProgram ? OWNER : TOKEN_PROGRAM,
            data: { parsed: { type: "mint", info: mintInfo } },
          },
        });
      if (pubkey === OWNER) return send({ value: accountPresent ? { lamports: 0n } : null });
      assert.equal(pubkey, ata);
      return send({ value: tokenRaw === null || missingAtaRead ? null : token });
    },
    getTokenAccountsByOwner: () =>
      send({ value: tokenRaw === null ? [] : [{ pubkey: ata, account: token }] }),
    get accountReads() {
      return accountReads;
    },
  };
}

test(
  "init is idempotent, persisted as ciphertext, and show reopens the same key",
  { skip: !isWindows },
  async (t) => {
    const home = await fixture(t);
    const first = await initWallet(home);
    assert.equal(first.created, true);
    assert.match(first.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const file = path.join(home, "wallet.json");
    const before = await fs.readFile(file);
    const record = JSON.parse(before);
    assert.equal(record.version, 1);
    assert.equal(typeof record.protected_pkcs8, "string");
    assert.equal(Object.hasOwn(record, "seed"), false);
    assert.equal(Object.hasOwn(record, "privateKey"), false);
    assert.equal((await initWallet(home)).address, first.address);
    assert.equal((await showWallet(home)).address, first.address);
    assert.equal(hash(await fs.readFile(file)), hash(before));
    const output = await cli("show", "--home", home);
    assert.equal(output.code, 0);
    assert.equal(output.stdout, first.address + "\n");
    assert.equal(output.stderr, "");
  },
);

test(
  "two concurrent init processes publish one wallet and return one address",
  { skip: !isWindows },
  async (t) => {
    const home = await fixture(t);
    const results = await Promise.all([cli("init", "--home", home), cli("init", "--home", home)]);
    assert.equal(
      results.every((result) => result.code === 0),
      true,
      "Both controlled init processes must succeed.",
    );
    assert.equal(results[0].stdout, results[1].stdout);
    assert.equal(
      results.every((result) => result.stderr === ""),
      true,
    );
    assert.equal((await fs.readdir(home)).filter((name) => name === "wallet.json").length, 1);
    assert.equal(
      (await fs.readdir(home)).some((name) => /pending|lock/.test(name)),
      false,
    );
  },
);

test(
  "corrupt or mismatched vault is never replaced and produces no secret output",
  { skip: !isWindows },
  async (t) => {
    const home = await fixture(t);
    await initWallet(home);
    const file = path.join(home, "wallet.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.address = MINT;
    await fs.writeFile(file, JSON.stringify(record));
    const before = hash(await fs.readFile(file));
    const result = await cli("init", "--home", home);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "VAULT_UNREADABLE");
    assert.equal(hash(await fs.readFile(file)), before);
    await fs.writeFile(file, "{broken");
    const broken = hash(await fs.readFile(file));
    await assert.rejects(() => initWallet(home), { code: "VAULT_UNREADABLE" });
    assert.equal(hash(await fs.readFile(file)), broken);
  },
);

test(
  "show never creates a missing wallet; unsupported commands cannot send",
  { skip: !isWindows },
  async (t) => {
    const home = await fixture(t);
    await assert.rejects(() => showWallet(home), { code: "WALLET_MISSING" });
    assert.equal((await fs.readdir(path.dirname(home))).length, 0);
    const result = await cli("send", "--home", home);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(JSON.parse(result.stderr).error, "USAGE");
  },
);

test("repository or workspace vault paths are refused", { skip: !isWindows }, async () => {
  await assert.rejects(() => initWallet(path.join(ROOT, ".private-test")), {
    code: "PRIVATE_PATH_REQUIRED",
  });
  await assert.rejects(
    () => initWallet(path.join(process.env.LOCALAPPDATA, "mind-wake-essai/workspace/private-test")),
    { code: "PRIVATE_PATH_REQUIRED" },
  );
});

test(
  "an unrelated nonempty directory keeps its file and ACL unchanged",
  { skip: !isWindows },
  async (t) => {
    const home = await fixture(t);
    await fs.mkdir(home);
    const file = path.join(home, "important.txt");
    await fs.writeFile(file, "keep this document");
    const acl = () =>
      new Promise((resolve, reject) => {
        const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString("base64")}'));(Get-Acl -LiteralPath $p).Sddl`;
        const child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { windowsHide: true },
        );
        let output = "";
        child.stdout.on("data", (part) => {
          output += part;
        });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve(output.trim()) : reject(new Error("ACL read failed")),
        );
      });
    const before = await acl();
    await assert.rejects(() => initWallet(home), { code: "PRIVATE_DIRECTORY_UNRECOGNIZED" });
    assert.equal(await acl(), before);
    assert.equal(await fs.readFile(file, "utf8"), "keep this document");
    assert.deepEqual(await fs.readdir(home), ["important.txt"]);
  },
);

test("inspection refuses an ATA absent from the direct read but present in the owner list", async () => {
  const rpc = await rpcFixture({ tokenRaw: "1", missingAtaRead: true });
  await assert.rejects(() => inspectAddress(OWNER, rpc), { code: "RPC_DATA_INVALID" });
});

test("inspection refuses another network before reading any accounts", async () => {
  const rpc = await rpcFixture({ wrongNetwork: true });
  await assert.rejects(() => inspectAddress(OWNER, rpc), { code: "NETWORK_MISMATCH" });
  assert.equal(rpc.accountReads, 0);
});

test("inspection distinguishes absence from present zero balances and keeps exact fees", async () => {
  const absent = await inspectAddress(OWNER, await rpcFixture());
  assert.equal(absent.sol.status, "absent");
  assert.equal(absent.sol.lamports, null);
  assert.equal(absent.mind.status, "absent");
  assert.equal(absent.mind.amountRaw, null);
  assert.equal(absent.mind.associatedAccount.status, "absent");
  const zero = await inspectAddress(
    OWNER,
    await rpcFixture({ accountPresent: true, tokenRaw: "0" }),
  );
  assert.equal(zero.sol.status, "present");
  assert.equal(zero.sol.lamports, "0");
  assert.equal(zero.mind.status, "present");
  assert.equal(zero.mind.amountRaw, "0");
  assert.equal(zero.transferFee.active.basisPoints, "100");
  assert.equal(zero.transferFee.newer.basisPoints, "125");
  assert.equal(zero.transferFee.active.maximumFeeRaw, "1000000000000000000");
});

test("inspection preserves token integer precision and refuses another token program", async () => {
  const raw = "9007199254740993";
  const value = await inspectAddress(
    OWNER,
    await rpcFixture({ accountPresent: true, tokenRaw: raw }),
  );
  assert.equal(value.mind.amountRaw, raw);
  assert.equal(value.mind.amount, "9007199.254740993");
  assert.equal(value.mind.accounts[0].withheldRaw, "7");
  const wrongProgram = await rpcFixture({ wrongProgram: true });
  await assert.rejects(() => inspectAddress(OWNER, wrongProgram), { code: "MINT_UNEXPECTED" });
  assert.equal(decimalAmount("1", 9), "0.000000001");
});

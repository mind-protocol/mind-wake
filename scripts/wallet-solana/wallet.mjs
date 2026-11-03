import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { address, createSolanaRpc, getAddressDecoder } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";

export const MINT = "EgLGfRrjX3du7Pwbj8dzyubSk8ic1WdDfq1ysLqhBm6p";
export const TOKEN_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const NETWORK = "solana-mainnet-beta";
export const RPC_URL = "https://api.mainnet-beta.solana.com";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PS_SOURCE = readFileSync(path.join(HERE, "vault-dpapi.ps1"), "utf8");
const decoder = getAddressDecoder();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}
function fail(code, message) {
  throw new WalletError(code, message);
}
function inside(candidate, root) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
export function defaultHome() {
  if (!process.env.LOCALAPPDATA) fail("LOCAL_PROFILE_MISSING", "LOCALAPPDATA is required.");
  return path.join(process.env.LOCALAPPDATA, "mind-wake-essai", "credentials", "wallet-solana");
}
async function privateHome(home) {
  if (process.platform !== "win32") fail("WINDOWS_ONLY", "This storage adapter requires Windows.");
  if (!path.isAbsolute(home) || home.startsWith("\\\\"))
    fail("PRIVATE_PATH_REQUIRED", "Use a local absolute private directory.");
  const resolved = path.resolve(home);
  const liveWorkspace = path.join(process.env.LOCALAPPDATA ?? "", "mind-wake-essai", "workspace");
  if (inside(resolved, REPO) || inside(resolved, liveWorkspace))
    fail("PRIVATE_PATH_REQUIRED", "The vault must stay outside the repository and workspace.");
  let current = resolved;
  while (true) {
    if (existsSync(path.join(current, ".git")))
      fail("PRIVATE_PATH_REQUIRED", "The vault must stay outside a Git checkout.");
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        fail("PRIVATE_PATH_REQUIRED", "Reparse links are not accepted for the vault path.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}
// The secret moves only in inherited binary pipes inside this short-lived helper.
// No secret is put in a process argument, environment variable, log or plain file.
function dpapi(action, input = Buffer.alloc(0), home = "") {
  const allowed = new Set(["protect", "unprotect", "secure-home", "check-home"]);
  if (!allowed.has(action)) fail("INTERNAL_OPERATION", "Unknown vault operation.");
  const prefix = `$Action='${action}';$VaultPath=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString("base64")}'));\n`;
  const code = Buffer.from(prefix + PS_SOURCE, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", code],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        if (value) value.fill(0);
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        for (const b of chunks) b.fill(0);
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        new WalletError(
          "VAULT_OPERATION_FAILED",
          "The protected vault operation did not complete.",
        ),
      );
    }, 15000);
    child.on("error", () =>
      finish(
        new WalletError("VAULT_OPERATION_FAILED", "The Windows vault adapter is unavailable."),
      ),
    );
    child.stdout.on("data", (data) => {
      length += data.length;
      if (length > 32768) {
        child.kill();
        finish(new WalletError("VAULT_OPERATION_FAILED", "Unexpected vault response."));
      } else chunks.push(data);
    });
    child.stderr.on("data", () => {}); // Never forward an adapter exception or payload.
    child.stdin.on("error", () => {});
    child.on("close", (exitCode) => {
      if (exitCode !== 0)
        finish(
          new WalletError(
            "VAULT_OPERATION_FAILED",
            "The protected vault could not be opened or secured.",
          ),
        );
      else {
        const result = Buffer.concat(chunks);
        for (const b of chunks) b.fill(0);
        finish(null, result);
      }
    });
    child.stdin.end(input);
  });
}
async function checkHome(home) {
  const result = await dpapi("check-home", undefined, home);
  try {
    if (result.toString() !== "ok") fail("VAULT_PERMISSIONS", "Unexpected vault permissions.");
  } finally {
    result.fill(0);
  }
}
function publicAddress(privateDer) {
  const key = createPrivateKey({ key: privateDer, type: "pkcs8", format: "der" });
  if (key.asymmetricKeyType !== "ed25519") fail("VAULT_UNREADABLE", "Unexpected key type.");
  const jwk = createPublicKey(key).export({ format: "jwk" });
  return decoder.decode(Buffer.from(jwk.x, "base64url"));
}
function checkedAddress(value) {
  try {
    return address(value);
  } catch {
    fail("VAULT_UNREADABLE", "The wallet metadata is invalid.");
  }
}
async function readVault(home) {
  await checkHome(home);
  const file = path.join(home, "wallet.json");
  let record;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
      fail("VAULT_UNREADABLE", "The existing vault is not a regular wallet file.");
    record = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      record.version !== 1 ||
      record.network !== NETWORK ||
      record.mint !== MINT ||
      typeof record.address !== "string" ||
      typeof record.protected_pkcs8 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(record.protected_pkcs8)
    )
      fail("VAULT_UNREADABLE", "The wallet metadata is invalid.");
    checkedAddress(record.address);
  } catch (error) {
    if (error.code === "ENOENT")
      fail("WALLET_MISSING", "No wallet exists here. Run init explicitly.");
    if (error instanceof WalletError) throw error;
    fail("VAULT_UNREADABLE", "The existing vault is unreadable and has not been replaced.");
  }
  let clear;
  try {
    clear = await dpapi("unprotect", Buffer.from(record.protected_pkcs8, "base64"));
    if (publicAddress(clear) !== record.address)
      fail("VAULT_UNREADABLE", "The existing vault does not match its public address.");
  } catch (error) {
    if (error instanceof WalletError && error.code === "VAULT_UNREADABLE") throw error;
    fail("VAULT_UNREADABLE", "The existing vault cannot be verified and has not been replaced.");
  } finally {
    clear?.fill(0);
  }
  return { address: record.address, network: NETWORK, mint: MINT, createdAt: record.created_at };
}
export async function showWallet(home = defaultHome()) {
  home = await privateHome(home);
  try {
    await fs.access(home);
  } catch {
    fail("WALLET_MISSING", "No wallet exists here. Run init explicitly.");
  }
  return readVault(home);
}
export async function initWallet(home = defaultHome()) {
  home = await privateHome(home);
  await fs.mkdir(home, { recursive: true });
  const entries = await fs.readdir(home, { withFileTypes: true });
  const marker = ".wallet-solana-v1";
  const known =
    entries.some((entry) => entry.name === marker && entry.isDirectory()) ||
    entries.some((entry) => entry.name === "wallet.json" && entry.isFile());
  const allowed = (entry) =>
    (entry.name === marker && entry.isDirectory()) ||
    (entry.isFile() &&
      (["wallet.json", "init.lock"].includes(entry.name) ||
        /^wallet-[0-9a-f-]+\.pending$/.test(entry.name)));
  if (entries.length && (!known || !entries.every(allowed)))
    fail(
      "PRIVATE_DIRECTORY_UNRECOGNIZED",
      "The existing directory is not a wallet home. Its contents and permissions were not changed.",
    );
  if (!entries.length) {
    // Only an empty/new directory can have its ACL established here.
    const secured = await dpapi("secure-home", undefined, home);
    secured.fill(0);
    await fs.mkdir(path.join(home, marker)).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  await checkHome(home);
  const lock = path.join(home, "init.lock");
  const token = `${process.pid}:${randomUUID()}`;
  let fd;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = await fs.open(lock, "wx", 0o600);
      await fd.writeFile(token);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await delay(100);
    }
  }
  if (!fd)
    fail(
      "WALLET_LOCKED",
      "Another init may be running. No wallet was replaced; inspect the lock before recovery.",
    );
  let temporary;
  try {
    if (existsSync(path.join(home, "wallet.json")))
      return { ...(await readVault(home)), created: false };
    const { privateKey } = generateKeyPairSync("ed25519");
    const clear = privateKey.export({ format: "der", type: "pkcs8" });
    let cipher;
    let record;
    try {
      const publicKey = publicAddress(clear);
      cipher = await dpapi("protect", clear);
      record = {
        version: 1,
        address: publicKey,
        network: NETWORK,
        mint: MINT,
        created_at: new Date().toISOString(),
        protected_pkcs8: cipher.toString("base64"),
      };
    } finally {
      clear.fill(0);
      cipher?.fill(0);
    }
    temporary = path.join(home, `wallet-${randomUUID()}.pending`);
    const temp = await fs.open(temporary, "wx", 0o600);
    try {
      await temp.writeFile(JSON.stringify(record) + "\n", "utf8");
      await temp.sync();
    } finally {
      await temp.close();
    }
    // Hard-link publication is atomic and refuses an existing destination.
    await fs.link(temporary, path.join(home, "wallet.json"));
    const verified = await readVault(home);
    return { ...verified, created: true };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    await fd.close();
    if ((await fs.readFile(lock, "utf8").catch(() => "")) === token) await fs.unlink(lock);
  }
}
function exactInteger(value) {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  fail("RPC_DATA_INVALID", "The RPC did not return an exact nonnegative integer.");
}
export function decimalAmount(raw, decimals) {
  const value = exactInteger(raw);
  const scale = 10n ** BigInt(decimals);
  return decimals === 0
    ? value.toString()
    : `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}
function parsedToken(account) {
  return account?.data?.parsed;
}
function feeView(fee) {
  if (!fee) fail("MINT_UNEXPECTED", "The expected transfer-fee configuration is missing.");
  return {
    epoch: exactInteger(fee.epoch).toString(),
    basisPoints: exactInteger(fee.transferFeeBasisPoints).toString(),
    maximumFeeRaw: exactInteger(fee.maximumFee).toString(),
  };
}
export async function inspectAddress(owner, rpc = createSolanaRpc(RPC_URL)) {
  owner = checkedAddress(owner);
  const signal = () => ({ abortSignal: AbortSignal.timeout(15000) });
  const genesis = await rpc.getGenesisHash().send(signal());
  if (genesis !== GENESIS) fail("NETWORK_MISMATCH", "The RPC is not Solana mainnet-beta.");
  const [mintResult, epoch, sol] = await Promise.all([
    rpc
      .getAccountInfo(address(MINT), { encoding: "jsonParsed", commitment: "finalized" })
      .send(signal()),
    rpc.getEpochInfo({ commitment: "finalized" }).send(signal()),
    rpc.getAccountInfo(owner, { encoding: "base64", commitment: "finalized" }).send(signal()),
  ]);
  const mint = mintResult.value;
  const parsed = parsedToken(mint);
  const info = parsed?.info;
  if (
    !mint ||
    mint.owner !== TOKEN_PROGRAM ||
    parsed?.type !== "mint" ||
    info?.decimals !== 9 ||
    info?.isInitialized !== true
  )
    fail("MINT_UNEXPECTED", "The selected mint is not the expected initialized Token-2022 mint.");
  const fee = info.extensions?.find((item) => item.extension === "transferFeeConfig")?.state;
  const older = feeView(fee?.olderTransferFee);
  const newer = feeView(fee?.newerTransferFee);
  const active = exactInteger(epoch.epoch) >= BigInt(newer.epoch) ? newer : older;
  const [ata] = await findAssociatedTokenPda({
    owner,
    mint: address(MINT),
    tokenProgram: address(TOKEN_PROGRAM),
  });
  const [ataResult, owned] = await Promise.all([
    rpc.getAccountInfo(ata, { encoding: "jsonParsed", commitment: "finalized" }).send(signal()),
    rpc
      .getTokenAccountsByOwner(
        owner,
        { programId: address(TOKEN_PROGRAM) },
        { encoding: "jsonParsed", commitment: "finalized" },
      )
      .send(signal()),
  ]);
  const accounts = [];
  for (const item of owned.value) {
    const token = parsedToken(item.account);
    if (token?.info?.mint !== MINT) continue;
    if (
      item.account.owner !== TOKEN_PROGRAM ||
      token.type !== "account" ||
      token.info.owner !== owner ||
      token.info.tokenAmount?.decimals !== 9
    )
      fail("RPC_DATA_INVALID", "An owned token account has unexpected metadata.");
    const withheld =
      token.info.extensions?.find((ext) => ext.extension === "transferFeeAmount")?.state
        ?.withheldAmount ?? 0n;
    accounts.push({
      address: item.pubkey,
      amountRaw: exactInteger(token.info.tokenAmount.amount).toString(),
      withheldRaw: exactInteger(withheld).toString(),
      state: token.info.state,
    });
  }
  if (ataResult.value) {
    const token = parsedToken(ataResult.value);
    if (
      ataResult.value.owner !== TOKEN_PROGRAM ||
      token?.type !== "account" ||
      token.info.mint !== MINT ||
      token.info.owner !== owner
    )
      fail("RPC_DATA_INVALID", "The derived associated account has unexpected metadata.");
    if (!accounts.some((item) => item.address === ata))
      fail(
        "RPC_DATA_INVALID",
        "The two token-account reads disagree. Retry inspection; no transaction was sent.",
      );
  }
  if (ataResult.value === null && accounts.some((item) => item.address === ata))
    fail(
      "RPC_DATA_INVALID",
      "The two token-account reads disagree. Retry inspection; no transaction was sent.",
    );
  const total = accounts.reduce((sum, item) => sum + BigInt(item.amountRaw), 0n);
  return {
    address: owner,
    network: NETWORK,
    genesis,
    observedAt: new Date().toISOString(),
    mint: {
      address: MINT,
      program: TOKEN_PROGRAM,
      decimals: 9,
      slot: exactInteger(mintResult.context.slot).toString(),
      authority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      transferHookProgram:
        info.extensions?.find((item) => item.extension === "transferHook")?.state?.programId ??
        null,
    },
    transferFee: {
      observedEpoch: exactInteger(epoch.epoch).toString(),
      older,
      newer,
      active,
      configAuthority: fee.transferFeeConfigAuthority ?? null,
      withdrawAuthority: fee.withdrawWithheldAuthority ?? null,
    },
    sol: {
      status: sol.value === null ? "absent" : "present",
      lamports: sol.value === null ? null : exactInteger(sol.value.lamports).toString(),
      amount: sol.value === null ? null : decimalAmount(sol.value.lamports, 9),
    },
    mind: {
      status: accounts.length ? "present" : "absent",
      amountRaw: accounts.length ? total.toString() : null,
      amount: accounts.length ? decimalAmount(total, 9) : null,
      accounts,
      associatedAccount: { address: ata, status: ataResult.value === null ? "absent" : "present" },
    },
    capabilities: ["receive_address", "read_only"],
    transactionSent: false,
  };
}
export async function inspectWallet(home = defaultHome()) {
  const wallet = await showWallet(home);
  try {
    return await inspectAddress(wallet.address);
  } catch (error) {
    if (error instanceof WalletError) throw error;
    fail(
      "RPC_UNAVAILABLE",
      "Chain inspection failed. The wallet was not changed and no transaction was sent.",
    );
  }
}

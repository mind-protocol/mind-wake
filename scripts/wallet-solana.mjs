#!/usr/bin/env node
import {
  defaultHome,
  initWallet,
  inspectWallet,
  showWallet,
  WalletError,
} from "./wallet-solana/wallet.mjs";

const args = process.argv.slice(2);
const command = args.shift();
let home;
try {
  if (!["init", "show", "inspect"].includes(command))
    throw new WalletError(
      "USAGE",
      "Usage: node scripts/wallet-solana.mjs init|show|inspect [--home PRIVATE_DIRECTORY]",
    );
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--home" || !args[1])
      throw new WalletError("USAGE", "Only --home PRIVATE_DIRECTORY is accepted.");
    home = args[1];
  }
  home ??= defaultHome();
  if (command === "inspect")
    process.stdout.write(JSON.stringify(await inspectWallet(home), null, 2) + "\n");
  else
    process.stdout.write(
      (await (command === "init" ? initWallet(home) : showWallet(home))).address + "\n",
    );
} catch (error) {
  const safe =
    error instanceof WalletError
      ? error
      : new WalletError(
          "WALLET_OPERATION_FAILED",
          "The operation did not complete. No secret is included in this error.",
        );
  process.stderr.write(JSON.stringify({ error: safe.code, message: safe.message }) + "\n");
  process.exitCode = 1;
}

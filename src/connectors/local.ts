import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConnectorError, type ConnectorGrant, type LiveControl, type SecretVault } from "./core.js";
import { WindowsVault } from "./windows-vault.js";
import { openStoreReadOnly } from "../store/index.js";
import { controlDbPath } from "../daemon/paths.js";
import { DEFAULT_PROFILE_ID } from "../cli/context.js";
import { resolvePolicy } from "../policy/index.js";

/** Host-mode boundary follows existing Wake controls; never writes policy. */
export function wakeConnectorControl(dataDir: string, hosts: readonly string[]): LiveControl {
  try {
    if (fs.existsSync(path.join(dataDir, "emergency-stop.flag")))
      return { allowed: false, revision: "stop" };
    const store = openStoreReadOnly(controlDbPath(dataDir));
    try {
      const policy = resolvePolicy(store.uow.policies, DEFAULT_PROFILE_ID);
      const profile = store.uow.profiles.get(DEFAULT_PROFILE_ID);
      if (policy.status !== "active" || !profile) return { allowed: false, revision: "none" };
      const allowed =
        !profile.emergencyStopLocked &&
        ["ready", "running", "hibernating"].includes(profile.state) &&
        policy.revision.groups.runtime.hostUnsandboxedAcknowledged === true &&
        hosts.every((host) =>
          policy.revision.groups.network.explorationDestinations.some(
            (d) => d.host === host && d.ports.includes(443),
          ),
        );
      return { allowed, revision: policy.revision.id };
    } finally {
      store.close();
    }
  } catch {
    return { allowed: false, revision: "unavailable" };
  }
}

export interface ConnectorRecord<T> {
  config: T;
  grant: ConnectorGrant;
  /** Internal vault ref. Never serialize to MCP. */
  tokenRef: string | null;
}

/** Only opaque slot references on disk; configuration/grants and tokens are DPAPI protected. */
export class ConnectorRecords {
  private readonly cache = new Map<string, { ref: string; record: unknown }>();
  readonly vault: SecretVault;
  readonly directory: string;
  constructor(dataDir: string, vault?: SecretVault) {
    this.directory = path.join(dataDir, "connectors");
    this.vault = vault ?? new WindowsVault(path.join(this.directory, "vault"));
  }
  private file(provider: string): string {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) throw new ConnectorError("invalid_input");
    return path.join(this.directory, provider + ".ref");
  }
  /** Cross-process commit/revoke serialization; never hold across vault or network I/O. */
  private async locked<T>(provider: string, work: () => T): Promise<T> {
    const lock = this.file(provider) + ".lock";
    fs.mkdirSync(this.directory, { recursive: true });
    const deadline = Date.now() + 1000;
    let fd: number;
    for (;;) {
      try {
        fd = fs.openSync(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline)
          throw new ConnectorError("vault_unavailable");
        await delay(5);
      }
    }
    try {
      return work();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
  async read<T>(provider: string): Promise<ConnectorRecord<T> | null> {
    const file = this.file(provider);
    if (!fs.existsSync(file)) return null;
    try {
      const ref = fs.readFileSync(file, "utf8");
      const cached = this.cache.get(provider);
      if (cached?.ref === ref) return cached.record as ConnectorRecord<T>;
      const record = JSON.parse(await this.vault.get(ref)) as ConnectorRecord<T>;
      // A disconnect/replacement may complete while DPAPI is decrypting.
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== ref) return null;
      this.cache.set(provider, { ref, record });
      return record;
    } catch {
      throw new ConnectorError("vault_unavailable");
    }
  }
  async write<T>(
    provider: string,
    record: ConnectorRecord<T>,
    expectedRef?: string,
  ): Promise<void> {
    const file = this.file(provider);
    const ref = await this.vault.put(JSON.stringify(record));
    let old: string | null;
    try {
      old = await this.locked(provider, () => {
        if (expectedRef !== undefined && this.currentRef(provider) !== expectedRef)
          throw new ConnectorError("stopped");
        const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        const temp = file + "." + randomUUID() + ".tmp";
        fs.writeFileSync(temp, ref, { mode: 0o600, flag: "wx" });
        fs.renameSync(temp, file);
        return previous;
      });
    } catch (error) {
      await this.vault.delete(ref).catch(() => undefined);
      throw error;
    }
    if (old) await this.vault.delete(old);
  }
  currentRef(provider: string): string {
    const file = this.file(provider);
    const epoch = file + ".epoch";
    return (
      (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") +
      ":" +
      (fs.existsSync(epoch) ? fs.readFileSync(epoch, "utf8") : "")
    );
  }
  /** Local closure first, even if vault deletion or remote revocation fails. */
  async remove(provider: string): Promise<void> {
    const file = this.file(provider);
    const ref = await this.locked(provider, () => {
      fs.writeFileSync(file + ".epoch", randomUUID(), { mode: 0o600 });
      this.cache.delete(provider);
      if (!fs.existsSync(file)) return null;
      const previous = fs.readFileSync(file, "utf8");
      fs.unlinkSync(file);
      return previous;
    });
    if (ref) await this.vault.delete(ref);
  }
}

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  async read<T>(provider: string): Promise<ConnectorRecord<T> | null> {
    const file = this.file(provider);
    if (!fs.existsSync(file)) return null;
    try {
      const ref = fs.readFileSync(file, "utf8");
      const cached = this.cache.get(provider);
      if (cached?.ref === ref) return cached.record as ConnectorRecord<T>;
      const record = JSON.parse(await this.vault.get(ref)) as ConnectorRecord<T>;
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
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const ref = await this.vault.put(JSON.stringify(record));
    if (
      expectedRef !== undefined &&
      (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== expectedRef)
    ) {
      await this.vault.delete(ref);
      throw new ConnectorError("stopped");
    }
    fs.mkdirSync(this.directory, { recursive: true });
    const temp = file + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temp, ref, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    if (old) await this.vault.delete(old);
  }
  currentRef(provider: string): string {
    return fs.readFileSync(this.file(provider), "utf8");
  }
  /** Local closure first, even if vault deletion or remote revocation fails. */
  async remove(provider: string): Promise<void> {
    const file = this.file(provider);
    if (!fs.existsSync(file)) return;
    const ref = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);
    await this.vault.delete(ref);
  }
}

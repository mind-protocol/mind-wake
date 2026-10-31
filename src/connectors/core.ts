import { randomUUID } from "node:crypto";

export type ConnectorCode =
  | "disabled"
  | "stopped"
  | "vault_unavailable"
  | "invalid_input"
  | "out_of_scope"
  | "account_mismatch"
  | "scope_missing"
  | "reauthorize"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "oauth_rejected";

/** Never include a provider response, URL, token or private content in an error. */
export class ConnectorError extends Error {
  constructor(readonly code: ConnectorCode) {
    super(code);
  }
}

export interface SecretVault {
  put(value: string): Promise<string>;
  get(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export interface ConnectorState {
  installed: boolean;
  configured: boolean;
  authorized: boolean;
  available: boolean;
}

export interface ConnectorGrant {
  provider: string;
  account: string;
  generation: string;
  enabled: boolean;
}

export interface LiveControl {
  allowed: boolean;
  /** Changes on any consent/policy revision. */
  revision: string;
}

export function newGeneration(): string {
  return randomUUID();
}

/** No scheduler here: reuse Wake's controls. A grant cannot override them. */
export class ConnectorGate {
  constructor(
    readonly control: () => LiveControl,
    readonly grant: () => Promise<ConnectorGrant | null>,
  ) {}

  async run<T>(
    provider: string,
    account: string,
    work: (signal: AbortSignal, check: () => Promise<void>) => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const initial = await this.grant();
    if (!initial?.enabled || initial.provider !== provider || initial.account !== account)
      throw new ConnectorError("disabled");
    const revision = this.control();
    if (!revision.allowed) throw new ConnectorError("stopped");
    const abort = new AbortController();
    const deadline = Date.now() + Math.min(timeoutMs, 180_000);
    const check = async (): Promise<void> => {
      const current = this.control();
      const grant = await this.grant();
      if (
        abort.signal.aborted ||
        Date.now() >= deadline ||
        !current.allowed ||
        current.revision !== revision.revision ||
        !grant?.enabled ||
        grant.generation !== initial.generation ||
        grant.account !== account ||
        grant.provider !== provider
      ) {
        abort.abort();
        throw new ConnectorError("stopped");
      }
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void check()
        .catch(() => {
          abort.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, 50);
    try {
      await check();
      const result = await work(abort.signal, check);
      await check();
      return result;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(abort.signal.aborted ? "stopped" : "unavailable");
    } finally {
      clearInterval(timer);
      abort.abort();
    }
  }
}

export function safeConnectorError(error: unknown): { error: ConnectorCode } {
  return { error: error instanceof ConnectorError ? error.code : "unavailable" };
}

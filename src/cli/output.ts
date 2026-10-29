/**
 * Sortie de la CLI : texte humain en français ou JSON versionné (`--json`). Toute
 * donnée affichée passe par l'expurgation, même si elle vient du stockage : le journal
 * a été expurgé à l'écriture, mais l'affichage ne repose pas sur cette seule garantie.
 */

import type { SchemaVersion } from "../contracts/index.js";
import { redactValue } from "../journal/redact.js";

/** Version du format JSON de la CLI ; à incrémenter à tout changement incompatible. */
export const CLI_OUTPUT_SCHEMA = "mind-wake.cli";
export const CLI_OUTPUT_SCHEMA_VERSION: SchemaVersion = 1;

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export interface CommandResult<T> {
  readonly exitCode: number;
  readonly data: T;
  readonly human: (data: T) => string;
}

export type CliErrorCode = "usage" | "internal";

export interface JsonEnvelope {
  readonly schema: typeof CLI_OUTPUT_SCHEMA;
  readonly schemaVersion: SchemaVersion;
  readonly command: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: CliErrorCode; readonly message: string };
}

export function renderResult<T>(command: string, result: CommandResult<T>, json: boolean): string {
  const data = redactValue(result.data) as T;
  if (!json) return ensureNewline(result.human(data));
  const envelope: JsonEnvelope = {
    schema: CLI_OUTPUT_SCHEMA,
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    command,
    ok: result.exitCode === EXIT_OK,
    data,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function renderError(
  command: string,
  code: CliErrorCode,
  message: string,
  json: boolean,
): string {
  const safe = redactValue(message) as string;
  if (!json) return `Erreur : ${safe}\n`;
  const envelope: JsonEnvelope = {
    schema: CLI_OUTPUT_SCHEMA,
    schemaVersion: CLI_OUTPUT_SCHEMA_VERSION,
    command,
    ok: false,
    error: { code, message: safe },
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Valeur absente affichée de façon homogène. */
export function orDash(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

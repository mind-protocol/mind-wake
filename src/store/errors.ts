/**
 * Erreur d'intégrité ou d'usage du dépôt. Une erreur levée dans une transaction
 * l'annule entièrement.
 */

export type StoreErrorCode =
  | "not_found"
  | "conflict"
  | "immutable"
  | "invalid_transition"
  | "invalid_input"
  | "closed"
  | "schema_mismatch"
  | "async_transaction";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

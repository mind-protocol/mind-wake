import { tr } from "./i18n.js";
export type DocumentScope = 'agent' | 'project' | 'aurore';
export type LocalDocumentScope = Exclude<DocumentScope, 'aurore'>;
export function documentScope(value: unknown): DocumentScope {
  return value === 'project' || value === 'aurore' ? value : 'agent';
}
export function localDocumentScope(value: unknown): LocalDocumentScope | null {
  return value === 'agent' || value === 'project' ? value : null;
}
export function documentScopeLabel(value: DocumentScope): string {
  return value === 'aurore' ? tr("Atelier d’Aurore") : value === 'project' ? tr("Projet Wake") : tr("Mon atelier");
}
export interface ScopeTicket {readonly scope: DocumentScope; readonly epoch: number}
/** A return to the same scope must not accept a response from a previous visit. */
export class DocumentScopeState {
  #scope: DocumentScope;
  #epoch = 0;
  constructor(saved: unknown = 'agent') {this.#scope = documentScope(saved);}
  get current(): DocumentScope {return this.#scope;}
  get local(): LocalDocumentScope | null {return localDocumentScope(this.#scope);}
  select(value: unknown): void {this.#scope = documentScope(value); this.#epoch++;}
  capture(): ScopeTicket {return {scope:this.#scope,epoch:this.#epoch};}
  accepts(ticket: ScopeTicket): boolean {
    return ticket.scope === this.#scope && ticket.epoch === this.#epoch;
  }
}

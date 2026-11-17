/** A live legacy engine can survive Fast Refresh. The UI must use its real methods, not the new module type. */
export function canModifyCallParticipants(engine: unknown, phase: string): boolean {
  if (!['listening', 'speaking', 'playing'].includes(phase) || !engine || typeof engine !== 'object') return false;
  const current = engine as {addTargets?: unknown;removeTargets?: unknown;humanGuest?:boolean};
  if(current.humanGuest)return false;
  return typeof current.addTargets === 'function' && typeof current.removeTargets === 'function';
}

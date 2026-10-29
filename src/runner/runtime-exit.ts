/** Runtimes emit a successful result before cleanup closes their Windows Job Object.
 * That cleanup uses C0DE; it is not a successful exit without the explicit result.
 * Pause, stop and adapter errors are handled before this classification by Runner.
 */
export function successfulRuntimeExit(adapter: string, ended: string | null, code: number | null | undefined): boolean {
  return ended !== null && (code === 0 ||
    code === 0xC0DE && (
      adapter === "claude" && (ended === "result:completed" || ended === "result:success") ||
      adapter === "codex" && ended === "completed"
    ));
}

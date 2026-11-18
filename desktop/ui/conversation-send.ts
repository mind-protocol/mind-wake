export type ConversationInvoke = (command: string, args: Record<string, unknown>) => Promise<{
  ok?: unknown;
  data?: Record<string, unknown>;
  error?: {message?: unknown};
}>;

/** Called only after a deliberate send has been acknowledged as persisted. */
export async function requestConversationReply(invoke: ConversationInvoke): Promise<string> {
  try {
    const wake = await invoke("wake_now", {});
    if (wake.ok !== true) {
      return `Message enregistré. Pas de réveil : ${String(wake.data?.["detail"] ?? wake.error?.message ?? "réveil refusé")}.`;
    }
    return "Message enregistré · réponse demandée à l’agent.";
  } catch (error) {
    return `Message enregistré. Réveil indisponible : ${error instanceof Error ? error.message : String(error)}.`;
  }
}

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { openCallControls } from "./call-control-store.mjs";

/** Caller authority comes only from the host's existing owner signature. */
export function registerAgentCallControl(server: McpServer, {dir, caller}: {dir: string; caller: string}) {
  server.registerTool("list_active_calls", {
    description: "List active app calls in which this agent is a participant. Returns exact call IDs and epochs for hangup_call. Older clients without call-session support are not included.",
    inputSchema: z.strictObject({}),
  }, () => {
    const book = openCallControls(dir);
    try { return {content:[{type:"text" as const, text:JSON.stringify({schema:"mind.call.active.v1", calls:book.listForCaller(caller)})}]}; }
    finally { book.close(); }
  });
  server.registerTool("hangup_call", {
    description: "End one exact app call for its participants, only if this agent belongs to it. Warn the human before hanging up. Requires call_id and epoch from list_active_calls; never guess an ID. Idempotent; a stored end request is not proof the clients stopped audio. Does not ring or call back.",
    inputSchema: z.strictObject({
      call_id:z.string().uuid(),
      epoch:z.literal(1),
    }),
  }, ({call_id, epoch}) => {
    const book = openCallControls(dir);
    try { return {content:[{type:"text" as const, text:JSON.stringify({schema:"mind.call.hangup.v1", ...book.requestHangup({id:call_id,epoch,caller})})}]}; }
    catch(error) { return {isError:true, content:[{type:"text" as const, text:String((error as Error)?.message ?? error)}]}; }
    finally { book.close(); }
  });
}

import { registerUnifiedCall } from './unified-call.js';
import {openStoreReadOnly} from "../../src/store/index.js";
import {controlDbPath} from "../../src/daemon/paths.js";
import {DEFAULT_PROFILE_ID} from "../../src/cli/context.js";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { openPhoneBook } from "./phone-book.mjs";
import { registerAgentCallControl } from "./agent-hangup.js";
import { signatureHandle } from "../../src/communication/telegram-handle-route.js";

export function registerHumanCall(server: McpServer, env: Readonly<Record<string, string | undefined>>) {
  const dir = env["MIND_WAKE_DATA_DIR"];
  if (!dir || env["MIND_WAKE_OWNER_MESSAGES"] !== "1") return;
  const signature = env["MIND_WAKE_OWNER_SIGNATURE"];
  const room = /^Room (\d+)$/i.exec(signature ?? "");
  const caller = room ? "room" + (room[1] ?? "") : signature ? signatureHandle(signature) : "mind";
  if (!caller) return;
  registerAgentCallControl(server, {dir, caller, ...(signature ? {label: signature} : {})});
  const assertAllowed = () => {
      const control = openStoreReadOnly(controlDbPath(dir));
      try {
        const profile=control.uow.profiles.get(DEFAULT_PROFILE_ID);
        if(!profile || profile.emergencyStopLocked || ["paused","checkpointing","stopped","disabled"].includes(profile.state)) throw Error("Wake is paused or stopped; no human call may ring");
      } finally { control.close(); }
  };
  registerUnifiedCall(server,{dir,caller,label:signature ?? 'Marco',assertAllowed});
  server.registerTool("call_human", {
    description: "Ring a human's linked phones and Wake Desktop for 45 seconds. Defaults to NLR (@NLR-AI). Answering opens voice with the calling agent. Queued does not mean answered.",
    inputSchema: z.strictObject({ handle: z.string().trim().min(1).max(62).optional() }),
  }, ({handle}) => {
    try {
      assertAllowed();
      const book = openPhoneBook(dir);
      try {
        return { content: [{type: "text", text: JSON.stringify(book.invite(handle, caller, signature ?? "Marco"))}] };
      } finally { book.close(); }
    } catch (error) {
      return {isError: true, content: [{type: "text", text: String(error)}]};
    }
  });
}

/**
 * Serveur MCP réduit d'un fork affecté (demande NLR du 6 novembre 2026, VOX / Fork 7) :
 * un seul outil, `message_owner`, pour écrire soi-même dans le fil principal de l'humain.
 * Rien n'est recopié automatiquement : seul un appel explicite publie un message, et chaque
 * message est attribué à sa signature (`MIND_WAKE_OWNER_SIGNATURE`, ex. « VOX (Fork 7) »).
 * Les autres outils MIND (wakes, jobs, hub, fils de forks) ne sont pas exposés.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerOwnerTools } from "./owner-tools.js";

export const FORK_OWNER_TOOLS: ReadonlySet<string> = new Set(["message_owner"]);

/** Préfixe la signature, sans la doubler si l'auteur l'a déjà écrite. */
export function signOwnerText(signature: string, text: string): string {
  const body = text.trim();
  return body.startsWith(signature) ? body : `${signature} : ${body}`;
}

type Register = McpServer["registerTool"];

/**
 * Enregistre seulement `message_owner`, avec la signature imposée au texte publié. Les autres
 * outils du module propriétaire sont ignorés.
 */
export function registerSignedOwnerTools(
  server: McpServer,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const signature = env["MIND_WAKE_OWNER_SIGNATURE"]?.trim();
  if (!signature) throw Error("MIND_WAKE_OWNER_SIGNATURE requis.");
  const register = ((name: string, config: { description?: string }, handler: (args: { text: string }, extra: unknown) => unknown) => {
    if (!FORK_OWNER_TOOLS.has(name)) return undefined;
    return (server.registerTool as unknown as (...a: unknown[]) => unknown)(
      name,
      {
        ...config,
        description: `${config.description ?? ""} Each message is published signed « ${signature} ».`.trim(),
      },
      (args: { text: string }, extra: unknown) => handler({ ...args, text: signOwnerText(signature, args.text) }, extra),
    );
  }) as unknown as Register;
  const filtered = new Proxy(server, {
    get: (target, key, receiver) =>
      key === "registerTool" ? register : (Reflect.get(target, key, receiver) as unknown),
  });
  registerOwnerTools(filtered, { ...env, MIND_WAKE_OWNER_MESSAGES: "1" });
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop() ?? "\0")) {
  const server = new McpServer({ name: "mind", version: "0.1.0" });
  registerSignedOwnerTools(server, process.env);
  await server.connect(new StdioServerTransport());
}

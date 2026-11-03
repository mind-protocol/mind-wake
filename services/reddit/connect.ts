import { createServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { redditConnectionSchema } from "./config.js";

const optionsSchema = z.strictObject({
  clientId: z.string().regex(/^[a-zA-Z0-9_-]{5,100}$/),
  username: z.string().regex(/^[A-Za-z0-9_-]{3,30}$/),
  configFile: z.string().min(1),
  port: z.int().min(0).max(65535).default(8765),
  webApp: z.boolean().default(false),
  enableReplies: z.boolean().default(false),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string(),
});

/** Loopback OAuth. Web-app secrets are entered in a local password field, never in argv. */
export async function startRedditConnect(
  input: z.input<typeof optionsSchema>,
  fetcher: typeof fetch = fetch,
) {
  const options = optionsSchema.parse(input);
  const file = path.resolve(options.configFile);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384)
      throw new Error("Fichier de connexion invalide");
  }
  const previousText = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  if (previousText !== undefined && !options.enableReplies)
    throw new Error("Une connexion existe déjà ; aucun identifiant remplacé.");
  const previous =
    previousText === undefined ? undefined : redditConnectionSchema.parse(JSON.parse(previousText));
  if (previous && previous.clientId !== options.clientId) throw new Error("Application différente");
  const state = randomBytes(32).toString("base64url");
  const agent = `desktop:mind-wake:0.1 (by /u/${options.username})`;
  let consumed = false;
  let succeeded = false;
  let redirectUri = "";
  let host = "";
  let clientSecret = previous?.clientSecret ?? "";
  let prepared = !options.webApp || clientSecret.length > 0;
  let authorizationUrl = "";
  const page = (res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
    });
    res.end(text);
  };
  const server = createServer((req, res) => {
    void handle().catch(() => {
      page(
        res,
        500,
        "Connexion impossible. Aucun secret affiché. Relancer la connexion pour réessayer.",
      );
    });
    async function handle() {
      if (req.headers.host !== host) {
        page(res, 400, "Requête invalide.");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (
        options.webApp &&
        req.method === "GET" &&
        url.pathname === `/connect/${state}` &&
        !consumed
      ) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; form-action 'self' https://www.reddit.com; frame-ancestors 'none'",
          // no-referrer makes ordinary form POSTs send Origin: null in browsers.
          // Keep the local origin for CSRF verification; disclose no referrer to Reddit.
          "Referrer-Policy": "same-origin",
        });
        res.end(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Connecter Reddit à MIND Wake</title>
          <h1>Connecter Reddit à MIND Wake</h1><p>Application web : ${options.clientId}</p>
          <p>Saisissez le client secret affiché dans les paramètres de votre application Reddit.</p>
          <p>Il sera transmis uniquement à Reddit pour OAuth et conservé dans le fichier privé de cette connexion.</p>
          <form method="post" action="/prepare"><input type="hidden" name="state" value="${state}">
          <label>Client secret <input type="password" name="client_secret" required maxlength="1000" autocomplete="off"></label>
          <button type="submit">Continuer vers Reddit (lecture seule)</button></form>
          <p>L'autorisation demandée permet de lire Reddit et de vérifier votre pseudo. Aucune publication.</p></html>`);
        return;
      }
      if (options.webApp && req.method === "POST" && url.pathname === "/prepare" && !consumed) {
        if (
          req.headers.origin !== `http://${host}` ||
          !req.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
        ) {
          page(res, 403, "Origine invalide.");
          return;
        }
        let body = "";
        for await (const chunk of req) {
          body += String(chunk);
          if (Buffer.byteLength(body) > 8192) {
            page(res, 413, "Formulaire trop volumineux.");
            return;
          }
        }
        const form = new URLSearchParams(body);
        if (form.get("state") !== state) {
          page(res, 403, "Formulaire invalide.");
          return;
        }
        const secret = (form.get("client_secret") ?? "").trim();
        if (!secret || secret.length > 1000 || /[\r\n]/.test(secret)) {
          page(res, 400, "Secret absent ou invalide.");
          return;
        }
        clientSecret = secret;
        prepared = true;
        res.writeHead(303, {
          Location: authorizationUrl,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
        return;
      }
      if (req.method !== "GET") {
        page(res, 405, "Méthode non autorisée.");
        return;
      }
      if (url.pathname === "/done" && succeeded) {
        page(
          res,
          200,
          "Reddit est connecté à MIND Wake en lecture seule. Vous pouvez fermer cet onglet.",
        );
        setTimeout(() => {
          void close();
        }, 500).unref();
        return;
      }
      if (url.pathname !== "/reddit/callback") {
        page(res, 404, "En attente de l’autorisation Reddit.");
        return;
      }
      const returnedState = url.searchParams.get("state") ?? "";
      if (
        Buffer.byteLength(returnedState) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))
      ) {
        page(res, 400, "État OAuth invalide. Aucun identifiant enregistré.");
        return;
      }
      if (consumed) {
        page(res, 409, "Cette autorisation a déjà été traitée.");
        return;
      }
      if (!prepared) {
        page(res, 409, "Renseigner le secret dans le formulaire local avant de continuer.");
        return;
      }
      consumed = true;
      if (url.searchParams.has("error")) {
        page(res, 403, "Autorisation Reddit refusée. Aucun identifiant enregistré.");
        return;
      }
      const code = url.searchParams.get("code");
      if (!code || code.length > 4096) {
        page(res, 400, "Code OAuth absent ou invalide.");
        return;
      }
      const response = await fetcher("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${options.clientId}:${clientSecret}`).toString("base64")}`,
          "User-Agent": agent,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) {
        page(
          res,
          502,
          response.status === 401
            ? "Reddit refuse les identifiants de l’application (HTTP 401). Dans reddit.com/prefs/apps, ouvrir edit sur l’application dont le client ID correspond à celui du formulaire, puis copier la valeur secret (pas le client ID). Aucun identifiant enregistré. Une nouvelle connexion OAuth est nécessaire."
            : `Reddit a refusé l’échange OAuth (HTTP ${String(response.status)}). Aucun identifiant enregistré.`,
        );
        return;
      }
      const tokens = tokenSchema.parse(await response.json());
      const scopes = new Set(tokens.scope.split(/[ ,]+/));
      if (
        !scopes.has("identity") ||
        !scopes.has("read") ||
        (options.enableReplies && !scopes.has("privatemessages"))
      )
        throw new Error("Missing scopes");
      const meResponse = await fetcher("https://oauth.reddit.com/api/v1/me", {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${tokens.access_token}`, "User-Agent": agent },
      });
      if (!meResponse.ok) throw new Error("Identity check failed");
      const me = z.object({ name: z.string() }).parse(await meResponse.json());
      if (me.name.toLowerCase() !== options.username.toLowerCase()) {
        page(
          res,
          409,
          "Le compte autorisé ne correspond pas au compte demandé. Aucun identifiant enregistré.",
        );
        return;
      }
      const config = redditConnectionSchema.parse({
        version: 1,
        enabled: true,
        clientId: options.clientId,
        ...(options.webApp ? { clientSecret } : {}),
        refreshToken: tokens.refresh_token,
        userAgent: agent,
        allowWrite: false,
        scopes: [...scopes],
        syncReplies: options.enableReplies,
        subscriptions: previous?.subscriptions ?? [],
      });
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const contents = JSON.stringify(config, null, 2) + "\n";
      if (previousText === undefined) fs.writeFileSync(file, contents, { flag: "wx", mode: 0o600 });
      else {
        const lock = `${file}.upgrade-lock`;
        const fd = fs.openSync(lock, "wx", 0o600);
        const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
        try {
          if (fs.readFileSync(file, "utf8") !== previousText)
            throw new Error("Connexion modifiée pendant le consentement");
          fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
          fs.renameSync(temporary, file);
        } finally {
          fs.closeSync(fd);
          fs.rmSync(lock, { force: true });
          fs.rmSync(temporary, { force: true });
        }
      }
      succeeded = true;
      clientSecret = "";
      res.writeHead(303, {
        Location: "/done",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
    }
  });
  async function close() {
    clearTimeout(timer);
    clientSecret = "";
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Adresse locale indisponible");
  host = `127.0.0.1:${String(address.port)}`;
  redirectUri = `http://${host}/reddit/callback`;
  const authorize = new URL("https://www.reddit.com/api/v1/authorize");
  authorize.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    state,
    redirect_uri: redirectUri,
    duration: "permanent",
    scope: options.enableReplies ? "identity read privatemessages" : "identity read",
  }).toString();
  authorizationUrl = authorize.href;
  const timer = setTimeout(() => {
    void close();
  }, 10 * 60_000);
  timer.unref();
  return {
    authorizationUrl,
    setupUrl: options.webApp && !prepared ? `http://${host}/connect/${state}` : authorizationUrl,
    redirectUri,
    close,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flag = (name: string) => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    const dataDir = flag("--data-dir") ?? process.env["MIND_WAKE_DATA_DIR"];
    const file = flag("--config") ?? (dataDir ? path.join(dataDir, "reddit.json") : undefined);
    if (!file) throw new Error("Préciser --data-dir ou --config.");
    const connection = await startRedditConnect({
      clientId: flag("--client-id") ?? "",
      username: flag("--username") ?? "",
      configFile: file,
      webApp: args.includes("--web-app"),
      enableReplies: args.includes("--enable-replies"),
    });
    process.stdout.write(`Connectez Reddit dans votre navigateur :\n${connection.setupUrl}\n`);
    process.once("SIGINT", () => {
      void connection.close();
    });
    process.once("SIGTERM", () => {
      void connection.close();
    });
  } catch {
    process.stderr.write(
      "Connexion Reddit non démarrée. Vérifier --client-id, --username, --data-dir/--config, le port 8765 et l’absence de connexion existante.\n",
    );
    process.exitCode = 1;
  }
}

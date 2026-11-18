// Ed25519 via WebCrypto (copie du prototype p2p-1930, repris du relais v0 ; adresses en ⬡).
const enc = new TextEncoder();

export function b64uEncode(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(str) {
  const p = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const s = atob(p);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** JSON canonique : clés triées récursivement, pas d'espaces. */
export function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export async function generateKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return { publicKey: "ed25519:" + b64uEncode(pub), privateKey: b64uEncode(priv) };
}

export async function sign(privateKey, text) {
  const key = await crypto.subtle.importKey("pkcs8", b64uDecode(privateKey), { name: "Ed25519" }, false, ["sign"]);
  return b64uEncode(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(text)));
}

export async function verify(publicKey, text, sig) {
  try {
    if (typeof publicKey !== "string" || !publicKey.startsWith("ed25519:")) return false;
    const key = await crypto.subtle.importKey("raw", b64uDecode(publicKey.slice(8)), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64uDecode(sig), enc.encode(text));
  } catch { return false; }
}

// --- noms et adresses -------------------------------------------------
export const NAME_RE = /^⬡[a-z0-9][a-z0-9-]{1,30}$/;
export const ADDR_RE = /^(⬡[a-z0-9][a-z0-9-]{1,30})(?:\/([a-z0-9][a-z0-9_-]{0,31}))?$/;

export function parseAddress(addr) {
  if (typeof addr !== "string") return null;
  const m = ADDR_RE.exec(addr.normalize("NFC"));
  return m ? { colony: m[1], agent: m[2] ?? null } : null;
}

// --- textes signés ----------------------------------------------------
export const registerText = (name, publicKey, ts) => `mw-register|${name}|${publicKey}|${ts}`;
export const connectText = (name, nonce) => `mw-connect|${name}|${nonce}`;
export const envelopeText = (env) => { const { sig, ...rest } = env; return "mw-msg|" + canonical(rest); };
export const ficheText = (fiche) => { const { signature, ...rest } = fiche; return "mw-fiche|" + canonical(rest); };

export async function signEnvelope(privateKey, env) {
  return { ...env, sig: await sign(privateKey, envelopeText(env)) };
}
export async function signFiche(privateKey, fiche) {
  return { ...fiche, signature: await sign(privateKey, ficheText(fiche)) };
}

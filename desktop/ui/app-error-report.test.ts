import { expect, it, vi } from "vitest";
import { createAppErrorReporter, looksLikeError } from "./app-error-report.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const at = () => Date.parse("2026-11-17T14:50:00Z");

it("sends every reported error, identical ones included (v1: no dedup)", async () => {
  const send = vi.fn(async () => ({}));
  const reporter = createAppErrorReporter(send, at);
  reporter.report("panneau · Appel", "Passerelle indisponible");
  reporter.report("panneau · Appel", "Passerelle indisponible");
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledWith("panneau · Appel", "Passerelle indisponible", "2026-11-17T14:50:00.000Z");
});

it("reports a visible status error when it appears or changes, not on identical repaints or ticking counters", async () => {
  const send = vi.fn(async () => ({}));
  let t = at();
  const reporter = createAppErrorReporter(send, () => t);
  reporter.shownText("reason", "panneau", "Première lecture en cours.");
  reporter.shownText("reason", "panneau", "Lecture impossible : wake_unavailable (il y a 3 s)");
  reporter.shownText("reason", "panneau", "Lecture impossible : wake_unavailable (il y a 4 s)");
  reporter.shownText("reason", "panneau", "Lecture impossible : provider_down");
  // Brief non-error (retry) then the same error: not a new error.
  reporter.shownText("reason", "panneau", "");
  t += 10_000;
  reporter.shownText("reason", "panneau", "Lecture impossible : provider_down");
  // Same error after a real recovery (> 60 s without error): sent again.
  reporter.shownText("reason", "panneau", "Connexion…");
  t += 61_000;
  reporter.shownText("reason", "panneau", "Lecture impossible : provider_down");
  await flush();
  expect(send.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
    "Lecture impossible : wake_unavailable (il y a 3 s)",
    "Lecture impossible : provider_down",
    "Lecture impossible : provider_down",
  ]);
});

it("#call-status: the retry cycle every 20 s does not re-send the same error; mind.call.ready resets it", async () => {
  const { errorShape } = await import("./app-error-report.js");
  const send = vi.fn(async () => ({}));
  let t = at();
  const reporter = createAppErrorReporter(send, () => t);
  const failed = "Écran d’appel indisponible. Vérifie que la passerelle mobile est démarrée et que son export web est à jour.";
  for (let cycle = 0; cycle < 5; cycle++) {
    reporter.shownText("call-status", "panneau · Appel · #call-status", "Ouverture de l’appel…");
    t += 10_000;
    reporter.shownText("call-status", "panneau · Appel · #call-status", failed);
    t += 10_000;
  }
  expect(errorShape(`${failed}\n[iframe appel : src=x, src posé il y a 12 s ; load reçu : oui ; mind.call.ready reçu : non]`))
    .toBe(errorShape(`${failed}\n[iframe appel : src=x, src posé il y a 31 s ; load reçu : non ; mind.call.ready reçu : non]`));
  reporter.forget("call-status");
  reporter.shownText("call-status", "panneau · Appel · #call-status", failed);
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
});

it("never re-relays a relayed « Erreur app » message (feedback loop guard)", async () => {
  const send = vi.fn(async () => ({}));
  const reporter = createAppErrorReporter(send, at);
  reporter.report("panneau", "Erreur affichée à NLR — app desktop, écran « x » : indisponible");
  reporter.consoleError(["Erreur app: Relais automatique, pas un message humain"], "panneau");
  await flush();
  expect(send).not.toHaveBeenCalled();
});

it("reports failed native commands by name only, never the report command itself, and survives a dead relay", async () => {
  const send = vi.fn(async () => { throw new Error("relay down"); });
  const reporter = createAppErrorReporter(send, at);
  reporter.commandFailed("wake_reply", "CLI introuvable", "panneau");
  reporter.commandFailed("app_error_report", "boom", "panneau");
  reporter.consoleError([new Error("fetch failed")], "panneau");
  await flush();
  expect(send).toHaveBeenCalledTimes(2);
  expect((send.mock.calls[0] as unknown[])[1]).toBe("Commande wake_reply en échec : CLI introuvable");
  expect((send.mock.calls[1] as unknown[])[1]).toContain("fetch failed");
});

it("recognises error wording in French and English", () => {
  for (const text of ["Échec de l'envoi", "Lecture impossible", "Dictée ElevenLabs indisponible", "Request failed", "Session expirée"])
    expect(looksLikeError(text)).toBe(true);
  for (const text of ["Connexion…", "Première lecture en cours.", "Voice Mode en pause", "Envoyé"])
    expect(looksLikeError(text)).toBe(false);
});

it("describes the call iframe state (src, load, mind.call.ready) attached to call errors", async () => {
  const { createCallFrameTracker } = await import("./app-error-report.js");
  let t = Date.parse("2026-11-17T14:50:00Z");
  const frame = createCallFrameTracker(() => t);
  expect(frame.describe()).toBe("[iframe appel : src=(aucun) ; load reçu : non ; mind.call.ready reçu : non]");
  frame.srcChanged("http://127.0.0.1:8789/desktop-call?receiver=desktop");
  frame.loaded();
  t += 10_000;
  expect(frame.describe()).toBe("[iframe appel : src=http://127.0.0.1:8789/desktop-call?receiver=desktop, src posé il y a 10 s ; load reçu : oui ; mind.call.ready reçu : non]");
  frame.ready();
  expect(frame.describe()).toContain("mind.call.ready reçu : oui");
  frame.srcChanged(null);
  expect(frame.describe()).toContain("load reçu : non ; mind.call.ready reçu : non");
});

it("restarts the call iframe state when openCall() re-assigns the same src (retry every 20 s)", async () => {
  const { createCallFrameTracker } = await import("./app-error-report.js");
  let t = Date.parse("2026-11-17T15:43:46Z");
  const frame = createCallFrameTracker(() => t);
  const src = "http://127.0.0.1:8789/desktop-call?receiver=desktop";
  frame.srcChanged(src);
  frame.loaded();
  t += 120_000;
  frame.srcChanged(src);
  expect(frame.describe()).toContain("src posé il y a 120 s ; load reçu : oui");
  frame.srcChanged(src, true);
  t += 11_000;
  expect(frame.describe()).toBe(`[iframe appel : src=${src}, src posé il y a 11 s ; load reçu : non ; mind.call.ready reçu : non]`);
});

it("never treats conversation transcripts or message bubbles as displayed errors (#chat false positives)", async () => {
  const { watchableErrorZone, WATCHED, TRANSCRIPT } = await import("./app-error-report.js");
  const zone = (o: { watched: boolean; inTranscript: boolean; ownSendStatus?: boolean }) => ({
    matches: (selector: string) => selector === WATCHED ? o.watched : Boolean(o.ownSendStatus),
    closest: (selector: string) => (selector === TRANSCRIPT && o.inTranscript ? ({} as Element) : null),
  });
  // #chat is only aria-live: not a watched selector any more.
  expect(WATCHED).not.toContain("aria-live");
  expect(TRANSCRIPT).toContain("#chat");
  // A status/alert inside a transcript (bubble text with « indisponible », « erreur »…) is ignored.
  expect(watchableErrorZone(zone({ watched: true, inTranscript: true }))).toBe(false);
  // No exception, not even a bubble's own status line.
  expect(watchableErrorZone(zone({ watched: true, inTranscript: true, ownSendStatus: true }))).toBe(false);
  // Real error zones outside transcripts are watched; unmarked elements are not.
  expect(watchableErrorZone(zone({ watched: true, inTranscript: false }))).toBe(true);
  expect(watchableErrorZone(zone({ watched: false, inTranscript: false }))).toBe(false);
});

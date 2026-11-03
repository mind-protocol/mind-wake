import { afterEach, describe, expect, it, vi } from "vitest";
import { english } from "./translations.js";
import { formatLocale, getLanguage, LANGUAGE_KEY, resolveLanguage, setLanguage, translate } from "./i18n.js";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("interface language", () => {
  it("honors a saved choice, detects supported system languages and falls back to English", () => {
    expect(resolveLanguage("fr", ["en-US"])).toBe("fr");
    expect(resolveLanguage("en", ["fr-CA"])).toBe("en");
    expect(resolveLanguage(null, ["de-DE", "fr-CA", "en"])).toBe("fr");
    expect(resolveLanguage("invalid", ["en-GB"])).toBe("en");
    expect(resolveLanguage(null, ["ja-JP"])).toBe("en");
  });

  it("persists the choice and uses it for dates and numbers", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    setLanguage("en");
    expect(values.get(LANGUAGE_KEY)).toBe("en");
    expect(getLanguage()).toBe("en");
    expect(formatLocale()).toBe("en-US");
    setLanguage("fr");
    expect(formatLocale()).toBe("fr-FR");
  });

  it("handles unavailable storage without breaking startup", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw Error("blocked"); } });
    vi.stubGlobal("navigator", { languages: ["en-GB"] });
    expect(getLanguage()).toBe("en");
  });

  it("interpolates once and leaves user values and unknown source text intact", () => {
    expect(translate("en", "Projet : {0}", ["Envoyer {0} $& <script>"])).toBe("Project: Envoyer {0} $& <script>");
    expect(translate("fr", "Projet : {0}", ["My project"])).toBe("Projet : My project");
    expect(translate("en", "personal content")).toBe("personal content");
  });

  it("preserves all numbered placeholders in every catalog entry", () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    for (const [key, value] of Object.entries(english)) expect(placeholders(value), key).toEqual(placeholders(key));
  });

  it("renders real status and delivery labels in English while preserving payload text", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    vi.stubGlobal("localStorage", { getItem: () => "en" });
    const { panelView } = await import("./view.js");
    expect(panelView(null, 0).headline).toBe("Status unavailable");
    const { conversationReceipt, conversationText } = await import("./conversation.js");
    const item = { from: "human" as const, at: "2026-11-03T00:00:00Z", text: "Envoyer {0}", delivery: "delivered" as const };
    expect(conversationReceipt(item)?.title).toBe("Delivered to the session. Does not confirm reading.");
    expect(conversationText(item, text => text)).toBe(item.text);
  });

  it("changes marked interface labels in both directions without replacing icons or drafts", async () => {
    let language = "en";
    vi.stubGlobal("localStorage", { getItem: () => language });
    const text = { nodeType: 3, textContent: "  Envoyer " };
    const icon = { nodeType: 1, textContent: "↗" };
    const button = { dataset: { i18n: "Envoyer" }, childNodes: [text, icon] };
    const draft = { value: "Envoyer: mon texte personnel" };
    const root = {
      documentElement: { lang: "fr" },
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === "[data-i18n]" ? [button] : [],
    };
    vi.stubGlobal("document", root);
    vi.stubGlobal("window", { addEventListener: () => {} });
    const { translateDocument } = await import("./i18n-dom.js");
    expect(root.documentElement.lang).toBe("en");
    expect(text.textContent).toBe("  Send ");
    language = "fr";
    translateDocument(root as unknown as Document);
    expect(text.textContent).toBe("  Envoyer ");
    expect(button.childNodes[1]).toBe(icon);
    expect(draft.value).toBe("Envoyer: mon texte personnel");
  });
});

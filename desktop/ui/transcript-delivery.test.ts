import { expect, it, vi } from "vitest";
import { deliverTranscript } from "./transcript-delivery.js";
it("shows human text before attachments and persists the same recording identity", async () => {
  let finish!: (suffix: string) => void;
  const show = vi.fn((_key: string, _text: string) => ({ human: true }));
  const send = vi.fn(
      async (_key: string, _text: string, _bubble: object) => {},
    ),
    update = vi.fn();
  const pending = deliverTranscript("Oui !", [], "recording-1", {
    show,
    send,
    update,
    cancelled: () => false,
    warning: vi.fn(),
    attachments: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  expect(show).toHaveBeenCalledWith(
    "ui-voice-recording-1",
    "[Dictée vocale]\nOui !",
  );
  expect(send).not.toHaveBeenCalled();
  finish("");
  await pending;
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toBe("ui-voice-recording-1");
  expect(show).toHaveBeenCalledOnce();
});
it("suppresses empty/cancelled text and preserves valid text if attachments fail", async () => {
  const show = vi.fn((_key: string, _text: string) => ({}));
  const send = vi.fn(
      async (_key: string, _text: string, _bubble: object) => {},
    ),
    warning = vi.fn();
  const options = {
    show,
    send,
    warning,
    update: vi.fn(),
    cancelled: () => false,
    attachments: async () => {
      throw Error("image");
    },
  };
  await deliverTranscript(" \n ", [], "empty", options);
  expect(show).not.toHaveBeenCalled();
  await deliverTranscript("Oui", [], "cancelled", {
    ...options,
    cancelled: () => true,
  });
  expect(send).not.toHaveBeenCalled();
  await deliverTranscript("Oui", [], "valid", options);
  expect(send).toHaveBeenCalledOnce();
  expect(warning).toHaveBeenCalledOnce();
});

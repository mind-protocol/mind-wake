export type SpeechEvents = { start: () => void; done: () => void; error: (message: string) => void };
export type SpeechEngine = { available: () => boolean; speak: (text: string, events: SpeechEvents) => void; stop: () => void };

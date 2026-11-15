export type DictationProvider = 'current' | 'elevenlabs';

/** An explicit UI selection is required; unknown/restored values stay on the current dictation. */
export function selectedDictationProvider(value: unknown): DictationProvider {
  return value === 'elevenlabs' ? 'elevenlabs' : 'current';
}

export function dictationProviderLabel(provider: DictationProvider): string {
  return provider === 'elevenlabs' ? 'ElevenLabs' : 'Dictée actuelle';
}

/** Select exactly one existing service. A refused request never falls back to another provider. */
export async function transcribeUsingProvider<T>(provider: DictationProvider, services: {
  current(): Promise<T>;
  elevenlabs(): Promise<T>;
}): Promise<T> {
  return provider === 'elevenlabs' ? services.elevenlabs() : services.current();
}

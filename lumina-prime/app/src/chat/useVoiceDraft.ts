import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatErrorMessage, ChatClientError, transcribeChatVoice, type ChatSession } from './client.ts';
import { createVoiceController, voiceErrorMessage, type VoiceRecording, type VoiceState } from './voice-controller.ts';
export type VoiceInputProps = { session: ChatSession; onTranscript: (text: string) => void; onBusy: (busy: boolean) => void };
export function useVoiceDraft(props: VoiceInputProps, begin: (signal: AbortSignal) => Promise<VoiceRecording>) {
  const latest = useRef({ props, begin });
  const mounted = useRef(true); const [state, setState] = useState<VoiceState>({ phase: 'idle', message: null });
  const instance = useRef<ReturnType<typeof createVoiceController> | null>(null);
  useEffect(() => { latest.current = { props, begin }; }, [props, begin]);
  useEffect(() => {
    mounted.current = true;
    const control = createVoiceController({
      begin: signal => latest.current.begin(signal),
      transcribe: (clip, signal) => transcribeChatVoice(latest.current.props.session, clip.audio, clip.mime, signal),
      onTranscript: text => latest.current.props.onTranscript(text),
      onState: value => { if (mounted.current) { setState(value); latest.current.props.onBusy(value.phase !== 'idle'); } },
      describeError: error => error instanceof ChatClientError ? chatErrorMessage(error) : voiceErrorMessage(error),
    });
    instance.current = control;
    return () => { mounted.current = false; latest.current.props.onBusy(false); instance.current = null; void control.cancel(); };
  }, []);
  const start = useCallback(async () => { await instance.current?.start(); }, []);
  const finish = useCallback(async () => { await instance.current?.finish(); }, []);
  const cancel = useCallback(async () => { await instance.current?.cancel(); }, []);
  const controller = useMemo(() => ({ start, finish, cancel }), [start, finish, cancel]);
  return { state, controller };
}

import React, { useEffect } from 'react';
import { VoiceControls } from './VoiceControls';
import { useVoiceDraft, type VoiceInputProps } from './useVoiceDraft';
import { VoiceError, type VoiceClip, type VoiceRecording } from './voice-controller.ts';

async function begin(signal: AbortSignal): Promise<VoiceRecording> {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new VoiceError('secure_context_required');
  if (typeof MediaRecorder === 'undefined') throw new VoiceError('microphone_unavailable');
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch (error) { throw new VoiceError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'permission_denied' : 'microphone_unavailable'); }
  const release = () => stream.getTracks().forEach(track => track.stop());
  if (signal.aborted) { release(); throw new VoiceError('recording_cancelled'); }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mime) { release(); throw new VoiceError('microphone_unavailable'); }
  const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 96_000 });
  const chunks: Blob[] = []; let size = 0; let failure: VoiceError | null = null;
  let resolveStop: ((clip: VoiceClip) => void) | null = null; let rejectStop: ((reason: unknown) => void) | null = null;
  let finished = false;
  recorder.ondataavailable = event => {
    if (event.data.size) { size += event.data.size; if (size <= 4 * 1024 * 1024) chunks.push(event.data); }
    if (size > 4 * 1024 * 1024) { failure = new VoiceError('recording_too_large'); if (recorder.state !== 'inactive') recorder.stop(); }
  };
  recorder.onerror = () => { failure = new VoiceError('microphone_unavailable'); release(); rejectStop?.(failure); };
  recorder.onstop = () => {
    finished = true; release();
    if (failure) { rejectStop?.(failure); return; }
    if (!chunks.length) { rejectStop?.(new VoiceError('empty_audio')); return; }
    resolveStop?.({ audio: new Blob(chunks, { type: mime }), mime: mime.split(';')[0] });
  };
  try { recorder.start(1000); } catch { release(); throw new VoiceError('microphone_unavailable'); }
  return {
    async stop() {
      if (failure) { release(); throw failure; }
      if (finished) return { audio: new Blob(chunks, { type: mime }), mime: mime.split(';')[0] };
      return new Promise<VoiceClip>((resolve, reject) => { resolveStop = resolve; rejectStop = reject;
        if (recorder.state !== 'inactive') recorder.stop(); else { release(); reject(new VoiceError('empty_audio')); } });
    },
    async cancel() { failure = new VoiceError('recording_cancelled'); chunks.length = 0; if (recorder.state !== 'inactive') recorder.stop(); release(); },
  };
}
export default function VoiceInput(props: VoiceInputProps) {
  const { state, controller } = useVoiceDraft(props, begin);
  useEffect(() => { const hidden = () => { if (document.hidden) void controller.cancel(); };
    document.addEventListener('visibilitychange', hidden); return () => document.removeEventListener('visibilitychange', hidden); }, [controller]);
  return <VoiceControls state={state} start={() => { void controller.start(); }} finish={() => { void controller.finish(); }} cancel={() => { void controller.cancel(); }} />;
}

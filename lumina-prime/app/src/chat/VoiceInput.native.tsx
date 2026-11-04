import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { VoiceControls } from './VoiceControls';
import { useVoiceDraft, type VoiceInputProps } from './useVoiceDraft';
import { VoiceError } from './voice-controller.ts';

export default function VoiceInput(props: VoiceInputProps) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  async function removeRecording() {
    if (recorder.uri) { try { const file = new File(recorder.uri); if (file.exists) file.delete(); } catch { /* Cache file may already be gone. */ } }
    try { await setAudioModeAsync({ allowsRecording: false }); } catch { /* The recorder is stopped; native teardown may already have run. */ }
  }
  const { state, controller } = useVoiceDraft(props, async signal => {
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) throw new VoiceError('permission_denied');
    if (signal.aborted) throw new VoiceError('recording_cancelled');
    await setAudioModeAsync({ allowsRecording: true, allowsBackgroundRecording: false, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    if (signal.aborted) { await removeRecording(); throw new VoiceError('recording_cancelled'); }
    recorder.record();
    return {
      async stop() {
        await recorder.stop();
        if (!recorder.uri) throw new VoiceError('empty_audio');
        const file = new File(recorder.uri);
        if (!file.size || file.size > 4 * 1024 * 1024) { await removeRecording(); throw new VoiceError('recording_too_large'); }
        const bytes = await file.bytes();
        return { audio: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          mime: 'audio/mp4', cleanup: removeRecording };
      },
      async cancel() { try { await recorder.stop(); } finally { await removeRecording(); } },
    };
  });
  useEffect(() => { const subscription = AppState.addEventListener('change', next => {
    if (next === 'background' || (next === 'inactive' && state.phase === 'recording')) void controller.cancel();
  }); return () => subscription.remove(); }, [controller, state.phase]);
  return <VoiceControls state={state} start={() => { void controller.start(); }} finish={() => { void controller.finish(); }} cancel={() => { void controller.cancel(); }} />;
}

import {expect,it,vi} from 'vitest';
import {dictationProviderLabel,selectedDictationProvider,transcribeUsingProvider} from './dictation-provider.js';

it('keeps the current dictation unless ElevenLabs is explicitly selected', async()=>{
  for(const input of [undefined,null,'','unknown','current']) expect(selectedDictationProvider(input)).toBe('current');
  expect(selectedDictationProvider('elevenlabs')).toBe('elevenlabs');
  const current=vi.fn(async()=> 'Texte actuel'), elevenlabs=vi.fn(async()=> 'Autre fournisseur');
  expect(await transcribeUsingProvider(selectedDictationProvider(undefined),{current,elevenlabs})).toBe('Texte actuel');
  expect(current).toHaveBeenCalledOnce();expect(elevenlabs).not.toHaveBeenCalled();
});

it('uses the explicit provider and preserves the exact result without rewriting', async()=>{
  const current=vi.fn(async()=> ''),elevenlabs=vi.fn(async()=> 'Oui, ça me convient !');
  expect(await transcribeUsingProvider('elevenlabs',{current,elevenlabs})).toBe('Oui, ça me convient !');
  expect(elevenlabs).toHaveBeenCalledOnce();expect(current).not.toHaveBeenCalled();
  expect(dictationProviderLabel('current')).toBe('Dictée actuelle');
  expect(dictationProviderLabel('elevenlabs')).toBe('ElevenLabs');
});

it('does not retry or silently fall back after a provider refusal or cancellation', async()=>{
  for(const provider of ['current','elevenlabs'] as const){
    for(const refusal of [new Error('Refus explicite'),new DOMException('Annulé','AbortError')]){
      const current=vi.fn(async()=>{throw refusal;}),elevenlabs=vi.fn(async()=>{throw refusal;});
      await expect(transcribeUsingProvider(provider,{current,elevenlabs})).rejects.toBe(refusal);
      expect(provider==='current'?current:elevenlabs).toHaveBeenCalledOnce();
      expect(provider==='current'?elevenlabs:current).not.toHaveBeenCalled();
    }
  }
});

import type {VoiceModeListener,VoiceModeState} from "./voice-mode-view.js";

/** Ce que le réglage lit et pilote : l'état Voice Mode unique, le même que Play/Pause. */
export interface VoiceSwitchSource{state():VoiceModeState|undefined;setEnabled(on:boolean):Promise<void>;subscribe(listener:VoiceModeListener):()=>void;}

export const VOICE_SWITCH_UNAVAILABLE='Disponible seulement dans l’app desktop MIND Wake.';

/** Interrupteur « Voice » des Réglages. Aucun état propre : il reflète Voice Mode et le pilote.
 * Sans source (navigateur, pas de Tauri), il reste désactivé avec une explication. */
export function mountVoiceSettingsSwitch(control:HTMLButtonElement,note:HTMLElement,source:VoiceSwitchSource|undefined):()=>void{
  const show=(on:boolean)=>{control.setAttribute('aria-checked',String(on));control.textContent=on?'On':'Off';};
  if(!source){show(false);control.disabled=true;note.textContent=VOICE_SWITCH_UNAVAILABLE;return ()=>{};}
  const unsubscribe=source.subscribe((state,switching)=>{
    show(state?.enabled===true);control.disabled=switching;
    note.textContent=state?.forceOff?'Wake arrêté : Voice reprendra après redémarrage.':state===undefined?'État Voice non confirmé.':'';
  });
  control.addEventListener('click',()=>{
    const on=control.getAttribute('aria-checked')!=='true';show(on);
    // Off coupe aussi les captures des fils secondaires, comme le bouton Pause de l'en-tête.
    if(!on)window.dispatchEvent(new Event('fork-voice-stop'));
    void source.setEnabled(on);
  });
  return unsubscribe;
}

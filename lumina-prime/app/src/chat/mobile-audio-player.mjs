/** Browser candidate. Requires an explicit user gesture to enable; no promise of
 * Android background playback. Audio and credentials never go through Telegram. */
export function createMobilePlayer({ request, audio = new Audio(), onSpeaking = () => {}, onState = () => {}, intervalMs = 1000 }) {
  let enabled=false, activationId, timer, current, objectUrl, generation=0, enabling=null;
  const seen=new Set();
  const clearAudio=()=>{ audio.onplaying=null; audio.onended=null; audio.onerror=null; audio.pause(); audio.removeAttribute('src'); audio.load(); if(objectUrl) URL.revokeObjectURL(objectUrl); objectUrl=null; onSpeaking(false); };
  const receipt=(clip,state,extra={})=>request('/receipt',{method:'POST',body:{deliveryId:clip.deliveryId,state,...extra}});
  async function halt(reason) { enabled=false; enabling=null; generation++; clearTimeout(timer); clearAudio(); current=null; onState(reason); }
  async function tick() {
    if(!enabled) return;
    const epoch=generation;
    try {
      const status=await request('/status');
      if(!enabled || epoch!==generation) return;
      if(status.activationId!==activationId) { await halt('activation_changed'); return; }
      if(!current) {
        const {clip}=await request('/next');
        if(!enabled || epoch!==generation) return;
        if(clip) {
          // A recovered received/started clip is deliberately not replayed.
          if(seen.has(clip.deliveryId) || clip.state!=='offered') { await receipt(clip,'stopped'); }
          else {
            seen.add(clip.deliveryId); current=clip;
            const response=await request(`/clip/${clip.deliveryId}`,{binary:true});
            if(!enabled || epoch!==generation) return;
            const bytes=await response.arrayBuffer();
            const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
            if(!enabled || epoch!==generation) return;
            if(bytes.byteLength!==clip.size || hash!==clip.sha256) { await receipt(clip,'failed',{errorCode:'integrity_failed'}); throw new Error('integrity_failed'); }
            await receipt(clip,'received',{sha256:hash});
            if(!enabled || epoch!==generation) return;
            objectUrl=URL.createObjectURL(new Blob([bytes],{type:clip.mime})); audio.src=objectUrl;
            let started;
            audio.onplaying=()=>{ if(enabled && epoch===generation && current===clip && !started) { started=receipt(clip,'started'); started.catch(()=>{if(epoch===generation)void halt('receipt_failed');}); onState('started'); } };
            audio.onended=()=>{ if(current===clip && started) { started.then(()=>receipt(clip,'ended')).then(()=>{ if(epoch===generation && current===clip) { clearAudio(); current=null; onState('ended'); } }).catch(()=>{if(epoch===generation)void halt('receipt_failed');}); } };
            audio.onerror=()=>{ if(epoch!==generation)return;void receipt(clip,'failed',{errorCode:'playback_error'}).catch(()=>{}).then(()=>{if(epoch===generation)void halt('playback_error');}); };
            // Stop capture synchronously BEFORE sound starts, including synchronous players.
            onSpeaking(true);
            try { await audio.play(); } catch {
              if(epoch!==generation)return;
              try { await receipt(clip,'failed',{errorCode:'playback_blocked'}); }
              finally { if(epoch===generation)await halt('playback_blocked'); }
              return;
            }
          }
        }
      }
      if(enabled) timer=setTimeout(tick,intervalMs);
    } catch { if(epoch===generation)await halt('connection_or_playback_failed'); }
  }
  return {
    enable() {
      if(enabling)return enabling;
      void halt('enabling');const epoch=generation;
      const attempt=(async()=>{try {
        const state=await request('/activate',{method:'POST',body:{}});
        if(epoch!==generation)return;
        activationId=state.activationId;enabled=true;onState('enabled');void tick();
      }catch(error){if(epoch===generation)await halt('activation_failed');throw error;}})();
      enabling=attempt;
      const clear=()=>{if(enabling===attempt)enabling=null;};attempt.then(clear,clear);
      return attempt;
    },
    async stop() { await halt('stopped'); await request('/pause',{method:'POST',body:{}}); },
    dispose() { return this.stop(); },
  };
}

export function chatAudioRequest({url,token}, fetcher=fetch) {
  return async (suffix,{method='GET',body,binary=false}={})=>{
    const response=await fetcher(`${url}/chat/audio${suffix}`,{method,headers:{Authorization:`Bearer ${token}`,...(body ? {'Content-Type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(5000)});
    if(!response.ok) throw new Error('mobile_audio_request_failed');
    return binary ? response : response.json();
  };
}

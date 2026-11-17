const {core,event} = window.__TAURI__;
const caller = document.getElementById("caller");
const accept = document.getElementById("accept");
const end = document.getElementById("end");
let current;
function render(toast) {
  current = toast;
  caller.textContent = toast?.label ?? "";
  accept.hidden = toast?.stage !== "ringing";
  document.getElementById("phase").textContent = toast?.stage === "active" ? "En appel · MIND Wake" : "Appel entrant · MIND Wake";
  end.setAttribute("aria-label", toast?.stage === "active" ? "Raccrocher" : "Raccrocher et refuser l’appel");
}
async function act(action) {
  if (!current) return;
  try { await core.invoke("phone_toast_action", {id:current.id,action}); }
  catch { render(await core.invoke("phone_toast_state")); }
}
accept.onclick = () => act("accept");
end.onclick = () => act(current?.stage === "active" ? "hangup" : "decline");
await event.listen("phone-toast-change", e => render(e.payload));
render(await core.invoke("phone_toast_state"));

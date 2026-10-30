// Keep dismissal available even if a dependency of the message UI fails to load.
(() => {
  const button = document.getElementById('cancel');
  const status = document.getElementById('status');
  async function dismiss() {
    try { await window.__TAURI__.core.invoke('quick_input_close'); }
    catch (error) { if (status) status.textContent = `Fermeture impossible : ${String(error)}`; }
  }
  button?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void dismiss();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    void dismiss();
  });
})();

// Independent of the main bundle: even a startup failure leaves an exit available.
(() => {
  const screen = document.getElementById('wake-loading');
  const app = document.querySelector('body > main');
  const skip = document.getElementById('wake-loading-skip');
  if (!screen || !app || !skip) return;
  app.inert = true;
  let finished = false;
  const slow = setTimeout(() => {
    let language;
    try { language = localStorage.getItem('mind-wake.language'); } catch { /* Storage unavailable. */ }
    const french = language === 'fr' || (language !== 'en' && document.documentElement.lang === 'fr');
    document.getElementById('wake-loading-status').textContent =
      french ? 'La connexion prend un peu de temps. Tu peux déjà ouvrir l’interface.' : 'Connecting is taking a little longer. You can already open the interface.';
  }, 8000);
  function dismiss() {
    if (finished) return;
    finished = true;
    clearTimeout(slow);
    app.inert = false;
    const hadFocus = screen.contains(document.activeElement);
    screen.classList.add('is-leaving');
    screen.setAttribute('aria-hidden', 'true');
    screen.inert = true;
    if (hadFocus) app.querySelector('button')?.focus();
    setTimeout(() => screen.remove(), 500);
  }
  skip.addEventListener('click', dismiss);
  window.addEventListener('wake-interface-ready', dismiss, { once: true });
})();

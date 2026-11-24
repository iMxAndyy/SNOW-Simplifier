// Asks Edge for access to all websites (needs a click on an extension page), then turns reset page detection on.
(function () {
  const btn = document.getElementById('allow');
  const status = document.getElementById('status');
  const show = (text, cls) => { status.textContent = text; status.className = cls || ''; };

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (e) {
      show(`Couldn't ask for access: ${e.message}`, 'bad');
      btn.disabled = false;
      return;
    }
    if (!granted) {
      show('Not turned on: access wasn\'t allowed. You can try again any time.', 'bad');
      btn.disabled = false;
      return;
    }
    const res = await chrome.runtime.sendMessage({ type: 'pw-enabled' }).catch(() => null);
    if (res && res.ok) {
      show('✓ Reset page detection is on. You can close this tab.', 'ok');
      btn.textContent = 'Done';
    } else {
      show('Access was allowed, but detection couldn\'t be switched on. Reload the extension and try again.', 'bad');
      btn.disabled = false;
    }
  });
})();

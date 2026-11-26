(function () {
  // This one file plays four parts (kept in one file so the updater only needs content.js, styles.css and manifest.json):
  //  1. the extension's background service worker (no page): turns password-reset detection on/off
  //  2. the ISOLATED-world copy on WLUK pages: publishes the real version for the hub, and lets the hub
  //     reach the extension's storage (Password Expiry data is shared with the reset-page bar)
  //  3. the ISOLATED-world copy on other sites, only once reset detection is turned on: the
  //     "did you reset this password?" bar on an account's reset page
  //  4. the MAIN-world copy on WLUK pages: the Support Hub (everything after this block)
  if (typeof document === 'undefined') {
    snBackground();
    return;
  }
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
      if (window.top === window.self) {
        if (location.hostname === 'wluk.service-now.com') {
          document.documentElement.setAttribute('data-sn-simplifier-version', chrome.runtime.getManifest().version);
          snStorageBridge();
        }
        snResetDetector();
      }
      return;
    }
  } catch (e) {}

  // =====================================================================
  // Password Expiry: shared helpers (used by the hub and by the reset-page bar)
  // No passwords are ever stored: only account names, optional usernames, dates, links and steps.
  // =====================================================================
  function pwToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Does this address belong to the account's reset page? ('site' = anywhere on that website, 'page' = that page and below)
  function pwUrlMatches(acc, href) {
    if (!acc || !acc.resetUrl || acc.detect === 'off') return false;
    let target;
    let here;
    try { target = new URL(acc.resetUrl); here = new URL(href); } catch (e) { return false; }
    const host = (h) => String(h || '').toLowerCase().replace(/^www\./, '');
    if (!host(target.hostname) || host(target.hostname) !== host(here.hostname)) return false;
    if (acc.detect === 'page') {
      const path = (u) => decodeURIComponent(u.pathname).replace(/\/+$/, '').toLowerCase();
      return path(here) === path(target) || path(here).startsWith(`${path(target)}/`);
    }
    return true;
  }

  function pwDueInfo(acc) {
    if (!acc.lastChanged) return { status: 'unknown', daysLeft: null, due: null };
    const days = Number(acc.expiryDays);
    if (!days || days <= 0) return { status: 'none', daysLeft: null, due: null };
    const [y, m, d] = acc.lastChanged.split('-').map(Number);
    const due = new Date(y, m - 1, d + days);
    const t = new Date();
    const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const daysLeft = Math.round((due - today) / 86400000);
    const warn = Number(acc.warnDays ?? 14) || 0;
    const status = daysLeft < 0 ? 'overdue' : daysLeft === 0 ? 'today' : daysLeft <= warn ? 'soon' : 'ok';
    return { status, daysLeft, due };
  }

  // ----- 1. Background service worker -----
  function snBackground() {
    const DETECTOR_ID = 'sn-pw-reset-detector';
    const ALL_SITES = ['<all_urls>'];
    const hasAccess = async () => { try { return await chrome.permissions.contains({ origins: ALL_SITES }); } catch (e) { return false; } };
    const isRegistered = async () => { try { return (await chrome.scripting.getRegisteredContentScripts({ ids: [DETECTOR_ID] })).length > 0; } catch (e) { return false; } };
    const accessPageExists = async () => { try { return (await fetch(chrome.runtime.getURL('password-access.html'))).ok; } catch (e) { return false; } };

    // Keep the reset-page script registered exactly when detection is on and access to all sites is allowed
    async function sync() {
      const { pwDetect } = await chrome.storage.local.get('pwDetect');
      const access = await hasAccess();
      const want = !!(pwDetect && pwDetect.enabled) && access;
      const registered = await isRegistered();
      if (want && !registered) {
        await chrome.scripting.registerContentScripts([{
          id: DETECTOR_ID, matches: ['<all_urls>'], excludeMatches: ['https://wluk.service-now.com/*'],
          js: ['content.js'], runAt: 'document_idle', persistAcrossSessions: true
        }]);
      }
      if (!want && registered) await chrome.scripting.unregisterContentScripts({ ids: [DETECTOR_ID] });
      if (pwDetect && pwDetect.enabled && !access) await chrome.storage.local.set({ pwDetect: { enabled: false, at: Date.now(), reason: 'access-removed' } });
      return want;
    }

    async function status() {
      const { pwDetect } = await chrome.storage.local.get('pwDetect');
      return { enabled: !!(pwDetect && pwDetect.enabled), access: await hasAccess(), registered: await isRegistered(), pageAvailable: await accessPageExists() };
    }

    chrome.runtime.onInstalled.addListener(() => { sync().catch(() => {}); });
    chrome.runtime.onStartup.addListener(() => { sync().catch(() => {}); });
    if (chrome.permissions && chrome.permissions.onRemoved) chrome.permissions.onRemoved.addListener(() => { sync().catch(() => {}); });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || sender.id !== chrome.runtime.id) return undefined;
      const run = (fn) => { fn().then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })); return true; };
      if (msg.type === 'pw-status') return run(status);
      if (msg.type === 'pw-open-access') {
        return run(async () => {
          if (!(await accessPageExists())) return { ok: false, error: 'missing-page' };
          await chrome.tabs.create({ url: chrome.runtime.getURL('password-access.html') });
          return { ok: true };
        });
      }
      if (msg.type === 'pw-enabled') {
        return run(async () => {
          await chrome.storage.local.set({ pwDetect: { enabled: true, at: Date.now() } });
          return { ok: await sync() };
        });
      }
      if (msg.type === 'pw-disable') {
        return run(async () => {
          await chrome.storage.local.set({ pwDetect: { enabled: false, at: Date.now() } });
          await sync();
          try { await chrome.permissions.remove({ origins: ALL_SITES }); } catch (e) { /* already gone */ }
          return { ok: true };
        });
      }
      return undefined;
    });
  }

  // ----- 2. Storage bridge for the hub (ISOLATED world, WLUK pages) -----
  // Only Password Expiry keys ("pw…") can be read or written through it.
  function snStorageBridge() {
    const allowed = (k) => typeof k === 'string' && /^pw[A-Z]/.test(k);
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const m = event.data;
      if (!m || m.__snsimp !== 'req' || typeof m.id !== 'string') return;
      const reply = (payload) => window.postMessage(Object.assign({ __snsimp: 'res', id: m.id }, payload), location.origin);
      (async () => {
        try {
          if (m.op === 'get') {
            reply({ ok: true, data: await chrome.storage.local.get((m.keys || []).filter(allowed)) });
          } else if (m.op === 'set') {
            const items = {};
            Object.keys(m.items || {}).filter(allowed).forEach((k) => { items[k] = m.items[k]; });
            await chrome.storage.local.set(items);
            reply({ ok: true });
          } else if (m.op === 'pw-status' || m.op === 'pw-open-access' || m.op === 'pw-disable') {
            reply({ ok: true, data: await chrome.runtime.sendMessage({ type: m.op }) });
          } else {
            reply({ ok: false, error: 'unknown-op' });
          }
        } catch (e) {
          reply({ ok: false, error: String((e && e.message) || e) });
        }
      })();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const keys = Object.keys(changes).filter(allowed);
      if (keys.length) window.postMessage({ __snsimp: 'changed', keys }, location.origin);
    });
  }

  // ----- 3. Reset-page bar (ISOLATED world, any site, only while detection is on) -----
  function snResetDetector() {
    const STATE_KEY = 'sn-simplifier-pw-bar';
    let host = null;
    let lastHref = '';
    let confirmingUntil = 0; // keep the "Updated" message up for a moment

    const tabState = () => { try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}'); } catch (e) { return {}; } };
    const saveTabState = (st) => { try { sessionStorage.setItem(STATE_KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } };
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function remove() { if (host) { host.remove(); host = null; } }

    async function check() {
      lastHref = location.href;
      if (Date.now() < confirmingUntil) return;
      let data;
      try { data = await chrome.storage.local.get(['pwAccounts', 'pwDetect']); } catch (e) { remove(); return; }
      if (!data.pwDetect || !data.pwDetect.enabled) { remove(); return; }
      const st = tabState();
      const today = pwToday();
      const matches = (data.pwAccounts || []).filter((a) => pwUrlMatches(a, location.href) && !(st.done || []).includes(a.id) && a.lastChanged !== today);
      if (!matches.length || st.hidden) { remove(); return; }
      render(matches, st.pill ? 'pill' : 'bar');
    }

    async function markReset(ids) {
      const { pwAccounts } = await chrome.storage.local.get('pwAccounts');
      const list = Array.isArray(pwAccounts) ? pwAccounts : [];
      const today = pwToday();
      const names = [];
      list.forEach((a) => {
        if (!ids.includes(a.id)) return;
        a.lastChanged = today;
        a.history = [{ date: today, how: 'detected' }, ...(a.history || [])].slice(0, 20);
        a.updatedAt = Date.now();
        const due = pwDueInfo(a);
        names.push(`${a.name}${due.due ? ` (next change due ${due.due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})` : ''}`);
      });
      await chrome.storage.local.set({ pwAccounts: list });
      const st = tabState();
      st.done = [...new Set([...(st.done || []), ...ids])];
      saveTabState(st);
      return names;
    }

    function render(accounts, mode) {
      if (!host) {
        host = document.createElement('div');
        host.setAttribute('data-sn-simplifier', 'pw-bar');
        host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
        host.attachShadow({ mode: 'open' });
        (document.body || document.documentElement).appendChild(host);
      }
      const root = host.shadowRoot;
      const who = (a) => `<strong>${esc(a.name)}</strong>${a.username ? ` <span class="u">(${esc(a.username)})</span>` : ''}`;
      const css = `
        * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
        .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); width: min(720px, calc(100vw - 24px)); background: #0f172a; color: #e2e8f0;
          border: 1px solid #334155; border-left: 4px solid #f59e0b; border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.45); padding: 12px 14px; font-size: 14px; line-height: 1.4; }
        .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .msg { flex: 1; min-width: 220px; }
        .u { color: #94a3b8; font-weight: 400; }
        .sub { color: #94a3b8; font-size: 12px; margin-top: 2px; }
        .acc { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-top: 1px solid #1e293b; }
        button { font: inherit; font-size: 13px; border-radius: 6px; padding: 6px 12px; cursor: pointer; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; }
        button.yes { background: #16a34a; border-color: #16a34a; color: #fff; font-weight: 600; }
        button.x { background: transparent; border: none; color: #94a3b8; font-size: 18px; padding: 2px 6px; }
        .done { border-left-color: #22c55e; }
        .pill { position: fixed; right: 16px; bottom: 16px; background: #0f172a; color: #fde68a; border: 1px solid #f59e0b; border-radius: 999px;
          padding: 8px 14px; font-size: 13px; font-weight: 600; box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: pointer; }`;
      if (mode === 'pill') {
        root.innerHTML = `<style>${css}</style><button class="pill" data-a="expand" title="SNOW Simplifier: did you reset a password here?">🔑 Password reset done?</button>`;
      } else if (accounts.length === 1) {
        const a = accounts[0];
        root.innerHTML = `<style>${css}</style><div class="bar" role="dialog" aria-label="Password reset detected"><div class="row">
          <span style="font-size:18px">🔑</span>
          <div class="msg">Password reset page for ${who(a)}. Did you reset its password?<div class="sub">SNOW Simplifier · Yes records today as the date it was last changed.</div></div>
          <button class="yes" data-a="yes" data-id="${esc(a.id)}">Yes, I reset it</button>
          <button data-a="later">Not yet</button>
          <button class="x" data-a="hide" title="Don't ask again on this tab">×</button>
        </div></div>`;
      } else {
        root.innerHTML = `<style>${css}</style><div class="bar" role="dialog" aria-label="Password reset detected"><div class="row">
          <span style="font-size:18px">🔑</span>
          <div class="msg">Password reset page for ${accounts.length} of your accounts. Which did you reset?<div class="sub">SNOW Simplifier · Yes records today as the date it was last changed.</div></div>
          <button data-a="later">Not yet</button>
          <button class="x" data-a="hide" title="Don't ask again on this tab">×</button>
        </div>
        ${accounts.map((a) => `<div class="acc"><span>${who(a)}</span><button class="yes" data-a="yes" data-id="${esc(a.id)}">Yes, I reset it</button></div>`).join('')}</div>`;
      }
      root.querySelectorAll('[data-a]').forEach((btn) => btn.addEventListener('click', async () => {
        const action = btn.getAttribute('data-a');
        const st = tabState();
        if (action === 'expand') { st.pill = false; saveTabState(st); check(); return; }
        if (action === 'later') { st.pill = true; saveTabState(st); check(); return; }
        if (action === 'hide') { st.hidden = true; saveTabState(st); remove(); return; }
        if (action === 'yes') {
          btn.disabled = true;
          if (accounts.length === 1) confirmingUntil = Date.now() + 5000; // the save below triggers a re-check
          let names;
          try { names = await markReset([btn.getAttribute('data-id')]); } catch (e) { confirmingUntil = 0; btn.disabled = false; return; }
          const bar = root.querySelector('.bar');
          if (bar && accounts.length === 1) {
            confirmingUntil = Date.now() + 5000;
            bar.classList.add('done');
            bar.innerHTML = `<div class="row"><span style="font-size:18px">✅</span><div class="msg">Updated: ${esc(names.join(', '))}.<div class="sub">SNOW Simplifier</div></div></div>`;
            setTimeout(() => { confirmingUntil = 0; check(); }, 5000);
          } else {
            check();
          }
        }
      }));
    }

    check();
    setInterval(() => { if (location.href !== lastHref) check(); }, 1500);
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && (changes.pwAccounts || changes.pwDetect)) check();
      });
    } catch (e) { /* extension reloaded */ }
  }

  if (window.top !== window.self) return;

  // Version & GitHub Auto-Check Config
  const FALLBACK_VERSION = '1.1.1'; // Only used if the manifest version can't be read
  const GITHUB_API_MANIFEST_URL = 'https://api.github.com/repos/iMxAndyy/SNOW-Simplifier/contents/manifest.json?ref=main';
  const GITHUB_RAW_MANIFEST_URL = 'https://raw.githubusercontent.com/iMxAndyy/SNOW-Simplifier/main/manifest.json';

  const DEFAULT_GROUP = 'UK.RailOps.Level2.Darl.Worldline';
  const POLL_INTERVAL_MS = 30000; // 30 seconds
  const UPDATE_CHECK_INTERVAL_MS = 1800000; // 30 minutes

  // Current active view ('hub', 'new_queue', 'cases', or 'changes')
  let currentView = localStorage.getItem('sn_helper_view') || 'hub';

  // --- GLOBAL & NEW TICKET QUEUE STATE ---
  let allTickets = [];
  let unassignedQueueCS = [];
  let userMemberGroups = [];
  let knownGlobalUnassignedCS = new Set();
  let isFirstLoad = true;
  let notificationGroup = localStorage.getItem('sn_helper_notif_group') || DEFAULT_GROUP;
  let latestAvailableVersion = null;

  // --- CASE MANAGEMENT STATE ---
  let selectedGroup = localStorage.getItem('sn_helper_group') || DEFAULT_GROUP;
  let selectedType = localStorage.getItem('sn_helper_case_type') || 'ALL';
  let selectedUser = localStorage.getItem('sn_helper_user') || 'ALL';
  let savedStatesRaw = localStorage.getItem('sn_helper_states');
  let selectedStates = savedStatesRaw ? JSON.parse(savedStatesRaw) : null;

  // --- CHANGE MANAGEMENT & TASK VIEWER STATE ---
  let allChanges = [];
  let myUpcomingChanges = [];
  let isFirstChangeLoad = true;
  let notifiedChangeStart = new Set(JSON.parse(sessionStorage.getItem('sn_notified_chg_start') || '[]'));
  let notifiedChangeEnd = new Set(JSON.parse(sessionStorage.getItem('sn_notified_chg_end') || '[]'));

  let chgSelectedGroup = localStorage.getItem('sn_helper_chg_group') || DEFAULT_GROUP;
  let chgSelectedAssigned = localStorage.getItem('sn_helper_chg_assigned') || 'ALL';
  let chgSelectedRequested = localStorage.getItem('sn_helper_chg_requested') || 'ALL';
  let savedChgApprovalsRaw = localStorage.getItem('sn_helper_chg_approvals');
  let chgSelectedApprovals = savedChgApprovalsRaw ? JSON.parse(savedChgApprovalsRaw) : null;
  // States are stored as an exclusion list so newly seen states show up by default
  let chgExcludedStates = [];
  try {
    chgExcludedStates = JSON.parse(localStorage.getItem('sn_helper_chg_states_excluded') || '[]');
    if (!Array.isArray(chgExcludedStates)) chgExcludedStates = [];
  } catch (e) {
    chgExcludedStates = [];
  }
  let chgKnownStates = [];

  // --- CURRENT USER IDENTITY ---
  let cachedUserId = localStorage.getItem('sn_helper_user_sys_id') || null;
  let cachedUserName = localStorage.getItem('sn_helper_user_full_name') || null;
  
  // --- PERSONAL LINKS STATE (SAVED PER USER IN LOCALSTORAGE) ---
  let userLinks = JSON.parse(localStorage.getItem('sn_helper_user_links') || '[]');
  let selectedLinkCategory = 'ALL';
  let linkSearchQuery = '';
  let editingLinkId = null;

  function saveNotifiedChangeSets() {
    try {
      sessionStorage.setItem('sn_notified_chg_start', JSON.stringify(Array.from(notifiedChangeStart)));
      sessionStorage.setItem('sn_notified_chg_end', JSON.stringify(Array.from(notifiedChangeEnd)));
    } catch (e) {}
  }

  function getLocalVersion() {
    // Set by the ISOLATED-world copy of this script from manifest.json (see top of file)
    const fromManifest = document.documentElement.getAttribute('data-sn-simplifier-version');
    if (fromManifest) return fromManifest.trim();
    return FALLBACK_VERSION;
  }

  function isNewerVersion(localVer, remoteVer) {
    const lParts = String(localVer).split('.').map(Number);
    const rParts = String(remoteVer).split('.').map(Number);
    for (let i = 0; i < Math.max(lParts.length, rParts.length); i++) {
      const l = lParts[i] || 0;
      const r = rParts[i] || 0;
      if (r > l) return true;
      if (r < l) return false;
    }
    return false;
  }

  async function checkForExtensionUpdate() {
    const localVer = getLocalVersion();

    try {
      let remoteManifest = null;

      // 1. Try GitHub API first (Bypasses the 5-minute raw CDN cache completely)
      try {
        const apiRes = await fetch(`${GITHUB_API_MANIFEST_URL}&_=${Date.now()}`, {
          headers: { 'Accept': 'application/vnd.github.v3+json' },
          cache: 'no-store'
        });
        if (apiRes.ok) {
          const apiData = await apiRes.json();
          if (apiData && apiData.content) {
            const decoded = atob(apiData.content.replace(/\s/g, ''));
            remoteManifest = JSON.parse(decoded);
          }
        }
      } catch (apiErr) {
        // Fallback to raw URL silently if API fails
      }

      // 2. Fallback to Raw URL if API rate-limited or blocked
      if (!remoteManifest) {
        const rawRes = await fetch(`${GITHUB_RAW_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!rawRes.ok) return;
        remoteManifest = await rawRes.json();
      }

      const remoteVer = (remoteManifest.version || '').trim();

      if (remoteVer && isNewerVersion(localVer, remoteVer)) {
        latestAvailableVersion = remoteVer;
        const banner = document.getElementById('sn-update-banner');
        const bannerText = document.getElementById('sn-update-banner-text');
        const toggleBtn = document.getElementById('sn-helper-toggle');

        if (banner && bannerText) {
          bannerText.innerHTML = `🚀 <strong>Update Available (v${escapeHtml(remoteVer)})!</strong> You are currently on v${escapeHtml(localVer)}. Run <code>Update_Extension.bat</code> in your extension folder, then refresh ServiceNow.`;
          banner.classList.remove('sn-hidden');
        }
        if (toggleBtn && toggleBtn.innerText === 'Open Support Hub') {
          toggleBtn.innerText = 'Open Support Hub (Update Available!)';
        }
      }
    } catch (err) {
      // Silently ignore if GitHub repo hasn't been populated yet or blocked by network
    }
  }

  function getAuthToken() {
    return window.g_ck || window.NOW?.user_token || window.NOW?.g_ck || null;
  }

  function keepSessionAlive() {
    const token = getAuthToken();
    if (!token) return;

    fetch(`/xmlhttp.do?sysparm_processor=UserPreference&sysparm_type=get&sysparm_name=my_home_navigation_page&_=${Date.now()}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-UserToken': token
      }
    }).catch(() => {});

    try {
      const buttons = Array.from(document.querySelectorAll('button, now-button'));
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').toLowerCase();
        if (text.includes('keep working') || text.includes('extend session') || text.includes('stay logged in')) {
          btn.click();
        }
      }
    } catch (e) {}
  }

  function getCurrentUserId() {
    if (cachedUserId) return cachedUserId;
    const fromWindow =
      window.g_user?.userID ||
      window.NOW?.user?.userID ||
      window.NOW?.user?.sys_id ||
      window.NOW?.user_id ||
      null;
    if (fromWindow) {
      cachedUserId = fromWindow;
      localStorage.setItem('sn_helper_user_sys_id', cachedUserId);
    }
    return cachedUserId;
  }

  function getCurrentUserName() {
    if (cachedUserName) return cachedUserName;
    const fromWindow =
      window.g_user?.getFullName?.() ||
      window.NOW?.user?.displayName ||
      window.NOW?.user_display_name ||
      null;
    if (fromWindow) {
      cachedUserName = fromWindow;
      localStorage.setItem('sn_helper_user_full_name', cachedUserName);
    }
    return cachedUserName;
  }

  async function resolveCurrentUserId() {
    const existingId = getCurrentUserId();
    const existingName = getCurrentUserName();
    if (existingId && existingName) return existingId;

    const token = getAuthToken();
    if (!token) return existingId;

    try {
      const res = await fetch('/api/now/table/sys_user?sysparm_query=sys_id=javascript:gs.getUserID()&sysparm_fields=sys_id,name&sysparm_limit=1', {
        headers: { 'Accept': 'application/json', 'X-UserToken': token }
      });
      if (res.ok) {
        const data = (await res.json()).result || [];
        if (data.length > 0) {
          if (data[0].sys_id) {
            cachedUserId = data[0].sys_id;
            localStorage.setItem('sn_helper_user_sys_id', cachedUserId);
          }
          if (data[0].name) {
            cachedUserName = data[0].name;
            localStorage.setItem('sn_helper_user_full_name', cachedUserName);
          }
          return cachedUserId;
        }
      }
    } catch (err) {
      console.warn('Could not resolve user identity from API:', err);
    }
    return existingId;
  }

  function getVal(field) {
    if (!field) return '';
    if (typeof field === 'object') return (field.display_value || field.value || '').trim();
    return String(field).trim();
  }

  function getRawVal(field) {
    if (!field) return '';
    if (typeof field === 'object') return (field.value || field.display_value || '').trim();
    return String(field).trim();
  }

  function getFirstAvailable(record, fieldNames) {
    for (const f of fieldNames) {
      const val = getVal(record[f]);
      if (val) return val;
    }
    return '';
  }

  function parseSNDate(dateStr) {
    if (!dateStr) return null;
    const clean = String(dateStr).trim();
    if (!clean) return null;

    // Try standard ISO / YYYY-MM-DD HH:mm:ss
    const isoAttempt = new Date(clean.replace(' ', 'T'));
    if (!isNaN(isoAttempt.getTime())) return isoAttempt;

    // Try UK format DD/MM/YYYY HH:mm:ss or DD-MM-YYYY HH:mm:ss
    const ukMatch = clean.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (ukMatch) {
      const [, day, month, year, hours = '00', mins = '00', secs = '00'] = ukMatch;
      const parsed = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(mins), Number(secs));
      if (!isNaN(parsed.getTime())) return parsed;
    }

    const fallback = new Date(clean);
    return isNaN(fallback.getTime()) ? null : fallback;
  }

  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {
      console.warn('Audio play blocked until user interacts.');
    }
  }

  function jumpToNewTicketQueue() {
    const overlay = document.getElementById('sn-helper-overlay');
    const toggleBtn = document.getElementById('sn-helper-toggle');
    if (overlay && overlay.classList.contains('sn-hidden')) {
      overlay.classList.remove('sn-hidden');
      if (toggleBtn) toggleBtn.innerText = 'Hide Support Hub';
    }
    switchView('new_queue');
  }

  function showInPageToast(ticket) {
    const container = document.getElementById('sn-toast-container');
    if (!container) return;

    const prefix = getTicketPrefix(ticket.number);
    const typeLabel = prefix === 'INC' ? 'Incident' : 'CS Case';

    const toast = document.createElement('div');
    toast.className = 'sn-toast';
    toast.innerHTML = `
      <div class="sn-toast-header">
        <span>🚨 New Unassigned ${typeLabel}</span>
        <button class="sn-toast-close" title="Dismiss">&times;</button>
      </div>
      <div class="sn-toast-title">${escapeHtml(ticket.number)} • Priority: ${escapeHtml(ticket.priority || '—')}</div>
      <div class="sn-toast-desc">${escapeHtml(ticket.short_description || 'No description')}</div>
      <div class="sn-toast-cta">Click to open New Ticket Queue →</div>
    `;

    toast.querySelector('.sn-toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      toast.remove();
    });

    toast.addEventListener('click', () => {
      jumpToNewTicketQueue();
      toast.remove();
    });

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 15000);
  }

  function sendNotification(ticket) {
    playNotificationSound();
    showInPageToast(ticket);

    if (Notification.permission === 'granted') {
      const prefix = getTicketPrefix(ticket.number);
      const typeLabel = prefix === 'INC' ? 'Incident' : 'CS Case';
      const n = new Notification(`New Unassigned ${typeLabel}: ${ticket.number}`, {
        body: `${ticket.short_description}\nPriority: ${ticket.priority} | Click to open New Ticket Queue`,
        tag: ticket.number
      });
      n.onclick = () => {
        window.focus();
        jumpToNewTicketQueue();
        n.close();
      };
    }
  }

  function sendChangeWindowNotification(changeRecord, eventType) {
    playNotificationSound();

    const sysId = getRawVal(changeRecord.sys_id) || getVal(changeRecord.sys_id);
    const number = getVal(changeRecord.number);
    const shortDesc = getVal(changeRecord.short_description) || 'No description provided';
    const startDisp = getVal(changeRecord.start_date) || 'Now';
    const endDisp = getVal(changeRecord.end_date) || '—';

    const isStart = eventType === 'START';
    const headerTitle = isStart ? '🟢 Change Window Started' : '⚠️ Change Window Ended — Review/Close';
    const borderColor = isStart ? '#22c55e' : '#f59e0b';
    const subInfo = isStart
      ? `Scheduled: ${startDisp} → ${endDisp}`
      : `Window ended (${endDisp}). Please progress from Implement to Review/Close.`;

    const container = document.getElementById('sn-toast-container');
    if (container) {
      const toast = document.createElement('div');
      toast.className = 'sn-toast';
      toast.style.borderLeftColor = borderColor;
      toast.innerHTML = `
        <div class="sn-toast-header">
          <span>${headerTitle}</span>
          <button class="sn-toast-close" title="Dismiss">&times;</button>
        </div>
        <div class="sn-toast-title">${escapeHtml(number)}</div>
        <div class="sn-toast-desc">${escapeHtml(shortDesc)}<br><span style="font-size:11px; color:#cbd5e1;">${escapeHtml(subInfo)}</span></div>
        <div class="sn-toast-cta">Click to view Change Request →</div>
      `;

      toast.querySelector('.sn-toast-close').addEventListener('click', (e) => {
        e.stopPropagation();
        toast.remove();
      });

      toast.addEventListener('click', () => {
        const overlay = document.getElementById('sn-helper-overlay');
        const toggleBtn = document.getElementById('sn-helper-toggle');
        if (overlay && overlay.classList.contains('sn-hidden')) {
          overlay.classList.remove('sn-hidden');
          if (toggleBtn) toggleBtn.innerText = 'Hide Support Hub';
        }
        switchView('hub');
        if (sysId) openTicketPreview(sysId, 'CHG');
        toast.remove();
      });

      container.appendChild(toast);
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, 20000);
    }

    if (Notification.permission === 'granted') {
      const n = new Notification(`${headerTitle}: ${number}`, {
        body: `${shortDesc}\n${subInfo}`,
        tag: `${number}_${eventType}`
      });
      n.onclick = () => {
        window.focus();
        const overlay = document.getElementById('sn-helper-overlay');
        const toggleBtn = document.getElementById('sn-helper-toggle');
        if (overlay && overlay.classList.contains('sn-hidden')) {
          overlay.classList.remove('sn-hidden');
          if (toggleBtn) toggleBtn.innerText = 'Hide Support Hub';
        }
        switchView('hub');
        if (sysId) openTicketPreview(sysId, 'CHG');
        n.close();
      };
    }
  }

  async function fetchUserGroups() {
    const token = getAuthToken();
    const userId = await resolveCurrentUserId();
    if (!token || !userId) return;

    try {
      const res = await fetch(`/api/now/table/sys_user_grmember?sysparm_query=user=${userId}&sysparm_display_value=true&sysparm_fields=group`, {
        headers: { 'Accept': 'application/json', 'X-UserToken': token }
      });
      if (res.ok) {
        const data = (await res.json()).result || [];
        userMemberGroups = data.map(item => item.group?.display_value).filter(Boolean);
        
        if (!notificationGroup) {
          notificationGroup = userMemberGroups.length > 0 ? userMemberGroups[0] : DEFAULT_GROUP;
          localStorage.setItem('sn_helper_notif_group', notificationGroup);
        }
        updateNotificationGroupDropdowns();
        updateAlertsButtonState();
      }
    } catch (err) {
      console.warn('Could not auto-fetch user groups, using fallback.', err);
      if (!notificationGroup) notificationGroup = DEFAULT_GROUP;
      updateAlertsButtonState();
    }
  }

  function updateNotificationGroupDropdowns() {
    const allKnownGroups = new Set([DEFAULT_GROUP, ...userMemberGroups]);
    if (notificationGroup) allKnownGroups.add(notificationGroup);
    allTickets.forEach(t => {
      if (t.assignment_group?.display_value) allKnownGroups.add(t.assignment_group.display_value);
    });

    const sorted = Array.from(allKnownGroups).sort((a, b) => a.localeCompare(b));
    const optionsHtml = sorted.map(g => `
      <option value="${escapeHtml(g)}" ${notificationGroup === g ? 'selected' : ''}>${escapeHtml(g)}</option>
    `).join('');

    const modalSelect = document.getElementById('sn-modal-notif-group-select');
    const newQueueSelect = document.getElementById('sn-newq-group-select');
    if (modalSelect) modalSelect.innerHTML = optionsHtml;
    if (newQueueSelect) newQueueSelect.innerHTML = optionsHtml;
  }

  function updateAlertsButtonState() {
    const hubNotifBtn = document.getElementById('sn-hub-notif-btn');
    const newqNotifBtn = document.getElementById('sn-newq-notif-btn');
    const notifDot = document.getElementById('sn-hub-alert-dot');
    const notifSub = document.getElementById('sn-hub-alert-sub');
    const targetGroup = notificationGroup || DEFAULT_GROUP;

    const isGranted = Notification.permission === 'granted';

    if (hubNotifBtn) {
      hubNotifBtn.innerText = isGranted ? 'Manage Alerts' : 'Enable Alerts';
      hubNotifBtn.classList.toggle('secondary', isGranted);
    }
    if (newqNotifBtn) {
      newqNotifBtn.innerText = isGranted ? 'Manage Alerts' : 'Enable Alerts';
      newqNotifBtn.style.background = isGranted ? '#334155' : '#2563eb';
    }
    if (notifDot) {
      notifDot.classList.toggle('disabled', !isGranted);
    }
    if (notifSub) {
      notifSub.innerText = isGranted
        ? `Monitoring CS & INC: ${targetGroup}`
        : 'Desktop alerts disabled (In-page pop-ups active)';
    }
  }

  function switchView(targetView) {
    currentView = targetView;
    localStorage.setItem('sn_helper_view', currentView);

    const views = {
      hub: document.getElementById('sn-view-hub'),
      new_queue: document.getElementById('sn-view-new-queue'),
      cases: document.getElementById('sn-view-cases'),
      changes: document.getElementById('sn-view-changes'),
      links: document.getElementById('sn-view-links'),
      mine: document.getElementById('sn-view-mine'),
      bugs: document.getElementById('sn-view-bugs'),
      passwords: document.getElementById('sn-view-passwords')
    };

    // Fall back to the hub if a saved view no longer exists (e.g. the removed Notes / To-Do pages)
    if (!views[currentView]) {
      currentView = 'hub';
      localStorage.setItem('sn_helper_view', currentView);
    }

    Object.keys(views).forEach(k => {
      if (views[k]) views[k].classList.toggle('sn-view-hidden', k !== currentView);
    });

    if (currentView === 'links') {
      renderUserLinks();
    }
    if (currentView === 'mine') {
      renderMineTable();
      fetchMyTickets();
    }
    if (currentView === 'bugs') {
      renderBugs();
      refreshLiveTicketStates();
    }
    if (currentView === 'passwords') {
      renderPasswords();
      loadPwData().then(() => refreshPwStatus());
    }
  }

  function buildUI() {
    const localVer = getLocalVersion();

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'sn-helper-toggle';
    toggleBtn.innerText = 'Open Support Hub';
    document.body.appendChild(toggleBtn);

    const toastContainer = document.createElement('div');
    toastContainer.id = 'sn-toast-container';
    document.body.appendChild(toastContainer);

    const overlay = document.createElement('div');
    overlay.id = 'sn-helper-overlay';
    overlay.className = 'sn-hidden';
    
    overlay.innerHTML = `
      <!-- UPDATE AVAILABLE BANNER -->
      <div id="sn-update-banner" class="sn-update-banner sn-hidden">
        <span id="sn-update-banner-text"></span>
        <button id="sn-update-dismiss" class="sn-update-dismiss">Dismiss</button>
      </div>

      <!-- 1. HUB LANDING VIEW -->
      <div id="sn-view-hub" class="sn-view-section">
        <!-- LEFT/CENTER MAIN WORKSPACE (Auto-centers in remaining space) -->
        <div class="sn-hub-main-area">
          <div class="sn-hub-wrapper" id="sn-hub-wrapper">
            <div class="sn-hub-hero">
              <h1>Support Hub <span style="font-size: 14px; font-weight: 500; color: #64748b; vertical-align: middle;">v${localVer}</span></h1>
              <p>Fast-access operational workspace for ServiceNow. Triage incoming unassigned tickets, search existing cases, or review change requests while background monitoring runs continuously.</p>
              
              <div class="sn-hub-search-wrap">
                <div class="sn-hub-search-box">
                  <input type="text" id="sn-hub-search-input" class="sn-hub-search-input" placeholder="Search ticket number (e.g., CS1234567, INC..., CHG...)" autocomplete="off" />
                  <button id="sn-hub-search-btn" class="sn-hub-search-btn">Search Ticket</button>
                </div>
                <div id="sn-hub-search-msg" class="sn-hub-search-msg"></div>
              </div>
            </div>

            <div class="sn-hub-grid">
              <div class="sn-hub-card" id="sn-go-new-queue">
                <div class="sn-hub-card-header">
                  <h3>New Ticket Queue</h3>
                  <span class="sn-hub-badge" id="sn-hub-unassigned-count">0 Unassigned</span>
                </div>
                <p>Dedicated triage queue for incoming unassigned CS cases and INC incidents. Clicking any new ticket alert brings you straight here without affecting your Case Management filters.</p>
                
                <div class="sn-hub-card-alert-box">
                  <div class="sn-hub-alert-title">
                    <span class="sn-hub-alert-dot" id="sn-hub-alert-dot"></span>
                    Background Alert Monitor
                  </div>
                  <div class="sn-hub-alert-sub" id="sn-hub-alert-sub">Checking status...</div>
                </div>

                <div class="sn-hub-card-actions">
                  <button class="sn-hub-card-btn" id="sn-hub-open-newq-btn">Open New Queue →</button>
                  <button class="sn-hub-card-btn secondary" id="sn-hub-notif-btn">Manage Alerts</button>
                </div>
              </div>

              <div class="sn-hub-card" id="sn-go-cases">
                <div class="sn-hub-card-header">
                  <h3>Case Management (CS & INC)</h3>
                </div>
                <p>Browse, filter, and review existing Customer Service (CS) and Incident (INC) tickets across assignment groups, states, and assigned team members.</p>
                <div class="sn-hub-card-actions">
                  <button class="sn-hub-card-btn">Open Case Management →</button>
                </div>
              </div>

              <div class="sn-hub-card" id="sn-go-changes">
                <div class="sn-hub-card-header">
                  <h3>Change Management (CHG)</h3>
                </div>
                <p>Review scheduled Change Requests (CHG), check CAB and approval statuses, see Normal vs. Standard changes, and filter by assignee or requester.</p>
                <div class="sn-hub-card-actions">
                  <button class="sn-hub-card-btn">Open Change Management →</button>
                </div>
              </div>
            </div>
			<div class="sn-hub-section-divider">Personal Workspace & Tools (Saved Locally)</div>
            <div class="sn-hub-tools-grid">
              <div class="sn-hub-tool-card" id="sn-go-mine">
                <div class="sn-hub-tool-top">
                  <h4 class="sn-hub-tool-title">🙋 Assigned to Me</h4>
                  <span class="sn-hub-badge" id="sn-hub-mine-count" style="background: #334155;">…</span>
                </div>
                <div class="sn-tile-preview" id="sn-hub-mine-preview">
                  <p class="sn-hub-tool-desc">Your open CS &amp; INC tickets, with notes, tasks, and known-bug links.</p>
                </div>
              </div>

              <div class="sn-hub-tool-card" id="sn-go-bugs">
                <div class="sn-hub-tool-top">
                  <h4 class="sn-hub-tool-title">🐞 Known Bugs</h4>
                  <span class="sn-hub-badge" id="sn-hub-bugs-count" style="background: #334155;">0 Active</span>
                </div>
                <div class="sn-tile-preview" id="sn-hub-bugs-preview">
                  <p class="sn-hub-tool-desc">Track recurring issues and see every ticket reporting the same bug.</p>
                </div>
              </div>

              <div class="sn-hub-tool-card" id="sn-go-passwords">
                <div class="sn-hub-tool-top">
                  <h4 class="sn-hub-tool-title">🔑 Password Expiry</h4>
                  <span class="sn-hub-badge" id="sn-hub-pw-count" style="background: #334155;">…</span>
                </div>
                <div class="sn-tile-preview" id="sn-hub-pw-preview">
                  <p class="sn-hub-tool-desc">Track when your account passwords were last changed and when they expire. No passwords are stored.</p>
                </div>
              </div>

              <div class="sn-hub-tool-card" id="sn-go-links">
                <div class="sn-hub-tool-top">
                  <h4 class="sn-hub-tool-title">🔗 Quick Links & Tools</h4>
                  <span class="sn-hub-badge" id="sn-hub-links-count" style="background: #334155;">0 Saved</span>
                </div>
                <p class="sn-hub-tool-desc">Save your personal bookmarks, internal dashboards, documentation, and local file/script paths with custom notes.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- FULL-HEIGHT RIGHT DOCKED SIDE PANEL (HIDDEN WHEN EMPTY) -->
        <aside id="sn-upcoming-changes-widget" class="sn-upcoming-widget sn-hidden">
          <div class="sn-upcoming-header">
            <div class="sn-upcoming-title-row">
              <h3 class="sn-upcoming-title">
                <span>📋 Change Task Viewer</span>
              </h3>
              <span class="sn-hub-badge" id="sn-upcoming-count-badge" style="background: #2563eb;">0</span>
            </div>
            <span class="sn-upcoming-sub" id="sn-upcoming-user-label"></span>
          </div>
          <div class="sn-upcoming-list" id="sn-upcoming-changes-list"></div>
        </aside>
      </div>

      <!-- 2. NEW TICKET QUEUE VIEW -->
      <div id="sn-view-new-queue" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-newq-back-btn">← Support Hub</button>
              <h1>New Ticket Queue (Unassigned CS & INC)</h1>
            </div>
            <div class="sn-status-bar" id="sn-newq-status-text">Monitoring for unassigned CS & INC tickets...</div>
          </div>
          <div class="sn-controls">
            <div class="sn-filter-group">
              <span class="sn-filter-label">Monitored Assignment Group</span>
              <select id="sn-newq-group-select" class="sn-select">
                <option value="${DEFAULT_GROUP}">${DEFAULT_GROUP}</option>
              </select>
            </div>

            <button class="sn-btn" id="sn-newq-refresh-btn">Refresh Now</button>
            <button class="sn-btn" id="sn-newq-notif-btn">Manage Alerts</button>
          </div>
        </div>

        <table class="sn-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Priority</th>
              <th>State</th>
              <th>Short Description</th>
              <th>Assignment Group</th>
              <th>Action</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody id="sn-newq-body">
            <tr><td colspan="7">Loading unassigned CS & INC queue...</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 3. CASE MANAGEMENT VIEW -->
      <div id="sn-view-cases" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-case-back-btn">← Support Hub</button>
              <h1>Case Management</h1>
            </div>
            <div class="sn-status-bar" id="sn-status-text">Connecting to ServiceNow API...</div>
          </div>
          <div class="sn-controls">
            <div class="sn-filter-group">
              <span class="sn-filter-label">Assignment Group</span>
              <select id="sn-group-select" class="sn-select">
                <option value="${DEFAULT_GROUP}">${DEFAULT_GROUP}</option>
              </select>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">Ticket Type</span>
              <select id="sn-type-select" class="sn-select" style="min-width: 140px;">
                <option value="ALL" ${selectedType === 'ALL' ? 'selected' : ''}>All (CS & INC)</option>
                <option value="CS" ${selectedType === 'CS' ? 'selected' : ''}>CS Only</option>
                <option value="INC" ${selectedType === 'INC' ? 'selected' : ''}>INC Only</option>
              </select>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">State Filter</span>
              <div class="sn-dropdown-container" id="sn-state-dropdown-container">
                <button class="sn-dropdown-btn" id="sn-state-drop-btn">Select States</button>
                <div class="sn-dropdown-content" id="sn-state-drop-content">
                  <div id="sn-state-checkboxes"></div>
                  <div class="sn-dropdown-actions">
                    <button class="sn-dropdown-action-link" id="sn-state-select-all">All</button>
                    <button class="sn-dropdown-action-link" id="sn-state-clear-all">Clear</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">Assigned To User</span>
              <select id="sn-user-select" class="sn-select">
                <option value="ALL">All Assigned Users</option>
              </select>
            </div>

            <button class="sn-btn" id="sn-refresh-btn">Refresh Now</button>
          </div>
        </div>

        <table class="sn-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Priority</th>
              <th>State</th>
              <th>Short Description</th>
              <th>Assignment Group</th>
              <th>Assigned To</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody id="sn-ticket-body">
            <tr><td colspan="7">Loading active queue from task table...</td></tr>
          </tbody>
        </table>
      </div>

      <!-- 4. CHANGE MANAGEMENT VIEW -->
      <div id="sn-view-changes" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-chg-back-btn">← Support Hub</button>
              <h1>Change Management</h1>
            </div>
            <div class="sn-status-bar" id="sn-chg-status-text">Connecting to ServiceNow API...</div>
          </div>
          <div class="sn-controls">
            <div class="sn-filter-group">
              <span class="sn-filter-label">Assignment Group</span>
              <select id="sn-chg-group-select" class="sn-select">
                <option value="${DEFAULT_GROUP}">${DEFAULT_GROUP}</option>
              </select>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">Approval Status</span>
              <div class="sn-dropdown-container" id="sn-chg-approval-dropdown-container">
                <button class="sn-dropdown-btn" id="sn-chg-approval-drop-btn">Select Approvals</button>
                <div class="sn-dropdown-content" id="sn-chg-approval-drop-content">
                  <div id="sn-chg-approval-checkboxes"></div>
                  <div class="sn-dropdown-actions">
                    <button class="sn-dropdown-action-link" id="sn-chg-approval-select-all">All</button>
                    <button class="sn-dropdown-action-link" id="sn-chg-approval-clear-all">Clear</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">State</span>
              <div class="sn-dropdown-container" id="sn-chg-state-dropdown-container">
                <button class="sn-dropdown-btn" id="sn-chg-state-drop-btn">All States</button>
                <div class="sn-dropdown-content" id="sn-chg-state-drop-content">
                  <div id="sn-chg-state-checkboxes"></div>
                  <div class="sn-dropdown-actions">
                    <button class="sn-dropdown-action-link" id="sn-chg-state-select-all">All</button>
                    <button class="sn-dropdown-action-link" id="sn-chg-state-active-only" title="Hide Closed and Cancelled changes">Active only</button>
                    <button class="sn-dropdown-action-link" id="sn-chg-state-clear-all">Clear</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">Assigned To</span>
              <select id="sn-chg-assigned-select" class="sn-select">
                <option value="ALL">All Assigned Users</option>
              </select>
            </div>

            <div class="sn-filter-group">
              <span class="sn-filter-label">Requested By</span>
              <select id="sn-chg-requested-select" class="sn-select">
                <option value="ALL">All Requesters</option>
              </select>
            </div>

            <button class="sn-btn" id="sn-chg-refresh-btn">Refresh Now</button>
          </div>
        </div>

        <table class="sn-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Type</th>
              <th>Approval</th>
              <th>State</th>
              <th>Short Description</th>
              <th>Scheduled Window</th>
              <th>Assigned To</th>
              <th>Requested By</th>
            </tr>
          </thead>
          <tbody id="sn-chg-body">
            <tr><td colspan="8">Loading change requests...</td></tr>
          </tbody>
        </table>
      </div>
	  <!-- 5. PERSONAL LINKS VIEW -->
      <div id="sn-view-links" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-links-back-btn">← Support Hub</button>
              <h1>Quick Links & Tools</h1>
            </div>
            <div class="sn-status-bar">Saved privately in your browser • Supports web URLs and local/network paths</div>
          </div>
        </div>

        <div class="sn-links-container">
          <!-- Top Action Bar (Add Button + Export/Import) -->
          <div class="sn-links-top-actions">
            <button class="sn-btn sn-btn-primary" id="sn-toggle-form-btn">➕ Add New Link or Tool</button>
            <div style="display: flex; gap: 8px;">
              <button class="sn-btn" id="sn-links-export-btn" style="background: #334155; font-size: 12px;">⬇ Export JSON</button>
              <button class="sn-btn" id="sn-links-import-btn" style="background: #334155; font-size: 12px;">⬆ Import JSON</button>
              <input type="file" id="sn-links-import-input" accept=".json" style="display: none;" />
            </div>
          </div>

          <!-- Collapsible Add/Edit Form Card (Hidden by default) -->
          <div class="sn-links-form-card sn-hidden" id="sn-links-form-card">
            <div class="sn-links-form-title">
              <span id="sn-links-form-heading">➕ Add New Link or Tool</span>
              <button id="sn-links-cancel-edit" class="sn-link-icon-btn" style="display: none;">Cancel Edit</button>
            </div>
            <div class="sn-links-form-grid">
              <input type="text" id="sn-link-name" class="sn-links-input" placeholder="Tool / Site Name (e.g., Darwin Web Portal) *" />
              <input type="text" id="sn-link-url" class="sn-links-input" placeholder="Primary / Prod URL or Local Path *" />
              <input type="text" id="sn-link-category" class="sn-links-input" placeholder="Category (e.g., Monitoring, Admin, Docs)" list="sn-link-cat-suggestions" />
              <datalist id="sn-link-cat-suggestions"></datalist>
              <datalist id="sn-env-label-suggestions"></datalist>
            </div>

            <div class="sn-alt-urls-section">
              <div class="sn-alt-urls-header">
                <span class="sn-alt-urls-label">🌐 Additional Environments / Sub-Paths (Optional — e.g., UAT, Sub-folder)</span>
                <button type="button" id="sn-add-alt-url-btn" class="sn-add-env-btn">+ Add Environment URL</button>
              </div>
              <div id="sn-alt-urls-rows" class="sn-alt-urls-rows"></div>
            </div>

            <div class="sn-links-form-bottom">
              <input type="text" id="sn-link-note" class="sn-links-input" placeholder="Optional note or instructions (e.g., Use domain credentials, VPN required...)" />
              <button class="sn-btn sn-btn-primary" id="sn-link-save-btn" style="white-space: nowrap; padding: 9px 20px;">Save Link</button>
            </div>
          </div>

          <!-- Toolbar (Categories & Search) -->
          <div class="sn-links-toolbar">
            <div class="sn-links-categories" id="sn-links-categories-bar"></div>
            <input type="text" id="sn-links-search" class="sn-links-input" style="max-width: 280px;" placeholder="🔍 Filter links by name or note..." />
          </div>

          <!-- Dynamic Multi-Column Grid -->
          <div class="sn-links-grid" id="sn-links-grid"></div>
        </div>
      </div>

      <!-- 6. ASSIGNED TO ME VIEW -->
      <div id="sn-view-mine" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-mine-back-btn">← Support Hub</button>
              <h1>Assigned to Me</h1>
            </div>
            <div class="sn-status-bar" id="sn-mine-status-text">Loading your tickets...</div>
          </div>
          <div class="sn-controls">
            <div class="sn-filter-group">
              <span class="sn-filter-label">Ticket Type</span>
              <select id="sn-mine-type" class="sn-select" style="min-width: 140px;">
                <option value="ALL">All (CS & INC)</option>
                <option value="CS">CS Only</option>
                <option value="INC">INC Only</option>
              </select>
            </div>
            <div class="sn-filter-group">
              <span class="sn-filter-label">Known Bug</span>
              <select id="sn-mine-bug" class="sn-select"></select>
            </div>
            <div class="sn-filter-group">
              <span class="sn-filter-label">Search</span>
              <input type="text" id="sn-mine-search" class="sn-links-input sn-mine-search" placeholder="Number or description..." autocomplete="off" />
            </div>
            <button class="sn-btn sn-toggle-btn" id="sn-mine-open-sort-btn" title="Show tickets in an open state first, longest-waiting at the top (time since the ticket last entered an open state, from its state history)">⏱ Open first</button>
            <button class="sn-btn" id="sn-mine-refresh-btn">Refresh Now</button>
            <button class="sn-btn" id="sn-mine-bugs-btn">🐞 Manage Known Bugs</button>
          </div>
        </div>

        <div class="sn-mine-note" id="sn-mine-note" style="display: none;"></div>
        <table class="sn-table sn-mine-table">
          <thead>
            <tr>
              <th>Number</th>
              <th>Priority</th>
              <th>State</th>
              <th>Short Description</th>
              <th>Known Bug</th>
              <th>Notes &amp; Tasks</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody id="sn-mine-body">
            <tr><td colspan="7">Loading your tickets...</td></tr>
          </tbody>
        </table>
        <div id="sn-mine-other" class="sn-mine-other"></div>
      </div>

      <!-- 7. KNOWN BUGS VIEW -->
      <div id="sn-view-bugs" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-bugs-back-btn">← Support Hub</button>
              <h1>Known Bugs</h1>
            </div>
            <div class="sn-status-bar">Saved privately in your browser • Link tickets to a bug from the Assigned to Me page</div>
          </div>
        </div>

        <div class="sn-links-container">
          <div class="sn-links-top-actions">
            <button class="sn-btn sn-btn-primary" id="sn-bug-toggle-form-btn" style="margin-top: 0;">➕ New Known Bug</button>
            <div class="sn-links-categories" id="sn-bug-filter"></div>
            <div class="sn-bug-toolbar-right">
              <input type="text" id="sn-bug-search" class="sn-links-input" style="max-width: 220px;" placeholder="🔍 Filter bugs or tickets..." autocomplete="off" />
              <button class="sn-btn" id="sn-bugs-export-btn" style="margin-top: 0; background: #334155; font-size: 12px;">⬇ Export</button>
              <button class="sn-btn" id="sn-bugs-import-btn" style="margin-top: 0; background: #334155; font-size: 12px;">⬆ Import</button>
              <input type="file" id="sn-bugs-import-input" accept=".json" style="display: none;" />
            </div>
          </div>

          <div class="sn-links-form-card sn-hidden" id="sn-bug-form-card">
            <div class="sn-links-form-title">
              <span id="sn-bug-form-heading">🐞 New Known Bug</span>
            </div>
            <div class="sn-form-grid sn-bug-form-grid">
              <label class="sn-form-field sn-span-2">
                <span>Bug title *</span>
                <input type="text" id="sn-bug-title" class="sn-links-input" placeholder="e.g. Darwin feed delays after 02:00 restart" autocomplete="off" />
              </label>
              <label class="sn-form-field">
                <span>Reference</span>
                <input type="text" id="sn-bug-ref" class="sn-links-input" placeholder="e.g. PRB0012345, JIRA-123" autocomplete="off" />
              </label>
              <label class="sn-form-field">
                <span>Status</span>
                <select id="sn-bug-status" class="sn-links-input">
                  <option value="open">Open</option>
                  <option value="fixing">Fix in progress</option>
                  <option value="resolved">Resolved</option>
                </select>
              </label>
              <label class="sn-form-field sn-span-full">
                <span>Description / symptoms</span>
                <textarea id="sn-bug-desc" class="sn-links-input" rows="3" placeholder="What do customers report? How do you recognise it?"></textarea>
              </label>
              <label class="sn-form-field sn-span-full">
                <span>Workaround</span>
                <textarea id="sn-bug-workaround" class="sn-links-input" rows="2" placeholder="Any known workaround or standard response"></textarea>
              </label>
            </div>
            <div class="sn-form-actions">
              <button class="sn-link-icon-btn" id="sn-bug-cancel-btn" style="padding: 8px 14px; font-size: 12px;">Cancel</button>
              <button class="sn-btn sn-btn-primary" id="sn-bug-save-btn" style="margin-top: 0; padding: 9px 20px;">Save Bug</button>
            </div>
          </div>

          <div class="sn-bug-list" id="sn-bug-list"></div>
        </div>
      </div>

      <!-- 8. PASSWORD EXPIRY VIEW -->
      <div id="sn-view-passwords" class="sn-view-section sn-view-hidden">
        <div class="sn-header">
          <div class="sn-title-area">
            <div class="sn-title-row">
              <button class="sn-back-hub-btn" id="sn-pw-back-btn">← Support Hub</button>
              <h1>Password Expiry</h1>
            </div>
            <div class="sn-status-bar">No passwords are ever stored: just when each was last changed, when it expires and how to reset it</div>
          </div>
        </div>

        <div class="sn-links-container">
          <div class="sn-pw-detect" id="sn-pw-detect"></div>

          <div class="sn-links-top-actions">
            <button class="sn-btn sn-btn-primary" id="sn-pw-toggle-form-btn" style="margin-top: 0;">➕ Add account</button>
            <div class="sn-links-categories" id="sn-pw-filter"></div>
            <div class="sn-bug-toolbar-right">
              <input type="text" id="sn-pw-search" class="sn-links-input" style="max-width: 220px;" placeholder="🔍 Filter accounts..." autocomplete="off" />
              <button class="sn-btn" id="sn-pw-export-btn" style="margin-top: 0; background: #334155; font-size: 12px;">⬇ Export</button>
              <button class="sn-btn" id="sn-pw-import-btn" style="margin-top: 0; background: #334155; font-size: 12px;">⬆ Import</button>
              <input type="file" id="sn-pw-import-input" accept=".json" style="display: none;" />
            </div>
          </div>

          <div class="sn-links-form-card sn-hidden" id="sn-pw-form-card">
            <div class="sn-links-form-title">
              <span id="sn-pw-form-heading">🔑 Add account</span>
            </div>
            <div class="sn-form-grid sn-bug-form-grid">
              <label class="sn-form-field sn-span-2">
                <span>Account name *</span>
                <input type="text" id="sn-pw-name" class="sn-links-input" placeholder="e.g. Darwin admin (PROD)" autocomplete="off" />
              </label>
              <label class="sn-form-field">
                <span>System / website</span>
                <input type="text" id="sn-pw-system" class="sn-links-input" placeholder="e.g. Darwin, AD, VPN" autocomplete="off" />
              </label>
              <label class="sn-form-field">
                <span>Username (optional)</span>
                <input type="text" id="sn-pw-username" class="sn-links-input" placeholder="Never the password" autocomplete="off" />
              </label>
              <label class="sn-form-field">
                <span>Password last changed</span>
                <input type="date" id="sn-pw-last" class="sn-links-input" />
              </label>
              <label class="sn-form-field">
                <span>Expires every (days)</span>
                <input type="number" id="sn-pw-expiry" class="sn-links-input" min="1" placeholder="Blank = never" />
              </label>
              <label class="sn-form-field">
                <span>Warn me (days before)</span>
                <input type="number" id="sn-pw-warn" class="sn-links-input" min="0" />
              </label>
              <label class="sn-form-field sn-span-2">
                <span>Reset page link</span>
                <input type="url" id="sn-pw-url" class="sn-links-input" placeholder="https://…" autocomplete="off" />
              </label>
              <label class="sn-form-field">
                <span>Spot visits to the reset page</span>
                <select id="sn-pw-detect-mode" class="sn-links-input">
                  <option value="site">Anywhere on that website</option>
                  <option value="page">That page only</option>
                  <option value="off">Don't spot it</option>
                </select>
              </label>
              <label class="sn-form-field sn-span-full">
                <span>How to reset it (steps)</span>
                <textarea id="sn-pw-steps" class="sn-links-input" rows="3" placeholder="e.g. Log in to the jump box, press Ctrl+Alt+End, Change a password…"></textarea>
              </label>
            </div>
            <div class="sn-pw-form-note">Don't enter passwords here. Only the details above are saved, in this browser's extension storage.</div>
            <div class="sn-form-actions">
              <button class="sn-link-icon-btn" id="sn-pw-cancel-btn" style="padding: 8px 14px; font-size: 12px;">Cancel</button>
              <button class="sn-btn sn-btn-primary" id="sn-pw-save-btn" style="margin-top: 0; padding: 9px 20px;">Save account</button>
            </div>
          </div>

          <div class="sn-bug-list" id="sn-pw-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const previewModal = document.createElement('div');
    previewModal.id = 'sn-preview-modal';
    previewModal.innerHTML = `
      <div class="sn-preview-card">
        <div class="sn-preview-header">
          <div class="sn-preview-title">
            <span class="sn-type-badge" id="sn-modal-prefix">CS</span>
            <h2 id="sn-modal-number">Loading...</h2>
          </div>
          <button class="sn-preview-close" id="sn-modal-close-btn">&times;</button>
        </div>
        <div class="sn-preview-content">
        <div class="sn-preview-body">
          <div class="sn-preview-meta-grid" id="sn-modal-meta-grid"></div>

          <div class="sn-preview-section">
            <span class="sn-preview-section-title">Short Description</span>
            <div class="sn-preview-desc-box" id="sn-modal-short-desc" style="max-height: 80px;">—</div>
          </div>

          <div class="sn-preview-section">
            <span class="sn-preview-section-title">Full Description</span>
            <div class="sn-preview-desc-box" id="sn-modal-desc">Loading description...</div>
          </div>
        </div>
        <aside class="sn-ws-panel" id="sn-ws-panel" style="display: none;"></aside>
        </div>
        <div class="sn-preview-footer">
          <button class="sn-preview-link-btn" id="sn-modal-native-link">Open full ticket in ServiceNow ↗</button>
          <div style="display: flex; gap: 12px;">
            <button class="sn-preview-action-btn" id="sn-modal-assign-btn" style="display:none;">Assign to me</button>
            <button class="sn-preview-action-btn" id="sn-modal-close-modal-btn" style="background:#334155;">Close Preview</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(previewModal);

    const notifModal = document.createElement('div');
    notifModal.id = 'sn-notif-modal';
    notifModal.innerHTML = `
      <div class="sn-notif-card">
        <div class="sn-notif-header">
          <h3>Manage New Ticket Queue & Alerts</h3>
          <button class="sn-preview-close" id="sn-notif-modal-close">&times;</button>
        </div>
        <div class="sn-notif-body">
          <p class="sn-notif-desc">Select which assignment group to monitor in the <strong>New Ticket Queue</strong>. Whenever a new unassigned CS case or INC incident arrives in this group, you will receive an audio chime, a Windows desktop notification, and an in-page pop-up toast.</p>
          <div class="sn-filter-group" style="width: 100%;">
            <span class="sn-filter-label">Monitored Assignment Group</span>
            <select id="sn-modal-notif-group-select" class="sn-select" style="width: 100%;">
              <option value="${DEFAULT_GROUP}">${DEFAULT_GROUP}</option>
            </select>
          </div>
        </div>
        <div class="sn-notif-footer">
          <button class="sn-preview-action-btn" id="sn-notif-modal-save">Save & Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(notifModal);

    document.getElementById('sn-update-dismiss').addEventListener('click', () => {
      document.getElementById('sn-update-banner').classList.add('sn-hidden');
    });

    document.getElementById('sn-go-new-queue').addEventListener('click', () => switchView('new_queue'));
    document.getElementById('sn-go-cases').addEventListener('click', () => switchView('cases'));
    document.getElementById('sn-go-changes').addEventListener('click', () => switchView('changes'));
	document.getElementById('sn-go-links').addEventListener('click', () => switchView('links'));
    document.getElementById('sn-go-mine').addEventListener('click', () => switchView('mine'));
    document.getElementById('sn-go-bugs').addEventListener('click', () => switchView('bugs'));
    document.getElementById('sn-go-passwords').addEventListener('click', () => switchView('passwords'));
    document.getElementById('sn-pw-back-btn').addEventListener('click', () => switchView('hub'));

    document.getElementById('sn-links-back-btn').addEventListener('click', () => switchView('hub'));
    document.getElementById('sn-mine-back-btn').addEventListener('click', () => switchView('hub'));
    document.getElementById('sn-bugs-back-btn').addEventListener('click', () => switchView('hub'));

    initLinksManagerEvents();
    initMineEvents();
    initBugsEvents();
    initPasswordEvents();
    initWorkspacePanelEvents();
    renderMineHubTile();
    renderBugsHubTile();
    renderUserLinks();
    document.getElementById('sn-newq-back-btn').addEventListener('click', () => switchView('hub'));
    document.getElementById('sn-case-back-btn').addEventListener('click', () => switchView('hub'));
    document.getElementById('sn-chg-back-btn').addEventListener('click', () => switchView('hub'));

    const handleAlertBtnClick = (e) => {
      e.stopPropagation();
      if (Notification.permission !== 'granted') {
        Notification.requestPermission().then((perm) => {
          updateAlertsButtonState();
          if (perm === 'granted') {
            notifModal.classList.add('show');
          }
        });
      } else {
        notifModal.classList.add('show');
      }
    };
    document.getElementById('sn-hub-notif-btn').addEventListener('click', handleAlertBtnClick);
    document.getElementById('sn-newq-notif-btn').addEventListener('click', handleAlertBtnClick);

    const closePreview = () => {
      previewModal.classList.remove('show');
      if (workspaceTicket) {
        workspaceTicket = null;
        if (currentView === 'mine') renderMineTable();
        if (currentView === 'bugs') renderBugs();
      }
    };
    document.getElementById('sn-modal-close-btn').addEventListener('click', closePreview);
    document.getElementById('sn-modal-close-modal-btn').addEventListener('click', closePreview);
    previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview(); });

    const closeNotifModal = () => notifModal.classList.remove('show');
    document.getElementById('sn-notif-modal-close').addEventListener('click', closeNotifModal);
    document.getElementById('sn-notif-modal-save').addEventListener('click', () => {
      notificationGroup = document.getElementById('sn-modal-notif-group-select').value;
      localStorage.setItem('sn_helper_notif_group', notificationGroup);
      knownGlobalUnassignedCS.clear();
      isFirstLoad = true;
      updateNotificationGroupDropdowns();
      updateAlertsButtonState();
      fetchTickets();
      closeNotifModal();
    });
    notifModal.addEventListener('click', (e) => { if (e.target === notifModal) closeNotifModal(); });

    const dropBtn = document.getElementById('sn-state-drop-btn');
    const dropContent = document.getElementById('sn-state-drop-content');
    dropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropContent.classList.toggle('show');
    });

	const searchInput = document.getElementById('sn-hub-search-input');
    const searchBtn = document.getElementById('sn-hub-search-btn');
    if (searchBtn && searchInput) {
      searchBtn.addEventListener('click', () => searchTicketByNumber(searchInput.value));
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          searchTicketByNumber(searchInput.value);
        }
      });
    }

    const chgDropBtn = document.getElementById('sn-chg-approval-drop-btn');
    const chgDropContent = document.getElementById('sn-chg-approval-drop-content');
    chgDropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chgDropContent.classList.toggle('show');
      chgStateDropContent.classList.remove('show');
    });

    const chgStateDropBtn = document.getElementById('sn-chg-state-drop-btn');
    const chgStateDropContent = document.getElementById('sn-chg-state-drop-content');
    chgStateDropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chgStateDropContent.classList.toggle('show');
      chgDropContent.classList.remove('show');
    });

    document.addEventListener('click', (e) => {
      const dropContainer = document.getElementById('sn-state-dropdown-container');
      if (dropContainer && !dropContainer.contains(e.target)) {
        dropContent.classList.remove('show');
      }
      const chgDropContainer = document.getElementById('sn-chg-approval-dropdown-container');
      if (chgDropContainer && !chgDropContainer.contains(e.target)) {
        chgDropContent.classList.remove('show');
      }
      const chgStateDropContainer = document.getElementById('sn-chg-state-dropdown-container');
      if (chgStateDropContainer && !chgStateDropContainer.contains(e.target)) {
        chgStateDropContent.classList.remove('show');
      }
    });

    function setOverlayVisibility(hidden) {
      if (hidden) {
        overlay.classList.add('sn-hidden');
        toggleBtn.innerText = latestAvailableVersion
          ? 'Open Support Hub (Update Available!)'
          : 'Open Support Hub';
      } else {
        overlay.classList.remove('sn-hidden');
        toggleBtn.innerText = 'Hide Support Hub';
      }
    }

    toggleBtn.addEventListener('click', () => {
      const isHidden = overlay.classList.contains('sn-hidden');
      setOverlayVisibility(!isHidden);
    });

    document.getElementById('sn-newq-group-select').addEventListener('change', (e) => {
      notificationGroup = e.target.value;
      localStorage.setItem('sn_helper_notif_group', notificationGroup);
      knownGlobalUnassignedCS.clear();
      isFirstLoad = true;
      updateNotificationGroupDropdowns();
      updateAlertsButtonState();
      fetchTickets();
    });

    document.getElementById('sn-newq-refresh-btn').addEventListener('click', () => fetchTickets());

    document.getElementById('sn-group-select').addEventListener('change', (e) => {
      selectedGroup = e.target.value;
      localStorage.setItem('sn_helper_group', selectedGroup);
      selectedUser = 'ALL';
      localStorage.setItem('sn_helper_user', 'ALL');
      fetchTickets();
    });

    document.getElementById('sn-type-select').addEventListener('change', (e) => {
      selectedType = e.target.value;
      localStorage.setItem('sn_helper_case_type', selectedType);
      applyFiltersAndRender();
    });

    document.getElementById('sn-user-select').addEventListener('change', (e) => {
      selectedUser = e.target.value;
      localStorage.setItem('sn_helper_user', selectedUser);
      applyFiltersAndRender();
    });

    document.getElementById('sn-refresh-btn').addEventListener('click', () => fetchTickets());

    document.getElementById('sn-chg-group-select').addEventListener('change', (e) => {
      chgSelectedGroup = e.target.value;
      localStorage.setItem('sn_helper_chg_group', chgSelectedGroup);
      chgSelectedAssigned = 'ALL';
      chgSelectedRequested = 'ALL';
      localStorage.setItem('sn_helper_chg_assigned', 'ALL');
      localStorage.setItem('sn_helper_chg_requested', 'ALL');
      fetchChanges();
    });

    document.getElementById('sn-chg-assigned-select').addEventListener('change', (e) => {
      chgSelectedAssigned = e.target.value;
      localStorage.setItem('sn_helper_chg_assigned', chgSelectedAssigned);
      applyChangeFiltersAndRender();
    });

    document.getElementById('sn-chg-requested-select').addEventListener('change', (e) => {
      chgSelectedRequested = e.target.value;
      localStorage.setItem('sn_helper_chg_requested', chgSelectedRequested);
      applyChangeFiltersAndRender();
    });

    document.getElementById('sn-chg-refresh-btn').addEventListener('click', () => fetchChanges());

    switchView(currentView);
    updateAlertsButtonState();

    fetchUserGroups().then(() => {
      updateAlertsButtonState();
    });
  }

  function getTicketPrefix(number) {
    const match = (number || '').match(/^([A-Z]+)/);
    return match ? match[1] : 'OTHER';
  }

  function isCaseOrInc(number) {
    const prefix = getTicketPrefix(number);
    return prefix === 'CS' || prefix === 'INC';
  }

  async function fetchTickets() {
    const token = getAuthToken();
    const statusText = document.getElementById('sn-status-text');
    const newqStatusText = document.getElementById('sn-newq-status-text');
    if (!token) return;

    const fields = 'sys_id,number,priority,state,short_description,assignment_group,assigned_to,opened_at,sys_class_name';
    const headers = { 'Accept': 'application/json', 'X-UserToken': token };

    try {
      if (statusText) statusText.innerText = 'Refreshing CS & INC tickets...';
      if (newqStatusText) newqStatusText.innerText = 'Checking for unassigned CS & INC tickets...';

      const globalQuery = 'active=true^numberSTARTSWITHCS^numberNOT LIKECSTASK^NQactive=true^numberSTARTSWITHINC^ORDERBYDESCsys_created_on';
      const globalUrl = `/api/now/table/task?sysparm_query=${encodeURIComponent(globalQuery)}&sysparm_limit=500&sysparm_display_value=true&sysparm_fields=${fields}`;

      const requests = [fetch(globalUrl, { headers })];
      if (selectedGroup !== 'ALL') {
        const groupQuery = `active=true^assignment_group.name=${selectedGroup}^numberSTARTSWITHCS^numberNOT LIKECSTASK^NQactive=true^assignment_group.name=${selectedGroup}^numberSTARTSWITHINC^ORDERBYDESCsys_created_on`;
        const groupUrl = `/api/now/table/task?sysparm_query=${encodeURIComponent(groupQuery)}&sysparm_limit=1000&sysparm_display_value=true&sysparm_fields=${fields}`;
        requests.push(fetch(groupUrl, { headers }));
      }

      const targetNotifGroup = notificationGroup || DEFAULT_GROUP;
      const bgNotificationQuery = `active=true^assignment_group.name=${targetNotifGroup}^assigned_toISEMPTY^numberSTARTSWITHCS^numberNOT LIKECSTASK^NQactive=true^assignment_group.name=${targetNotifGroup}^assigned_toISEMPTY^numberSTARTSWITHINC^ORDERBYDESCsys_created_on`;
      const bgUrl = `/api/now/table/task?sysparm_query=${encodeURIComponent(bgNotificationQuery)}&sysparm_limit=200&sysparm_display_value=true&sysparm_fields=${fields}`;
      requests.push(fetch(bgUrl, { headers }));

      const responses = await Promise.all(requests);
      for (const r of responses) {
        if (r.status === 401 || r.status === 403) {
          if (statusText) statusText.innerText = 'Session expired or unauthorized. Please log in or refresh the page.';
          if (newqStatusText) newqStatusText.innerText = 'Session expired. Waiting for login...';
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }

      const jsonPayloads = await Promise.all(responses.map((r) => r.json()));
      
      const ticketMap = new Map();
      for (let i = 0; i < jsonPayloads.length - 1; i++) {
        (jsonPayloads[i].result || []).forEach((t) => {
          ticketMap.set(t.number, t);
        });
      }
      allTickets = Array.from(ticketMap.values());

      const bgPayload = jsonPayloads[jsonPayloads.length - 1];
      unassignedQueueCS = (bgPayload.result || []).filter((t) => isCaseOrInc(t.number));
      
      unassignedQueueCS.forEach((t) => {
        if (!knownGlobalUnassignedCS.has(t.number)) {
          knownGlobalUnassignedCS.add(t.number);
          if (!isFirstLoad) {
            sendNotification(t);
          }
        }
      });

      if (isFirstLoad) {
        unassignedQueueCS.forEach((t) => knownGlobalUnassignedCS.add(t.number));
      }

      isFirstLoad = false;
      updateDropdowns();
      applyFiltersAndRender();
      renderNewTicketQueue();
    } catch (err) {
      console.warn('SN Helper Fetch Warning:', err.message);
      if (statusText) statusText.innerText = `Connection issue (${err.message}). Retrying...`;
      if (newqStatusText) newqStatusText.innerText = `Connection issue (${err.message}).`;
    }
  }

  function renderNewTicketQueue() {
    const tbody = document.getElementById('sn-newq-body');
    const statusText = document.getElementById('sn-newq-status-text');
    const hubBadge = document.getElementById('sn-hub-unassigned-count');
    const targetGroup = notificationGroup || DEFAULT_GROUP;

    if (hubBadge) {
      hubBadge.innerText = `${unassignedQueueCS.length} Unassigned`;
      hubBadge.style.background = unassignedQueueCS.length > 0 ? '#dc2626' : '#334155';
    }

    if (statusText) {
      const now = new Date().toLocaleTimeString();
      statusText.innerText = `Last checked: ${now} • ${unassignedQueueCS.length} unassigned CS/INC ticket(s) waiting in ${targetGroup}`;
    }

    if (!tbody) return;

    if (unassignedQueueCS.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 28px; color: #94a3b8;">🎉 All clear! No unassigned CS or INC tickets in <strong>${escapeHtml(targetGroup)}</strong>.</td></tr>`;
      return;
    }

    tbody.innerHTML = unassignedQueueCS
      .map((t) => {
        const groupName = t.assignment_group?.display_value || 'Unassigned Group';
        const prefix = getTicketPrefix(t.number);
        const prioNum = (t.priority || '').charAt(0);
        const prioClass = prioNum === '1' || prioNum === '2' ? `sn-priority-${prioNum}` : '';
        const stateVal = t.state || '—';
        const stateClass = getStateBadgeClass(stateVal);

        return `
          <tr>
            <td><span class="sn-type-badge">${escapeHtml(prefix)}</span><a class="sn-link" href="#" data-sysid="${escapeHtml(t.sys_id)}">${escapeHtml(t.number)}</a></td>
            <td><span class="sn-badge ${prioClass}">${escapeHtml(t.priority || '—')}</span></td>
            <td><span class="sn-state-badge ${stateClass}">${escapeHtml(stateVal)}</span></td>
            <td>${escapeHtml(t.short_description || '')}</td>
            <td>${escapeHtml(groupName)}</td>
            <td><span class="sn-unassigned-pill">Unassigned</span> <button class="sn-assign-btn" data-sysid="${escapeHtml(t.sys_id)}">Assign to me</button></td>
            <td>${escapeHtml(t.opened_at || '')}</td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('.sn-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        openTicketPreview(link.getAttribute('data-sysid'), 'CS');
      });
    });

    tbody.querySelectorAll('.sn-assign-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        assignToMe(btn.getAttribute('data-sysid'), btn);
      });
    });
  }

  function updateDropdowns() {
    const groupSelect = document.getElementById('sn-group-select');
    if (!groupSelect) return;

    const uniqueGroups = new Set([DEFAULT_GROUP, ...userMemberGroups]);
    const uniqueStates = new Set();

    allTickets.forEach((t) => {
      const gName = t.assignment_group?.display_value || 'Unassigned Group';
      uniqueGroups.add(gName);
      if (isCaseOrInc(t.number) && t.state) {
        uniqueStates.add(t.state);
      }
    });

    const sortedGroups = Array.from(uniqueGroups).sort((a, b) => a.localeCompare(b));
    const sortedStates = Array.from(uniqueStates).sort((a, b) => a.localeCompare(b));

    if (!selectedStates) {
      selectedStates = [...sortedStates];
    }

    let groupOpts = `<option value="ALL" ${selectedGroup === 'ALL' ? 'selected' : ''}>All Active Groups</option>`;
    sortedGroups.forEach((g) => {
      groupOpts += `<option value="${escapeHtml(g)}" ${selectedGroup === g ? 'selected' : ''}>${escapeHtml(g)}</option>`;
    });
    groupSelect.innerHTML = groupOpts;

    const checkboxesContainer = document.getElementById('sn-state-checkboxes');
    if (checkboxesContainer) {
      checkboxesContainer.innerHTML = sortedStates.map((st) => {
        const isChecked = selectedStates.includes(st) ? 'checked' : '';
        return `
          <label class="sn-dropdown-item">
            <input type="checkbox" value="${escapeHtml(st)}" ${isChecked} class="sn-state-cb" />
            ${escapeHtml(st)}
          </label>
        `;
      }).join('');

      checkboxesContainer.querySelectorAll('.sn-state-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
          const checkedBoxes = checkboxesContainer.querySelectorAll('.sn-state-cb:checked');
          selectedStates = Array.from(checkedBoxes).map((box) => box.value);
          localStorage.setItem('sn_helper_states', JSON.stringify(selectedStates));
          updateStateButtonLabel();
          applyFiltersAndRender();
        });
      });
    }

    document.getElementById('sn-state-select-all').onclick = (e) => {
      e.preventDefault();
      selectedStates = [...sortedStates];
      localStorage.setItem('sn_helper_states', JSON.stringify(selectedStates));
      updateDropdowns();
      applyFiltersAndRender();
    };

    document.getElementById('sn-state-clear-all').onclick = (e) => {
      e.preventDefault();
      selectedStates = [];
      localStorage.setItem('sn_helper_states', JSON.stringify(selectedStates));
      updateDropdowns();
      applyFiltersAndRender();
    };

    updateStateButtonLabel();
    updateNotificationGroupDropdowns();
    updateAlertsButtonState();
  }

  function updateStateButtonLabel() {
    const dropBtn = document.getElementById('sn-state-drop-btn');
    if (!dropBtn) return;
    if (selectedStates.length === 0) {
      dropBtn.innerText = '0 States Selected';
    } else {
      dropBtn.innerText = `States (${selectedStates.length} selected)`;
    }
  }

  function applyFiltersAndRender() {
    const userSelect = document.getElementById('sn-user-select');
    const statusText = document.getElementById('sn-status-text');

    let filtered = allTickets.filter((t) => {
      const prefix = getTicketPrefix(t.number);
      if (prefix !== 'CS' && prefix !== 'INC') return false;
      if (selectedType !== 'ALL' && prefix !== selectedType) return false;
      const gName = t.assignment_group?.display_value || 'Unassigned Group';
      return selectedGroup === 'ALL' || gName === selectedGroup;
    });

    if (selectedStates && selectedStates.length > 0) {
      filtered = filtered.filter((t) => selectedStates.includes(t.state));
    } else {
      filtered = [];
    }

    const uniqueUsers = new Set();
    filtered.forEach((t) => {
      const uName = (t.assigned_to?.display_value || '').trim();
      if (uName) uniqueUsers.add(uName);
    });

    const sortedUsers = Array.from(uniqueUsers).sort((a, b) => a.localeCompare(b));
    if (selectedUser !== 'ALL' && !uniqueUsers.has(selectedUser)) {
      selectedUser = 'ALL';
      localStorage.setItem('sn_helper_user', 'ALL');
    }

    if (userSelect) {
      let userOpts = `<option value="ALL" ${selectedUser === 'ALL' ? 'selected' : ''}>All Assigned Users (${sortedUsers.length})</option>`;
      sortedUsers.forEach((u) => {
        userOpts += `<option value="${escapeHtml(u)}" ${selectedUser === u ? 'selected' : ''}>${escapeHtml(u)}</option>`;
      });
      userSelect.innerHTML = userOpts;
    }

    const finalTickets = filtered.filter((t) => {
      const uName = (t.assigned_to?.display_value || '').trim();
      if (selectedUser !== 'ALL') return uName === selectedUser;
      return true;
    });

    renderTable(finalTickets);

    if (statusText) {
      const now = new Date().toLocaleTimeString();
      const typeLabel = selectedType === 'ALL' ? 'CS/INC' : selectedType;
      statusText.innerText = `Last updated: ${now} • Showing ${finalTickets.length} of ${filtered.length} ${typeLabel} tickets`;
    }
  }

  function renderTable(tickets) {
    const tbody = document.getElementById('sn-ticket-body');
    if (!tbody) return;

    if (tickets.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 24px; color: #94a3b8;">No tickets match your filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = tickets
      .map((t) => {
        const groupName = t.assignment_group?.display_value || 'Unassigned Group';
        const rawUser = (t.assigned_to?.display_value || '').trim();
        
        const assignedToHtml = rawUser 
          ? escapeHtml(rawUser)
          : `<span class="sn-unassigned-pill">Unassigned</span> <button class="sn-assign-btn" data-sysid="${escapeHtml(t.sys_id)}">Assign to me</button>`;
        
        const prefix = getTicketPrefix(t.number);
        const prioNum = (t.priority || '').charAt(0);
        const prioClass = prioNum === '1' || prioNum === '2' ? `sn-priority-${prioNum}` : '';

        const stateVal = t.state || '—';
        const stateClass = getStateBadgeClass(stateVal);

        return `
          <tr>
            <td><span class="sn-type-badge">${escapeHtml(prefix)}</span><a class="sn-link" href="#" data-sysid="${escapeHtml(t.sys_id)}">${escapeHtml(t.number)}</a></td>
            <td><span class="sn-badge ${prioClass}">${escapeHtml(t.priority || '—')}</span></td>
            <td><span class="sn-state-badge ${stateClass}">${escapeHtml(stateVal)}</span></td>
            <td>${escapeHtml(t.short_description || '')}</td>
            <td>${escapeHtml(groupName)}</td>
            <td>${assignedToHtml}</td>
            <td>${escapeHtml(t.opened_at || '')}</td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('.sn-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const sysId = link.getAttribute('data-sysid');
        openTicketPreview(sysId, 'CS');
      });
    });

    tbody.querySelectorAll('.sn-assign-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        assignToMe(btn.getAttribute('data-sysid'), btn);
      });
    });
  }

  async function fetchChanges() {
    const token = getAuthToken();
    const statusText = document.getElementById('sn-chg-status-text');
    if (!token) return;

    const currentUserId = await resolveCurrentUserId();
    const fields = 'sys_id,number,priority,state,short_description,assignment_group,assigned_to,opened_at,approval,type,start_date,end_date,requested_by';
    const headers = { 'Accept': 'application/json', 'X-UserToken': token };

    try {
      if (statusText) statusText.innerText = 'Refreshing change requests...';

      // Removed 'active=true^' so closed and historical changes are included
      const globalQuery = 'ORDERBYDESCsys_created_on';
      const globalUrl = `/api/now/table/change_request?sysparm_query=${encodeURIComponent(globalQuery)}&sysparm_limit=200&sysparm_display_value=all&sysparm_fields=${fields}`;

      const requests = [fetch(globalUrl, { headers })];
      if (chgSelectedGroup !== 'ALL') {
        const groupQuery = `assignment_group.name=${chgSelectedGroup}^ORDERBYDESCsys_created_on`;
        const groupUrl = `/api/now/table/change_request?sysparm_query=${encodeURIComponent(groupQuery)}&sysparm_limit=200&sysparm_display_value=all&sysparm_fields=${fields}`;
        requests.push(fetch(groupUrl, { headers }));
      }

      if (currentUserId) {
        const myChgQuery = `assigned_to=${currentUserId}^ORDERBYDESCsys_created_on`;
        const myChgUrl = `/api/now/table/change_request?sysparm_query=${encodeURIComponent(myChgQuery)}&sysparm_limit=50&sysparm_display_value=all&sysparm_fields=${fields}`;
        requests.push(fetch(myChgUrl, { headers }));
      }

      const responses = await Promise.all(requests);
      for (const r of responses) {
        if (r.status === 401 || r.status === 403) {
          if (statusText) statusText.innerText = 'Session expired or unauthorized. Please log in or refresh the page.';
          return;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }

      const jsonPayloads = await Promise.all(responses.map((r) => r.json()));
      const chgMap = new Map();
      jsonPayloads.forEach((payload) => {
        (payload.result || []).forEach((c) => {
          const num = getVal(c.number);
          if (num) chgMap.set(num, c);
        });
      });

      allChanges = Array.from(chgMap.values());
      updateChangeDropdowns();
      applyChangeFiltersAndRender();
      renderUpcomingUserChanges();
    } catch (err) {
      console.warn('SN Helper Change Fetch Warning:', err.message);
      if (statusText) statusText.innerText = `Connection issue (${err.message}).`;
    }
  }

  function renderUpcomingUserChanges() {
    const hubWrapper = document.getElementById('sn-hub-wrapper');
    const widget = document.getElementById('sn-upcoming-changes-widget');
    const listEl = document.getElementById('sn-upcoming-changes-list');
    const badgeEl = document.getElementById('sn-upcoming-count-badge');
    const userLabelEl = document.getElementById('sn-upcoming-user-label');
    if (!widget || !listEl) return;

    const myId = getCurrentUserId();
    const myName = (getCurrentUserName() || '').toLowerCase().trim();

    if (!myId && !myName) {
      widget.classList.add('sn-hidden');
      if (hubWrapper) hubWrapper.classList.remove('sn-has-side-panel');
      return;
    }

    const now = new Date();

    // Filter changes assigned to the current user
    // Automatically remove once they reach Review, Closed, Completed, or Cancelled state
    const userChanges = allChanges.filter((c) => {
      const assignedSysId = getRawVal(c.assigned_to);
      const assignedName = getVal(c.assigned_to).toLowerCase().trim();

      const isMine =
        (myId && assignedSysId === myId) ||
        (myName && assignedName && assignedName === myName);

      if (!isMine) return false;

      const stateText = getVal(c.state).toLowerCase().trim();
      if (
        stateText.includes('review') ||
        stateText.includes('closed') ||
        stateText.includes('cancel') ||
        stateText.includes('complete')
      ) {
        return false;
      }

      return true;
    });

    // Check window transitions (Start / End) & trigger notifications
    userChanges.forEach((c) => {
      const number = getVal(c.number);
      const startDisp = getVal(c.start_date);
      const endDisp = getVal(c.end_date);
      const startDateObj = parseSNDate(startDisp) || parseSNDate(getRawVal(c.start_date));
      const endDateObj = parseSNDate(endDisp) || parseSNDate(getRawVal(c.end_date));

      const isPastEnd = endDateObj && now.getTime() > endDateObj.getTime();
      const isInWindow =
        startDateObj &&
        now.getTime() >= startDateObj.getTime() &&
        (!endDateObj || now.getTime() <= endDateObj.getTime());

      if (isFirstChangeLoad) {
        // Seed existing states on first load so we don't spam alerts on page refresh
        if (isInWindow || isPastEnd) notifiedChangeStart.add(number);
        if (isPastEnd) notifiedChangeEnd.add(number);
      } else {
        if (isInWindow && !notifiedChangeStart.has(number)) {
          notifiedChangeStart.add(number);
          sendChangeWindowNotification(c, 'START');
        }
        if (isPastEnd && !notifiedChangeEnd.has(number)) {
          notifiedChangeEnd.add(number);
          notifiedChangeStart.add(number);
          sendChangeWindowNotification(c, 'END');
        }
      }
    });

    if (isFirstChangeLoad) {
      isFirstChangeLoad = false;
    }
    saveNotifiedChangeSets();

    // Sort priority: 1) Active Window / Overdue Review Needed -> 2) Upcoming chronological -> 3) Unscheduled
    userChanges.sort((a, b) => {
      const dA = parseSNDate(getVal(a.start_date)) || parseSNDate(getRawVal(a.start_date));
      const dB = parseSNDate(getVal(b.start_date)) || parseSNDate(getRawVal(b.start_date));
      if (dA && dB) return dA.getTime() - dB.getTime();
      if (dA) return -1;
      if (dB) return 1;
      return getVal(a.number).localeCompare(getVal(b.number));
    });

    myUpcomingChanges = userChanges;

    // Hide the side panel and re-center the Hub when empty
    if (myUpcomingChanges.length === 0) {
      widget.classList.add('sn-hidden');
      if (hubWrapper) hubWrapper.classList.remove('sn-has-side-panel');
      return;
    }

    // Show side panel and shift Hub layout to make room
    widget.classList.remove('sn-hidden');
    if (hubWrapper) hubWrapper.classList.add('sn-has-side-panel');

    if (badgeEl) badgeEl.innerText = `${myUpcomingChanges.length} Active`;
    if (userLabelEl) {
      const displayUser = getCurrentUserName() || getVal(myUpcomingChanges[0].assigned_to) || 'Current User';
      userLabelEl.innerText = `Assigned to ${displayUser} • Auto-clears at Review stage`;
    }

    listEl.innerHTML = myUpcomingChanges
      .map((c) => {
        const sysId = getRawVal(c.sys_id) || getVal(c.sys_id);
        const number = getVal(c.number);
        const shortDesc = getVal(c.short_description) || 'No description provided';
        const stateVal = getVal(c.state) || '—';
        const approvalVal = getVal(c.approval) || '—';
        const stateClass = getStateBadgeClass(stateVal);

        const startDisp = getVal(c.start_date);
        const endDisp = getVal(c.end_date);
        const startDateObj = parseSNDate(startDisp) || parseSNDate(getRawVal(c.start_date));
        const endDateObj = parseSNDate(endDisp) || parseSNDate(getRawVal(c.end_date));

        const isPastEnd = endDateObj && now.getTime() > endDateObj.getTime();
        const isActiveNow =
          !isPastEnd &&
          startDateObj &&
          now.getTime() >= startDateObj.getTime() &&
          (!endDateObj || now.getTime() <= endDateObj.getTime());

        let itemStateClass = '';
        let statusPillHtml = '<span class="sn-chg-status-pill sn-pill-upcoming">Upcoming</span>';
        let actionBannerHtml = '';

        if (isPastEnd) {
          itemStateClass = 'sn-chg-review-needed';
          statusPillHtml = '<span class="sn-chg-status-pill sn-pill-overdue">⚠️ Review / Close</span>';
          actionBannerHtml = `<div class="sn-upcoming-action-banner">Window ended while in <strong>${escapeHtml(stateVal)}</strong>. Move to Review to clear.</div>`;
        } else if (isActiveNow) {
          itemStateClass = 'sn-chg-active-now';
          statusPillHtml = '<span class="sn-chg-status-pill sn-pill-active">🟢 Window Active</span>';
        }

        const scheduleText = startDisp
          ? `<div><strong>Start:</strong> ${escapeHtml(startDisp)}</div>${endDisp ? `<div><strong>End:</strong> ${escapeHtml(endDisp)}</div>` : ''}`
          : '<div><em>No scheduled start date set</em></div>';

        return `
          <div class="sn-upcoming-item ${itemStateClass}" data-sysid="${escapeHtml(sysId)}" title="Click to preview ${escapeHtml(number)}">
            <div class="sn-upcoming-item-top">
              <span class="sn-upcoming-number">
                ${escapeHtml(number)}${notesCountBadgeHtml(number)}
                ${statusPillHtml}
              </span>
              <span class="sn-state-badge ${stateClass}" style="font-size: 10.5px; padding: 2px 7px;">${escapeHtml(stateVal)} • ${escapeHtml(approvalVal)}</span>
            </div>
            <div class="sn-upcoming-desc">${escapeHtml(shortDesc)}</div>
            ${actionBannerHtml}
            <div class="sn-upcoming-time">${scheduleText}</div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.sn-upcoming-item').forEach((card) => {
      card.addEventListener('click', () => {
        const sysId = card.getAttribute('data-sysid');
        if (sysId) openTicketPreview(sysId, 'CHG');
      });
    });
  }

  function updateChangeDropdowns() {
    const groupSelect = document.getElementById('sn-chg-group-select');
    if (!groupSelect) return;

    const uniqueGroups = new Set([DEFAULT_GROUP, ...userMemberGroups]);
    const uniqueApprovals = new Set();

    allTickets.forEach((t) => {
      if (t.assignment_group?.display_value) uniqueGroups.add(t.assignment_group.display_value);
    });

    allChanges.forEach((c) => {
      const gName = getVal(c.assignment_group) || 'Unassigned Group';
      uniqueGroups.add(gName);
      const appVal = getVal(c.approval) || 'Not Yet Requested';
      uniqueApprovals.add(appVal);
    });

    const sortedGroups = Array.from(uniqueGroups).sort((a, b) => a.localeCompare(b));
    const sortedApprovals = Array.from(uniqueApprovals).sort((a, b) => a.localeCompare(b));

    if (!chgSelectedApprovals) {
      chgSelectedApprovals = [...sortedApprovals];
    }

    let groupOpts = `<option value="ALL" ${chgSelectedGroup === 'ALL' ? 'selected' : ''}>All Active Groups</option>`;
    sortedGroups.forEach((g) => {
      groupOpts += `<option value="${escapeHtml(g)}" ${chgSelectedGroup === g ? 'selected' : ''}>${escapeHtml(g)}</option>`;
    });
    groupSelect.innerHTML = groupOpts;

    const checkboxesContainer = document.getElementById('sn-chg-approval-checkboxes');
    if (checkboxesContainer) {
      checkboxesContainer.innerHTML = sortedApprovals.map((ap) => {
        const isChecked = chgSelectedApprovals.includes(ap) ? 'checked' : '';
        return `
          <label class="sn-dropdown-item">
            <input type="checkbox" value="${escapeHtml(ap)}" ${isChecked} class="sn-chg-ap-cb" />
            ${escapeHtml(ap)}
          </label>
        `;
      }).join('');

      checkboxesContainer.querySelectorAll('.sn-chg-ap-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
          const checkedBoxes = checkboxesContainer.querySelectorAll('.sn-chg-ap-cb:checked');
          chgSelectedApprovals = Array.from(checkedBoxes).map((box) => box.value);
          localStorage.setItem('sn_helper_chg_approvals', JSON.stringify(chgSelectedApprovals));
          updateChangeApprovalButtonLabel();
          applyChangeFiltersAndRender();
        });
      });
    }

    document.getElementById('sn-chg-approval-select-all').onclick = (e) => {
      e.preventDefault();
      chgSelectedApprovals = [...sortedApprovals];
      localStorage.setItem('sn_helper_chg_approvals', JSON.stringify(chgSelectedApprovals));
      updateChangeDropdowns();
      applyChangeFiltersAndRender();
    };

    document.getElementById('sn-chg-approval-clear-all').onclick = (e) => {
      e.preventDefault();
      chgSelectedApprovals = [];
      localStorage.setItem('sn_helper_chg_approvals', JSON.stringify(chgSelectedApprovals));
      updateChangeDropdowns();
      applyChangeFiltersAndRender();
    };

    updateChangeApprovalButtonLabel();
    updateChangeStateFilter();
  }

  // Lifecycle order for change states; anything unrecognised sorts alphabetically after these
  const CHG_STATE_ORDER = ['new', 'assess', 'authorize', 'scheduled', 'implement', 'review', 'closed', 'canceled', 'cancelled'];

  function getChangeStateLabel(c) {
    return getVal(c.state) || 'Unknown';
  }

  function isInactiveChangeState(label) {
    return /closed|cancel|complete/i.test(label || '');
  }

  function saveChgExcludedStates() {
    localStorage.setItem('sn_helper_chg_states_excluded', JSON.stringify(chgExcludedStates));
  }

  function updateChangeStateFilter() {
    const container = document.getElementById('sn-chg-state-checkboxes');
    if (!container) return;

    const rank = (label) => {
      const i = CHG_STATE_ORDER.indexOf(label.toLowerCase().trim());
      return i === -1 ? CHG_STATE_ORDER.length : i;
    };
    chgKnownStates = Array.from(new Set(allChanges.map(getChangeStateLabel)))
      .sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));

    const counts = {};
    allChanges.forEach((c) => {
      const st = getChangeStateLabel(c);
      counts[st] = (counts[st] || 0) + 1;
    });

    container.innerHTML = chgKnownStates.map((st) => `
      <label class="sn-dropdown-item">
        <input type="checkbox" value="${escapeHtml(st)}" ${chgExcludedStates.includes(st) ? '' : 'checked'} class="sn-chg-state-cb" />
        <span class="sn-state-badge ${getStateBadgeClass(st)}" style="font-size: 11px; padding: 1px 6px;">${escapeHtml(st)}</span>
        <span style="margin-left: auto; color: #64748b; font-size: 11px;">${counts[st] || 0}</span>
      </label>
    `).join('');

    container.querySelectorAll('.sn-chg-state-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const st = cb.value;
        chgExcludedStates = chgExcludedStates.filter((x) => x !== st);
        if (!cb.checked) chgExcludedStates.push(st);
        saveChgExcludedStates();
        updateChangeStateButtonLabel();
        applyChangeFiltersAndRender();
      });
    });

    const setExcluded = (list) => {
      chgExcludedStates = list;
      saveChgExcludedStates();
      updateChangeStateFilter();
      applyChangeFiltersAndRender();
    };
    document.getElementById('sn-chg-state-select-all').onclick = (e) => {
      e.preventDefault();
      setExcluded([]);
    };
    document.getElementById('sn-chg-state-active-only').onclick = (e) => {
      e.preventDefault();
      setExcluded(chgKnownStates.filter(isInactiveChangeState));
    };
    document.getElementById('sn-chg-state-clear-all').onclick = (e) => {
      e.preventDefault();
      setExcluded([...chgKnownStates]);
    };

    updateChangeStateButtonLabel();
  }

  function updateChangeStateButtonLabel() {
    const btn = document.getElementById('sn-chg-state-drop-btn');
    if (!btn) return;
    const total = chgKnownStates.length;
    const shown = chgKnownStates.filter((st) => !chgExcludedStates.includes(st)).length;
    if (total === 0 || shown === total) btn.innerText = 'All States';
    else if (shown === 0) btn.innerText = '0 States Selected';
    else if (chgKnownStates.filter((st) => !chgExcludedStates.includes(st)).every((st) => !isInactiveChangeState(st))
      && chgKnownStates.filter(isInactiveChangeState).every((st) => chgExcludedStates.includes(st))) btn.innerText = `Active only (${shown})`;
    else btn.innerText = `States (${shown} of ${total})`;
  }

  function updateChangeApprovalButtonLabel() {
    const dropBtn = document.getElementById('sn-chg-approval-drop-btn');
    if (!dropBtn) return;
    if (!chgSelectedApprovals || chgSelectedApprovals.length === 0) {
      dropBtn.innerText = '0 Approvals Selected';
    } else {
      dropBtn.innerText = `Approvals (${chgSelectedApprovals.length} selected)`;
    }
  }

  function applyChangeFiltersAndRender() {
    const assignedSelect = document.getElementById('sn-chg-assigned-select');
    const requestedSelect = document.getElementById('sn-chg-requested-select');
    const statusText = document.getElementById('sn-chg-status-text');

    let filtered = allChanges.filter((c) => {
      const gName = getVal(c.assignment_group) || 'Unassigned Group';
      return chgSelectedGroup === 'ALL' || gName === chgSelectedGroup;
    });

    if (chgSelectedApprovals && chgSelectedApprovals.length > 0) {
      filtered = filtered.filter((c) => chgSelectedApprovals.includes(getVal(c.approval) || 'Not Yet Requested'));
    } else {
      filtered = [];
    }

    if (chgExcludedStates.length > 0) {
      filtered = filtered.filter((c) => !chgExcludedStates.includes(getChangeStateLabel(c)));
    }

    const uniqueAssigned = new Set();
    const uniqueRequested = new Set();
    filtered.forEach((c) => {
      const uAss = getVal(c.assigned_to);
      const uReq = getVal(c.requested_by);
      if (uAss) uniqueAssigned.add(uAss);
      if (uReq) uniqueRequested.add(uReq);
    });

    const sortedAssigned = Array.from(uniqueAssigned).sort((a, b) => a.localeCompare(b));
    const sortedRequested = Array.from(uniqueRequested).sort((a, b) => a.localeCompare(b));

    if (chgSelectedAssigned !== 'ALL' && !uniqueAssigned.has(chgSelectedAssigned)) {
      chgSelectedAssigned = 'ALL';
      localStorage.setItem('sn_helper_chg_assigned', 'ALL');
    }
    if (chgSelectedRequested !== 'ALL' && !uniqueRequested.has(chgSelectedRequested)) {
      chgSelectedRequested = 'ALL';
      localStorage.setItem('sn_helper_chg_requested', 'ALL');
    }

    if (assignedSelect) {
      let assOpts = `<option value="ALL" ${chgSelectedAssigned === 'ALL' ? 'selected' : ''}>All Assigned Users (${sortedAssigned.length})</option>`;
      sortedAssigned.forEach((u) => {
        assOpts += `<option value="${escapeHtml(u)}" ${chgSelectedAssigned === u ? 'selected' : ''}>${escapeHtml(u)}</option>`;
      });
      assignedSelect.innerHTML = assOpts;
    }

    if (requestedSelect) {
      let reqOpts = `<option value="ALL" ${chgSelectedRequested === 'ALL' ? 'selected' : ''}>All Requesters (${sortedRequested.length})</option>`;
      sortedRequested.forEach((u) => {
        reqOpts += `<option value="${escapeHtml(u)}" ${chgSelectedRequested === u ? 'selected' : ''}>${escapeHtml(u)}</option>`;
      });
      requestedSelect.innerHTML = reqOpts;
    }

    const finalChanges = filtered.filter((c) => {
      const uAss = getVal(c.assigned_to);
      const uReq = getVal(c.requested_by);
      if (chgSelectedAssigned !== 'ALL' && uAss !== chgSelectedAssigned) return false;
      if (chgSelectedRequested !== 'ALL' && uReq !== chgSelectedRequested) return false;
      return true;
    });

    renderChangeTable(finalChanges);

    if (statusText) {
      const now = new Date().toLocaleTimeString();
      statusText.innerText = `Last updated: ${now} • Showing ${finalChanges.length} of ${filtered.length} change requests`;
    }
  }

  function renderChangeTable(changes) {
    const tbody = document.getElementById('sn-chg-body');
    if (!tbody) return;

    if (changes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 24px; color: #94a3b8;">No change requests match your filters.</td></tr>`;
      return;
    }

    tbody.innerHTML = changes
      .map((c) => {
        const sysId = getRawVal(c.sys_id) || getVal(c.sys_id);
        const number = getVal(c.number);
        const shortDesc = getVal(c.short_description);
        const rawUser = getVal(c.assigned_to);
        const assignedToHtml = rawUser 
          ? escapeHtml(rawUser)
          : `<span class="sn-unassigned-pill">Unassigned</span> <button class="sn-assign-btn" data-sysid="${escapeHtml(sysId)}">Assign to me</button>`;

        const requestedByName = getVal(c.requested_by) || '—';
        const chgType = getVal(c.type) || '—';
        const approvalVal = getVal(c.approval) || '—';
        const approvalClass = getStateBadgeClass(approvalVal);
        const stateVal = getVal(c.state) || '—';
        const stateClass = getStateBadgeClass(stateVal);

        const start = getVal(c.start_date);
        const end = getVal(c.end_date);
        const scheduleHtml = start 
          ? `<div><strong>Start:</strong> ${escapeHtml(start)}</div>${end ? `<div style="font-size:12px; color:#94a3b8;"><strong>End:</strong> ${escapeHtml(end)}</div>` : ''}`
          : '<span style="color:#94a3b8;">Not scheduled</span>';

        return `
          <tr>
            <td><span class="sn-type-badge">CHG</span><a class="sn-link" href="#" data-sysid="${escapeHtml(sysId)}">${escapeHtml(number)}</a>${notesCountBadgeHtml(number)}</td>
            <td><span class="sn-badge">${escapeHtml(chgType)}</span></td>
            <td><span class="sn-state-badge ${approvalClass}">${escapeHtml(approvalVal)}</span></td>
            <td><span class="sn-state-badge ${stateClass}">${escapeHtml(stateVal)}</span></td>
            <td>${escapeHtml(shortDesc)}</td>
            <td>${scheduleHtml}</td>
            <td>${assignedToHtml}</td>
            <td>${escapeHtml(requestedByName)}</td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('.sn-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const sysId = link.getAttribute('data-sysid');
        openTicketPreview(sysId, 'CHG');
      });
    });

    tbody.querySelectorAll('.sn-assign-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        assignToMe(btn.getAttribute('data-sysid'), btn);
      });
    });
  }

  async function searchTicketByNumber(rawQuery) {
    const query = (rawQuery || '').trim().toUpperCase();
    const msgEl = document.getElementById('sn-hub-search-msg');
    const btnEl = document.getElementById('sn-hub-search-btn');

    if (!query) {
      if (msgEl) msgEl.innerText = 'Please enter a ticket number to search.';
      return;
    }

    const token = getAuthToken();
    if (!token) {
      if (msgEl) msgEl.innerText = 'Session token missing. Please refresh the page.';
      return;
    }

    if (msgEl) msgEl.innerText = '';
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerText = 'Searching...';
    }

    try {
      const headers = { 'Accept': 'application/json', 'X-UserToken': token };
      // Search base task table so CS, INC, CHG, PRB, etc. are all found (even if closed)
      const url = `/api/now/table/task?sysparm_query=${encodeURIComponent(`number=${query}`)}&sysparm_limit=1&sysparm_display_value=all&sysparm_fields=sys_id,number,sys_class_name`;
      const res = await fetch(url, { headers });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = (await res.json()).result || [];

      if (results.length === 0) {
        if (msgEl) msgEl.innerText = `No ticket found matching "${query}".`;
        return;
      }

      const record = results[0];
      const sysId = getRawVal(record.sys_id) || getVal(record.sys_id);
      const number = getVal(record.number) || query;
      const className = getRawVal(record.sys_class_name);
      const prefix = getTicketPrefix(number);

      const forcedType = prefix === 'CHG' ? 'CHG' : prefix;
      openTicketPreview(sysId, forcedType, className);
    } catch (err) {
      console.warn('SN Helper Ticket Search Warning:', err);
      if (msgEl) msgEl.innerText = `Search failed (${err.message}).`;
    } finally {
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.innerText = 'Search Ticket';
      }
    }
  }

  async function openTicketPreview(sysId, forcedType, explicitTable, opts = {}) {
    const token = getAuthToken();
    if (!token) return;
    // Change requests always get a notes side panel; full workspace (bugs/tasks/notes) when asked for
    setPreviewWorkspaceMode(!!opts.workspace || forcedType === 'CHG');

    const modal = document.getElementById('sn-preview-modal');
    const metaGrid = document.getElementById('sn-modal-meta-grid');
    modal.classList.add('show');

    document.getElementById('sn-modal-number').innerText = 'Loading ticket...';
    document.getElementById('sn-modal-prefix').innerText = forcedType || '...';
    metaGrid.innerHTML = '<div style="grid-column: span 2; color: #94a3b8;">Loading metadata from ServiceNow...</div>';
    document.getElementById('sn-modal-short-desc').innerText = 'Loading...';
    document.getElementById('sn-modal-desc').innerText = 'Fetching full description from server...';
    
    const assignBtn = document.getElementById('sn-modal-assign-btn');
    assignBtn.style.display = 'none';

    try {
      const headers = { 'Accept': 'application/json', 'X-UserToken': token };

      if (forcedType === 'CHG') {
        const chgUrl = `/api/now/table/change_request/${sysId}?sysparm_display_value=true`;
        const appUrl = `/api/now/table/sysapproval_approver?sysparm_query=sysapproval=${sysId}&sysparm_display_value=true&sysparm_fields=approver,state,group`;

        const [chgRes, appRes] = await Promise.all([
          fetch(chgUrl, { headers }),
          fetch(appUrl, { headers })
        ]);

        if (!chgRes.ok) throw new Error('Failed to load change request details.');
        const data = (await chgRes.json()).result;

        let approvedByList = [];
        if (appRes.ok) {
          const approvals = (await appRes.json()).result || [];
          approvedByList = approvals
            .filter(a => getVal(a.state).toLowerCase() === 'approved')
            .map(a => getVal(a.approver))
            .filter(Boolean);
        }

        document.getElementById('sn-modal-number').innerText = getVal(data.number);
        document.getElementById('sn-modal-prefix').innerText = 'CHG';
        document.getElementById('sn-modal-short-desc').innerText = getVal(data.short_description) || 'No short description provided.';
        document.getElementById('sn-modal-desc').innerText = getVal(data.description) || 'No description provided for this change.';

        const stateType = `${getVal(data.state) || '—'} (${getVal(data.type) || 'Normal'})`;
        const approvalStatus = getVal(data.approval) || '—';
        const requestedBy = getVal(data.requested_by) || '—';
        const assignedTo = getVal(data.assigned_to) || 'Unassigned';
        const schedStart = getFirstAvailable(data, ['start_date', 'u_requested_start_date', 'work_start']) || 'Not Scheduled';
        const schedEnd = getFirstAvailable(data, ['end_date', 'u_requested_end_date', 'work_end']) || 'Not Scheduled';
        
        const directApprover = getFirstAvailable(data, ['u_approved_by', 'approved_by', 'cab_delegate']);
        const uniqueApprovers = Array.from(new Set([...approvedByList, ...(directApprover ? [directApprover] : [])]));
        const approvedByStr = uniqueApprovers.length > 0 ? uniqueApprovers.join(', ') : (approvalStatus.toLowerCase() === 'approved' ? 'Approved (See History)' : 'Pending / None');

        const parentService = getFirstAvailable(data, ['business_service', 'u_parent_service', 'parent']) || '—';
        const childService = getFirstAvailable(data, ['u_child_service', 'child_service', 'u_sub_service']) || '—';
        const configItem = getFirstAvailable(data, ['cmdb_ci', 'u_configuration_item']) || '—';
        const groupName = getVal(data.assignment_group) || 'Unassigned Group';

        metaGrid.innerHTML = `
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">State & Type</span>
            <span class="sn-preview-meta-val">${escapeHtml(stateType)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Approval Status</span>
            <span class="sn-preview-meta-val">${escapeHtml(approvalStatus)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Requested By</span>
            <span class="sn-preview-meta-val">${escapeHtml(requestedBy)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assigned To</span>
            <span class="sn-preview-meta-val">${escapeHtml(assignedTo)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Scheduled Start</span>
            <span class="sn-preview-meta-val">${escapeHtml(schedStart)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Scheduled End</span>
            <span class="sn-preview-meta-val">${escapeHtml(schedEnd)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Approved By</span>
            <span class="sn-preview-meta-val">${escapeHtml(approvedByStr)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assignment Group</span>
            <span class="sn-preview-meta-val">${escapeHtml(groupName)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Parent / Child Service</span>
            <span class="sn-preview-meta-val">${escapeHtml(parentService)} / ${escapeHtml(childService)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Configuration Item (CI)</span>
            <span class="sn-preview-meta-val">${escapeHtml(configItem)}</span>
          </div>
        `;

        if (!getVal(data.assigned_to)) {
          assignBtn.style.display = 'block';
          assignBtn.innerText = 'Assign to me';
          assignBtn.onclick = async () => {
            await assignToMe(data.sys_id, assignBtn);
            openTicketPreview(sysId, 'CHG', undefined, opts);
          };
        }

        {
          openWorkspacePanel({
            mode: opts.workspace ? 'full' : 'notes',
            number: getVal(data.number),
            sysId: getRawVal(data.sys_id) || sysId,
            table: 'change_request',
            prefix: 'CHG',
            shortDesc: getVal(data.short_description)
          });
        }

        document.getElementById('sn-modal-native-link').onclick = () => {
          window.location.href = `/now/cwf/agent/record/change_request/${data.sys_id}`;
        };

      } else {
        // Resolve the specific child table (sn_customerservice_case or incident) so Account, Caller/Contact, and Service fields are returned
        let targetTable = explicitTable;
        if (!targetTable) {
          const cachedTicket = allTickets.find(t => (getRawVal(t.sys_id) || getVal(t.sys_id)) === sysId);
          if (cachedTicket) {
            const rawClass = getRawVal(cachedTicket.sys_class_name);
            if (rawClass && !rawClass.includes(' ')) targetTable = rawClass;
            else {
              const pref = getTicketPrefix(getVal(cachedTicket.number));
              if (pref === 'CS') targetTable = 'sn_customerservice_case';
              else if (pref === 'INC') targetTable = 'incident';
            }
          }
        }
        if (!targetTable) targetTable = 'task';

        let res = await fetch(`/api/now/table/${targetTable}/${sysId}?sysparm_display_value=true`, { headers });

        // Fallback to base task table if custom table ACL or table name differs
        if (!res.ok && targetTable !== 'task') {
          res = await fetch(`/api/now/table/task/${sysId}?sysparm_display_value=true`, { headers });
        }
        if (!res.ok) throw new Error('Failed to load ticket details.');

        let data = (await res.json()).result;
        const prefix = getTicketPrefix(getVal(data.number));

        // If we initially hit 'task', do a quick follow-up fetch on the child table so Account & Caller/Contact populate
        if (targetTable === 'task' && (prefix === 'CS' || prefix === 'INC')) {
          const childTable = prefix === 'CS' ? 'sn_customerservice_case' : 'incident';
          const childRes = await fetch(`/api/now/table/${childTable}/${sysId}?sysparm_display_value=true`, { headers });
          if (childRes.ok) {
            data = (await childRes.json()).result;
            targetTable = childTable;
          }
        }

        const number = getVal(data.number);
        document.getElementById('sn-modal-number').innerText = number;
        document.getElementById('sn-modal-prefix').innerText = prefix;
        document.getElementById('sn-modal-short-desc').innerText = getVal(data.short_description) || 'No short description provided.';
        document.getElementById('sn-modal-desc').innerText = getVal(data.description) || 'No description provided for this task.';

        const accountName = getFirstAvailable(data, ['account', 'company', 'u_account']) || '—';
        const callerContact = getFirstAvailable(data, ['contact', 'caller_id', 'consumer', 'u_caller', 'opened_by']) || '—';
        const parentService = getFirstAvailable(data, ['business_service', 'u_parent_service', 'product', 'u_product', 'parent']) || '—';
        const childService = getFirstAvailable(data, ['u_child_service', 'child_service', 'u_sub_service']) || '—';

        const stateVal = getVal(data.state) || '—';
        const prioVal = getVal(data.priority) || '—';
        const groupName = getVal(data.assignment_group) || 'Unassigned Group';
        const assignedTo = getVal(data.assigned_to) || 'Unassigned';
        const openedAt = getVal(data.opened_at) || '—';

        metaGrid.innerHTML = `
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Account</span>
            <span class="sn-preview-meta-val">${escapeHtml(accountName)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Caller / Contact</span>
            <span class="sn-preview-meta-val">${escapeHtml(callerContact)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Product (Parent / Child Service)</span>
            <span class="sn-preview-meta-val">${escapeHtml(parentService)} / ${escapeHtml(childService)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">State / Priority</span>
            <span class="sn-preview-meta-val">${escapeHtml(stateVal)} (Priority: ${escapeHtml(prioVal)})</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assignment Group</span>
            <span class="sn-preview-meta-val">${escapeHtml(groupName)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assigned To</span>
            <span class="sn-preview-meta-val">${escapeHtml(assignedTo)}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Opened At</span>
            <span class="sn-preview-meta-val">${escapeHtml(openedAt)}</span>
          </div>
        `;

        const rawAssigned = getVal(data.assigned_to);
        if (!rawAssigned) {
          assignBtn.style.display = 'block';
          assignBtn.innerText = 'Assign to me';
          assignBtn.onclick = async () => {
            await assignToMe(getRawVal(data.sys_id) || sysId, assignBtn);
            openTicketPreview(sysId, prefix, targetTable, opts);
          };
        }

        if (opts.workspace) {
          openWorkspacePanel({
            number,
            sysId: getRawVal(data.sys_id) || sysId,
            table: targetTable,
            prefix,
            shortDesc: getVal(data.short_description)
          });
        }

        // Workspace workspace routes expect 'task' for CS and INC records to resolve properly
        const recordTable = (prefix === 'CS' || prefix === 'INC') ? 'task' : (targetTable || 'task');
        const recordUrl = `/now/cwf/agent/record/${recordTable}/${getRawVal(data.sys_id) || sysId}`;
        document.getElementById('sn-modal-native-link').onclick = () => {
          window.location.href = recordUrl;
        };
      }
    } catch (err) {
      console.warn('SN Helper Preview Warning:', err);
      document.getElementById('sn-modal-number').innerText = 'Error';
      document.getElementById('sn-modal-desc').innerText = `Could not load ticket details: ${err.message}`;
      const wsPanel = document.getElementById('sn-ws-panel');
      if (wsPanel && !workspaceTicket && wsPanel.style.display !== 'none') {
        wsPanel.innerHTML = '<div class="sn-muted" style="padding: 8px;">Notes are unavailable because the ticket could not be loaded.</div>';
      }
    }
  }

  async function assignToMe(sysId, btnElement) {
    const token = getAuthToken();
    const userId = await resolveCurrentUserId();

    if (!token || !userId) {
      alert(`Unable to assign ticket: Session token (${!!token}) or User ID (${!!userId}) missing.`);
      return;
    }

    btnElement.innerText = 'Assigning...';
    btnElement.disabled = true;

    try {
      const response = await fetch(`/api/now/table/task/${sysId}`, {
        method: 'PATCH',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-UserToken': token
        },
        body: JSON.stringify({ assigned_to: userId })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }
      await Promise.all([fetchTickets(), fetchChanges()]);
    } catch (err) {
      console.error('Assignment Error:', err);
      alert(`Error assigning ticket: ${err.message}`);
      btnElement.innerText = 'Assign to me';
      btnElement.disabled = false;
    }
  }

  function saveUserLinksToStorage() {
    localStorage.setItem('sn_helper_user_links', JSON.stringify(userLinks));
    const hubBadge = document.getElementById('sn-hub-links-count');
    if (hubBadge) {
      hubBadge.innerText = `${userLinks.length} Saved`;
      hubBadge.style.background = userLinks.length > 0 ? '#2563eb' : '#334155';
    }
  }

  function normalizeLinkUrl(rawInput) {
    const trimmed = (rawInput || '').trim();
    if (!trimmed) return { href: '#', isLocal: false, displayDomain: '' };

    // Detect Windows drive path (e.g. C:\...) or network UNC path (\\server\...) or file://
    const isWindowsDrive = /^[a-zA-Z]:[\\\/]/.test(trimmed);
    const isUncPath = /^\\\\/.test(trimmed);
    const isFileProtocol = /^file:\/\//i.test(trimmed);

    if (isWindowsDrive || isUncPath || isFileProtocol) {
      let fileUrl = trimmed;
      if (isWindowsDrive) {
        fileUrl = 'file:///' + trimmed.replace(/\\/g, '/');
      } else if (isUncPath) {
        fileUrl = 'file:' + trimmed.replace(/\\/g, '/');
      }
      return {
        href: fileUrl,
        rawPath: trimmed,
        isLocal: true,
        displayDomain: '📁 Local / Network Path'
      };
    }

    // Standard web URL
    let finalUrl = trimmed;
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
      finalUrl = 'https://' + trimmed;
    }

    let domain = finalUrl;
    try {
      const u = new URL(finalUrl);
      domain = u.hostname;
    } catch (e) {}

    return {
      href: finalUrl,
      rawPath: finalUrl,
      isLocal: false,
      displayDomain: `🌐 ${domain}`
    };
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getEnvBadgeClass(label) {
    const clean = (label || '').toLowerCase();
    if (clean.includes('uat') || clean.includes('test') || clean.includes('pre') || clean.includes('stag')) return 'sn-env-uat';
    if (clean.includes('dev') || clean.includes('sandbox')) return 'sn-env-dev';
    if (clean.includes('dr') || clean.includes('backup') || clean.includes('failover')) return 'sn-env-dr';
    if (clean.includes('prod') || clean.includes('live')) return 'sn-env-prod';
    return 'sn-env-other';
  }

  // Combine your default options with any custom ones the user has previously saved
  const DEFAULT_LINK_CATEGORIES = ['Applications', 'Documentation', 'Local Tools', 'Admin Portals'];
  const DEFAULT_ENV_LABELS = ['UAT', 'Pre-Prod', 'DEV', 'TEST', 'Staging', 'DR'];

  function updateLinkAutocompleteLists() {
    const catList = document.getElementById('sn-link-cat-suggestions');
    const envList = document.getElementById('sn-env-label-suggestions');

    const knownCategories = new Set(DEFAULT_LINK_CATEGORIES);
    const knownEnvs = new Set(DEFAULT_ENV_LABELS);

    userLinks.forEach(link => {
      const cat = (link.category || '').trim();
      if (cat) knownCategories.add(cat);

      if (Array.isArray(link.altUrls)) {
        link.altUrls.forEach(alt => {
          const envLabel = (alt.label || '').trim();
          if (envLabel) knownEnvs.add(envLabel);
        });
      }
    });

    if (catList) {
      catList.innerHTML = Array.from(knownCategories)
        .sort((a, b) => a.localeCompare(b))
        .map(c => `<option value="${escapeHtml(c)}"></option>`)
        .join('');
    }

    if (envList) {
      envList.innerHTML = Array.from(knownEnvs)
        .sort((a, b) => a.localeCompare(b))
        .map(e => `<option value="${escapeHtml(e)}"></option>`)
        .join('');
    }
  }

  function addAltUrlRow(labelVal = '', urlVal = '') {
    const container = document.getElementById('sn-alt-urls-rows');
    if (!container) return;

    // Refresh suggestions so any newly typed environments in other rows or saved links are included
    updateLinkAutocompleteLists();

    const row = document.createElement('div');
    row.className = 'sn-alt-url-row';
    row.innerHTML = `
      <input type="text" class="sn-links-input sn-alt-env-label" placeholder="Env (click for list)" value="${escapeHtml(labelVal)}" list="sn-env-label-suggestions" autocomplete="off" />
      <input type="text" class="sn-links-input sn-alt-env-url" placeholder="Environment URL or Local Path..." value="${escapeHtml(urlVal)}" />
      <button type="button" class="sn-link-icon-btn danger sn-remove-alt-row" title="Remove environment" style="padding: 8px 10px;">&times;</button>
    `;

    row.querySelector('.sn-remove-alt-row').addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  function initLinksManagerEvents() {
    const saveBtn = document.getElementById('sn-link-save-btn');
    const cancelEditBtn = document.getElementById('sn-links-cancel-edit');
    const toggleFormBtn = document.getElementById('sn-toggle-form-btn');
    const formCard = document.getElementById('sn-links-form-card');
    const addEnvBtn = document.getElementById('sn-add-alt-url-btn');
    const altRowsContainer = document.getElementById('sn-alt-urls-rows');
    const searchInput = document.getElementById('sn-links-search');
    const exportBtn = document.getElementById('sn-links-export-btn');
    const importBtn = document.getElementById('sn-links-import-btn');
    const importInput = document.getElementById('sn-links-import-input');

    const nameInput = document.getElementById('sn-link-name');
    const urlInput = document.getElementById('sn-link-url');
    const catInput = document.getElementById('sn-link-category');
    const noteInput = document.getElementById('sn-link-note');

    if (toggleFormBtn && formCard) {
      toggleFormBtn.addEventListener('click', () => {
        const isHidden = formCard.classList.contains('sn-hidden');
        if (isHidden) {
          formCard.classList.remove('sn-hidden');
          toggleFormBtn.innerText = '✕ Close Form';
          if (nameInput) nameInput.focus();
        } else {
          formCard.classList.add('sn-hidden');
          toggleFormBtn.innerText = '➕ Add New Link or Tool';
        }
      });
    }

    if (addEnvBtn) {
      addEnvBtn.addEventListener('click', () => addAltUrlRow('', ''));
    }

    const resetForm = () => {
      editingLinkId = null;
      if (nameInput) nameInput.value = '';
      if (urlInput) urlInput.value = '';
      if (catInput) catInput.value = '';
      if (noteInput) noteInput.value = '';
      if (altRowsContainer) altRowsContainer.innerHTML = '';
      if (formCard) formCard.classList.add('sn-hidden');
      if (toggleFormBtn) toggleFormBtn.innerText = '➕ Add New Link or Tool';
      const heading = document.getElementById('sn-links-form-heading');
      if (heading) heading.innerText = '➕ Add New Link or Tool';
      if (saveBtn) saveBtn.innerText = 'Save Link';
      if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    };

    const handleSave = () => {
      const name = (nameInput?.value || '').trim();
      const url = (urlInput?.value || '').trim();
      const category = (catInput?.value || '').trim() || 'General';
      const note = (noteInput?.value || '').trim();

      if (!name || !url) {
        alert('Please enter both a Name and a Primary URL / File Path.');
        return;
      }

      const altUrls = [];
      if (altRowsContainer) {
        altRowsContainer.querySelectorAll('.sn-alt-url-row').forEach(row => {
          const l = (row.querySelector('.sn-alt-env-label')?.value || '').trim() || 'ALT';
          const u = (row.querySelector('.sn-alt-env-url')?.value || '').trim();
          if (u) altUrls.push({ label: l, url: u });
        });
      }

      if (editingLinkId) {
        const idx = userLinks.findIndex(l => l.id === editingLinkId);
        if (idx !== -1) {
          userLinks[idx] = { ...userLinks[idx], name, url, category, note, altUrls };
        }
      } else {
        userLinks.push({
          id: 'lnk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name,
          url,
          category,
          note,
          altUrls,
          favourite: false,
		  clickCount: 0,
          createdAt: Date.now()
        });
      }

      saveUserLinksToStorage();
      resetForm();
      renderUserLinks();
    };

    if (saveBtn) saveBtn.addEventListener('click', handleSave);
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', resetForm);

    [nameInput, urlInput, catInput, noteInput].forEach(inp => {
      if (inp) {
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
          }
        });
      }
    });

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        linkSearchQuery = (e.target.value || '').toLowerCase().trim();
        renderUserLinks();
      });
    }

    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(userLinks, null, 2));
        const a = document.createElement('a');
        a.setAttribute('href', dataStr);
        a.setAttribute('download', `SupportHub_Links_${new Date().toISOString().slice(0, 10)}.json`);
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    }

    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            if (!Array.isArray(imported)) throw new Error('Invalid JSON format');
            userLinks = imported;
            saveUserLinksToStorage();
            renderUserLinks();
          } catch (err) {
            alert('Could not import links JSON: ' + err.message);
          }
        };
        reader.readAsText(file);
        importInput.value = '';
      });
    }

    // Expose open-form helper for Edit button triggers
    window.snOpenLinkFormForEdit = (item) => {
      if (formCard) formCard.classList.remove('sn-hidden');
      if (toggleFormBtn) toggleFormBtn.innerText = '✕ Close Form';
      editingLinkId = item.id;
      if (nameInput) nameInput.value = item.name || '';
      if (urlInput) urlInput.value = item.url || '';
      if (catInput) catInput.value = item.category || '';
      if (noteInput) noteInput.value = item.note || '';

      if (altRowsContainer) {
        altRowsContainer.innerHTML = '';
        if (Array.isArray(item.altUrls)) {
          item.altUrls.forEach(alt => addAltUrlRow(alt.label, alt.url));
        }
      }

      const heading = document.getElementById('sn-links-form-heading');
      if (heading) heading.innerText = `✏️ Editing: ${item.name}`;
      if (saveBtn) saveBtn.innerText = 'Update Link';
      if (cancelEditBtn) cancelEditBtn.style.display = 'inline-block';
      if (nameInput) nameInput.focus();
    };
  }

  function renderUserLinks() {
    saveUserLinksToStorage();
    updateLinkAutocompleteLists();
    const grid = document.getElementById('sn-links-grid');
    const catBar = document.getElementById('sn-links-categories-bar');
    if (!grid || !catBar) return;

    const categories = Array.from(new Set(userLinks.map(l => (l.category || 'General').trim()))).sort((a, b) => a.localeCompare(b));
    if (selectedLinkCategory !== 'ALL' && !categories.includes(selectedLinkCategory)) {
      selectedLinkCategory = 'ALL';
    }

    let catHtml = `<button class="sn-cat-pill ${selectedLinkCategory === 'ALL' ? 'active' : ''}" data-cat="ALL">All (${userLinks.length})</button>`;
    categories.forEach(c => {
      const count = userLinks.filter(l => (l.category || 'General').trim() === c).length;
      catHtml += `<button class="sn-cat-pill ${selectedLinkCategory === c ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} (${count})</button>`;
    });
    catBar.innerHTML = catHtml;

    catBar.querySelectorAll('.sn-cat-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedLinkCategory = btn.getAttribute('data-cat');
        renderUserLinks();
      });
    });

    const filtered = userLinks.filter(l => {
      const cat = (l.category || 'General').trim();
      if (selectedLinkCategory !== 'ALL' && cat !== selectedLinkCategory) return false;
      if (linkSearchQuery) {
        const altText = Array.isArray(l.altUrls) ? l.altUrls.map(a => `${a.label} ${a.url}`).join(' ') : '';
        const hay = `${l.name} ${l.note} ${l.url} ${cat} ${altText}`.toLowerCase();
        return hay.includes(linkSearchQuery);
      }
      return true;
    });

    // SORTING: Favourites first, then newest/alphabetical
    // SORTING: Favourites first, then highest click count (most used), then newest fallback
    filtered.sort((a, b) => {
      const favA = a.favourite ? 1 : 0;
      const favB = b.favourite ? 1 : 0;
      if (favA !== favB) return favB - favA; // Favourites to top

      const countA = a.clickCount || 0;
      const countB = b.clickCount || 0;
      if (countA !== countB) return countB - countA; // Highest usage first

      return (b.createdAt || 0) - (a.createdAt || 0); // Newest fallback
    });

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; background: #1e293b; border: 1px dashed #334155; border-radius: 10px; color: #94a3b8;">
          ${userLinks.length === 0
            ? '<strong>No personal links saved yet.</strong><br>Use the form above to add your favourite tools, portals, documentation, or local file paths.'
            : 'No links match your current filter.'}
        </div>
      `;
      return;
    }

    grid.innerHTML = filtered.map(l => {
      const info = normalizeLinkUrl(l.url);
      const hasAlts = Array.isArray(l.altUrls) && l.altUrls.length > 0;
      const isFav = !!l.favourite;
      const noteHtml = l.note
        ? `<p class="sn-link-note">${escapeHtml(l.note)}</p>`
        : `<p class="sn-link-note" style="color: #64748b; font-style: italic;">No note added</p>`;

      // Render alternate environment / sub-path badges if present
      let altBadgesHtml = '';
      if (hasAlts) {
        const pills = l.altUrls.map(alt => {
          const altInfo = normalizeLinkUrl(alt.url);
          const badgeClass = getEnvBadgeClass(alt.label);
          return `
            <div class="sn-env-pill-group">
              <a class="sn-env-launch ${badgeClass} sn-launch-link" href="${escapeHtml(altInfo.href)}" target="_blank" rel="noopener noreferrer" data-link-id="${l.id}" data-local="${altInfo.isLocal}" data-raw="${escapeHtml(altInfo.rawPath)}" title="Open ${escapeHtml(alt.label)}: ${escapeHtml(alt.url)}">
                <span>${escapeHtml(alt.label)}</span>
                <span>↗</span>
              </a>
              <button type="button" class="sn-env-copy sn-copy-link-btn" data-raw="${escapeHtml(altInfo.rawPath)}" title="Copy ${escapeHtml(alt.label)} URL/Path">📋</button>
            </div>
          `;
        }).join('');
        altBadgesHtml = `<div class="sn-env-badges-wrap">${pills}</div>`;
      }

      return `
        <div class="sn-link-card ${info.isLocal ? 'sn-local-file-card' : ''} ${isFav ? 'sn-is-favourite' : ''}">
          <div>
            <div class="sn-link-card-top">
              <div style="display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;">
                <button type="button" class="sn-fav-btn ${isFav ? 'is-active' : ''} sn-toggle-fav-btn" data-id="${l.id}" title="${isFav ? 'Unpin from top' : 'Pin to top'}">⭐</button>
                <a class="sn-link-title-anchor sn-launch-link" href="${escapeHtml(info.href)}" target="_blank" rel="noopener noreferrer" data-link-id="${l.id}" data-id="${l.id}" data-local="${info.isLocal}" data-raw="${escapeHtml(info.rawPath)}" title="${escapeHtml(l.url)}" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  <span>${escapeHtml(l.name)}</span>
                  <span style="font-size: 12px;">↗</span>
                </a>
              </div>
              <span class="sn-link-cat-badge" style="flex-shrink: 0;">${escapeHtml(l.category || 'General')}</span>
            </div>
            ${altBadgesHtml}
            <div style="margin-top: 8px;">
              ${noteHtml}
            </div>
          </div>

          <div class="sn-link-card-footer">
            <span class="sn-link-domain" title="${escapeHtml(l.url)}">${escapeHtml(info.displayDomain)}</span>
            <div class="sn-link-actions">
              <button class="sn-link-icon-btn sn-copy-link-btn" data-raw="${escapeHtml(info.rawPath)}" title="Copy Primary URL / Path">Copy</button>
              <button class="sn-link-icon-btn sn-edit-link-btn" data-id="${l.id}" title="Edit">Edit</button>
              <button class="sn-link-icon-btn danger sn-del-link-btn" data-id="${l.id}" title="Delete">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Event listener for toggling favourite status
    grid.querySelectorAll('.sn-toggle-fav-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const item = userLinks.find(x => x.id === id);
        if (item) {
          item.favourite = !item.favourite;
          saveUserLinksToStorage();
          renderUserLinks();
        }
      });
    });
	
	// Track clicks on links to sort by frequency of use
    grid.querySelectorAll('.sn-launch-link').forEach(a => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('data-link-id');
        if (id) {
          const item = userLinks.find(x => x.id === id);
          if (item) {
            item.clickCount = (item.clickCount || 0) + 1;
            saveUserLinksToStorage();
          }
        }

        if (a.getAttribute('data-local') === 'true') {
          e.preventDefault();
          const rawPath = a.getAttribute('data-raw');
          navigator.clipboard.writeText(rawPath).then(() => {
            const container = document.getElementById('sn-toast-container');
            if (container) {
              const t = document.createElement('div');
              t.className = 'sn-toast';
              t.style.borderLeftColor = '#eab308';
              t.innerHTML = `
                <div class="sn-toast-header"><span>📁 Local Path Copied!</span></div>
                <div class="sn-toast-desc">Browsers block direct local file execution from web tabs. Path copied to clipboard:<br><code style="color:#fde047;">${escapeHtml(rawPath)}</code><br>Press <strong>Win + R</strong> and <strong>Ctrl + V</strong> to open immediately.</div>
              `;
              container.appendChild(t);
              setTimeout(() => { if (t.parentNode) t.remove(); }, 7000);
            }
          });
        }
      });
    });

    grid.querySelectorAll('.sn-copy-link-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const raw = btn.getAttribute('data-raw');
        navigator.clipboard.writeText(raw);
        const orig = btn.innerText;
        btn.innerText = orig === '📋' ? '✓' : 'Copied!';
        setTimeout(() => { btn.innerText = orig; }, 1500);
      });
    });

    grid.querySelectorAll('.sn-edit-link-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const item = userLinks.find(x => x.id === id);
        if (item && typeof window.snOpenLinkFormForEdit === 'function') {
          window.snOpenLinkFormForEdit(item);
        }
      });
    });

    grid.querySelectorAll('.sn-del-link-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const item = userLinks.find(x => x.id === id);
        if (item && confirm(`Delete "${item.name}" from your saved links?`)) {
          userLinks = userLinks.filter(x => x.id !== id);
          saveUserLinksToStorage();
          renderUserLinks();
        }
      });
    });
  }

  // =====================================================================
  // ASSIGNED TO ME • TICKET NOTES & TASKS • KNOWN BUGS
  // All personal data is stored in this browser (localStorage).
  // =====================================================================
  const BUG_STATUS_LABEL = { open: 'Open', fixing: 'Fix in progress', resolved: 'Resolved' };
  const TASK_REMINDER_CHECK_MS = 15000;
  const TASK_REMINDER_MAX_LATE_MS = 6 * 60 * 60 * 1000; // don't fire reminders more than 6h late
  const TASK_DATE_ONLY_REMINDER_HOUR = 9;
  const BUGS_KEY = 'sn_helper_known_bugs';
  const TICKET_DATA_KEY = 'sn_helper_ticket_data';

  // The old To-Do list was retired in favour of per-ticket tasks
  try { localStorage.removeItem('sn_helper_todos'); } catch (e) {}

  function loadStoredJson(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function loadKnownBugs() {
    const v = loadStoredJson(BUGS_KEY, []);
    return Array.isArray(v) ? v : [];
  }

  function loadTicketData() {
    const v = loadStoredJson(TICKET_DATA_KEY, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  let knownBugs = loadKnownBugs();
  let ticketData = loadTicketData(); // { [NUMBER]: { sysId, table, prefix, shortDesc, bugIds[], notes[], tasks[] } }
  let myTickets = [];
  let myTicketsLoaded = false;
  let myTicketsError = '';
  let myTicketsInFlight = false;
  let liveTicketStates = {}; // NUMBER -> { state, closed }
  let workspaceTicket = null; // ticket currently open in the pop-up's side panel
  let mineTypeFilter = localStorage.getItem('sn_helper_mine_type') || 'ALL';
  let mineBugFilter = localStorage.getItem('sn_helper_mine_bug') || 'ALL';
  let bugsStatusFilter = localStorage.getItem('sn_helper_bugs_filter') || 'active'; // active | resolved | all
  let editingBugId = null;

  // ----- small helpers -----
  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  function normNumber(n) {
    return (getVal(n) || '').trim().toUpperCase();
  }

  function isClosedTicketState(stateText, activeRaw) {
    const st = (stateText || '').toLowerCase();
    return String(activeRaw).toLowerCase() === 'false' || /resolved|closed|cancel|complete/.test(st);
  }

  function formatTimestamp(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function showSimpleToast(title, desc, accent, action) {
    const container = document.getElementById('sn-toast-container');
    if (!container) return;
    const t = document.createElement('div');
    t.className = 'sn-toast';
    if (accent) t.style.borderLeftColor = accent;
    t.innerHTML = `
      <div class="sn-toast-header">
        <span>${escapeHtml(title)}</span>
        <button class="sn-toast-close" title="Dismiss">&times;</button>
      </div>
      ${desc ? `<div class="sn-toast-desc">${escapeHtml(desc)}</div>` : ''}
      ${action ? `<div class="sn-toast-cta">${escapeHtml(action.label)}</div>` : ''}
    `;
    t.querySelector('.sn-toast-close').addEventListener('click', (e) => {
      e.stopPropagation();
      t.remove();
    });
    t.addEventListener('click', () => {
      if (action) action.onClick();
      t.remove();
    });
    container.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.remove(); }, 8000);
  }

  function showOverlay() {
    const overlay = document.getElementById('sn-helper-overlay');
    const toggleBtn = document.getElementById('sn-helper-toggle');
    if (overlay && overlay.classList.contains('sn-hidden')) {
      overlay.classList.remove('sn-hidden');
      if (toggleBtn) toggleBtn.innerText = 'Hide Support Hub';
    }
  }

  // ----- persistence -----
  function getTicketEntry(number, create) {
    const n = normNumber(number);
    if (!n) return null;
    if (!ticketData[n] && create) ticketData[n] = { bugIds: [], notes: [], tasks: [] };
    const e = ticketData[n];
    if (e) {
      e.bugIds = Array.isArray(e.bugIds) ? e.bugIds : [];
      e.notes = Array.isArray(e.notes) ? e.notes : [];
      e.tasks = Array.isArray(e.tasks) ? e.tasks : [];
    }
    return e || null;
  }

  function rememberTicketSnapshot(entry, info) {
    if (!entry || !info) return;
    if (info.sysId) entry.sysId = info.sysId;
    if (info.table) entry.table = info.table;
    if (info.prefix) entry.prefix = info.prefix;
    if (info.shortDesc) entry.shortDesc = info.shortDesc;
  }

  function pruneTicketData() {
    Object.keys(ticketData).forEach((n) => {
      const e = ticketData[n];
      if (!e || (!(e.bugIds || []).length && !(e.notes || []).length && !(e.tasks || []).length)) delete ticketData[n];
    });
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      alert('Could not save (browser storage may be full).');
    }
  }

  function saveTicketData() {
    pruneTicketData();
    persist(TICKET_DATA_KEY, ticketData);
    afterPersonalDataChange();
  }

  function saveKnownBugs() {
    persist(BUGS_KEY, knownBugs);
    afterPersonalDataChange();
  }

  function afterPersonalDataChange() {
    try { applyChangeFiltersAndRender(); } catch (e) {}
    try { renderUpcomingUserChanges(); } catch (e) {}
    renderMineHubTile();
    renderBugsHubTile();
    if (currentView === 'mine') renderMineTable();
    if (currentView === 'bugs') renderBugs();
    if (workspaceTicket) renderWorkspacePanel();
  }

  function initPersonalDataCrossTabSync() {
    window.addEventListener('storage', (e) => {
      if (e.key === TICKET_DATA_KEY) ticketData = loadTicketData();
      else if (e.key === BUGS_KEY) knownBugs = loadKnownBugs();
      else return;
      afterPersonalDataChange();
    });
  }

  // ----- tasks: due dates & reminders -----
  function getTaskDueTime(task) {
    if (!task.dueDate) return null;
    const [y, m, d] = task.dueDate.split('-').map(Number);
    if (!y || !m || !d) return null;
    if (task.dueTime) {
      const [hh, mm] = task.dueTime.split(':').map(Number);
      return new Date(y, m - 1, d, hh || 0, mm || 0).getTime();
    }
    return new Date(y, m - 1, d, 23, 59, 59).getTime();
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }

  // { text, plain, status } where status is overdue | today | soon | later | none
  function describeTaskDue(task) {
    const dueTs = getTaskDueTime(task);
    if (dueTs === null) return { text: 'No due date', plain: 'No due date', status: 'none' };
    const [y, m, d] = task.dueDate.split('-').map(Number);
    const dueDay = new Date(y, m - 1, d);
    const dayDiff = Math.round((startOfDay(dueDay) - startOfDay(new Date())) / 86400000);
    let dayText;
    if (dayDiff === 0) dayText = 'Today';
    else if (dayDiff === 1) dayText = 'Tomorrow';
    else if (dayDiff === -1) dayText = 'Yesterday';
    else {
      dayText = dueDay.toLocaleDateString('en-GB', {
        weekday: 'short', day: 'numeric', month: 'short',
        year: dueDay.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
      });
    }
    const plain = `${dayText}${task.dueTime ? ` ${task.dueTime}` : ''}`;
    if (dueTs < Date.now()) return { text: `Overdue · ${plain}`, plain, status: 'overdue' };
    if (dayDiff === 0) return { text: plain, plain, status: 'today' };
    if (dayDiff === 1) return { text: plain, plain, status: 'soon' };
    return { text: plain, plain, status: 'later' };
  }

  function getTaskReminderTime(task) {
    const reminder = task.reminder ?? '0';
    if (reminder === 'none' || !task.dueDate) return null;
    const [y, m, d] = task.dueDate.split('-').map(Number);
    if (!y || !m || !d) return null;
    let base;
    if (task.dueTime) {
      const [hh, mm] = task.dueTime.split(':').map(Number);
      base = new Date(y, m - 1, d, hh || 0, mm || 0).getTime();
    } else {
      base = new Date(y, m - 1, d, TASK_DATE_ONLY_REMINDER_HOUR, 0).getTime();
    }
    return base - (parseInt(reminder, 10) || 0) * 60000;
  }

  function reminderKey(task) {
    return `${task.dueDate || ''}|${task.dueTime || ''}|${task.reminder ?? '0'}`;
  }

  function compareTasks(a, b) {
    const da = getTaskDueTime(a);
    const db = getTaskDueTime(b);
    if (da !== null && db === null) return -1;
    if (da === null && db !== null) return 1;
    if (da !== null && db !== null && da !== db) return da - db;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }

  function getAllOpenTasks() {
    const list = [];
    Object.keys(ticketData).forEach((number) => {
      (ticketData[number].tasks || []).forEach((t) => {
        if (!t.done) list.push({ ...t, number });
      });
    });
    return list.sort(compareTasks);
  }

  function fireTaskReminder(task) {
    playNotificationSound();
    const due = describeTaskDue(task);
    const dueTs = getTaskDueTime(task);
    const minsToDue = dueTs === null ? null : Math.round((dueTs - Date.now()) / 60000);
    let header;
    if (!task.dueTime) header = '⏰ Task due today';
    else if (minsToDue !== null && minsToDue > 90) header = `⏰ Task due ${due.plain}`;
    else if (minsToDue !== null && minsToDue > 1) header = `⏰ Task due in ${minsToDue} min`;
    else if (minsToDue !== null && minsToDue >= -5) header = '⏰ Task due now';
    else header = '⏰ Task overdue';
    const when = header.includes('overdue') ? due.text : due.plain;

    const openIt = () => {
      showOverlay();
      switchView('mine');
      openWorkspaceForNumber(task.number);
    };
    showSimpleToast(header, `${task.title} — ${when} (${task.number})`, '#a855f7', {
      label: `Click to open ${task.number} →`,
      onClick: openIt
    });

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(`${header}: ${task.title}`, {
        body: `${when} • ${task.number}`,
        tag: `task_${task.id}`
      });
      n.onclick = () => {
        window.focus();
        openIt();
        n.close();
      };
    }
  }

  // Only one ServiceNow tab checks at a time, so each reminder fires once
  function checkTaskReminders() {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
      navigator.locks.request('sn_helper_task_reminders', async () => {
        runTaskReminderCheck();
      }).catch(() => runTaskReminderCheck());
    } else {
      runTaskReminderCheck();
    }
  }

  function runTaskReminderCheck() {
    // Re-read storage so a reminder another tab already fired isn't repeated
    ticketData = loadTicketData();
    const now = Date.now();
    const due = [];
    let changed = false;

    Object.keys(ticketData).forEach((number) => {
      (ticketData[number].tasks || []).forEach((t) => {
        if (t.done) return;
        const ts = getTaskReminderTime(t);
        if (ts === null || now < ts) return;
        const key = reminderKey(t);
        if (t.reminderFiredKey === key) return;
        t.reminderFiredKey = key;
        changed = true;
        if (now - ts <= TASK_REMINDER_MAX_LATE_MS) due.push({ ...t, number });
      });
    });

    if (!changed) return;
    saveTicketData(); // claim first, then notify
    due.slice(0, 3).forEach(fireTaskReminder);
    if (due.length > 3) {
      showSimpleToast('⏰ More reminders', `${due.length - 3} more task(s) are due. Open Assigned to Me to see them.`, '#a855f7');
    }
  }

  // ----- data from ServiceNow -----
  async function fetchMyTickets() {
    const token = getAuthToken();
    if (!token || myTicketsInFlight) return;
    myTicketsInFlight = true;
    try {
      const userId = await resolveCurrentUserId();
      if (!userId) {
        myTicketsError = 'Could not identify the current user. Try refreshing the page.';
        renderMineTable();
        return;
      }
      const fields = 'sys_id,number,priority,state,short_description,assignment_group,opened_at,sys_updated_on,sys_class_name,active';
      const q = `active=true^assigned_to=${userId}^numberSTARTSWITHCS^numberNOT LIKECSTASK^NQactive=true^assigned_to=${userId}^numberSTARTSWITHINC^ORDERBYDESCsys_updated_on`;
      const url = `/api/now/table/task?sysparm_query=${encodeURIComponent(q)}&sysparm_limit=500&sysparm_display_value=all&sysparm_fields=${fields}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json', 'X-UserToken': token } });
      if (res.status === 401 || res.status === 403) {
        myTicketsError = 'Session expired or unauthorized. Please log in or refresh the page.';
        renderMineTable();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()).result || [];

      myTickets = rows
        .map((r) => ({
          sysId: getRawVal(r.sys_id),
          number: normNumber(r.number),
          priority: getVal(r.priority),
          state: getVal(r.state),
          stateValue: getRawVal(r.state),
          active: getRawVal(r.active),
          shortDesc: getVal(r.short_description),
          group: getVal(r.assignment_group),
          opened: getVal(r.opened_at),
          openedRaw: (r.opened_at && typeof r.opened_at === 'object') ? (r.opened_at.value || '') : '',
          updated: getVal(r.sys_updated_on),
          table: getRawVal(r.sys_class_name)
        }))
        .filter((t) => t.number && !isClosedTicketState(t.state, t.active));

      // Keep stored snapshots fresh for tickets we hold notes/tasks/bugs on
      let snapshotChanged = false;
      myTickets.forEach((t) => {
        liveTicketStates[t.number] = { state: t.state, closed: false };
        const e = ticketData[t.number];
        if (e && (e.shortDesc !== t.shortDesc || e.sysId !== t.sysId)) {
          rememberTicketSnapshot(e, { sysId: t.sysId, table: t.table, prefix: getTicketPrefix(t.number), shortDesc: t.shortDesc });
          snapshotChanged = true;
        }
      });
      if (snapshotChanged) persist(TICKET_DATA_KEY, ticketData);

      await ensureStateChoices();
      await updateOpenSince(myTickets);

      myTicketsLoaded = true;
      myTicketsError = '';
    } catch (err) {
      myTicketsError = `Connection issue (${err.message}). Retrying...`;
    } finally {
      myTicketsInFlight = false;
    }
    renderMineTable();
    renderMineHubTile();
  }

  let liveStateInFlight = false;
  async function refreshLiveTicketStates() {
    const token = getAuthToken();
    if (!token || liveStateInFlight) return;
    const numbers = Object.keys(ticketData).filter((n) => /^[A-Z]+\d+$/.test(n)).slice(0, 150);
    if (numbers.length === 0) return;
    liveStateInFlight = true;
    try {
      const url = `/api/now/table/task?sysparm_query=${encodeURIComponent(`numberIN${numbers.join(',')}`)}&sysparm_limit=${numbers.length}&sysparm_display_value=all&sysparm_fields=sys_id,number,state,active,short_description,sys_class_name`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json', 'X-UserToken': token } });
      if (!res.ok) return;
      const rows = (await res.json()).result || [];
      let snapshotChanged = false;
      rows.forEach((r) => {
        const num = normNumber(r.number);
        if (!num) return;
        const state = getVal(r.state);
        liveTicketStates[num] = { state, closed: isClosedTicketState(state, getRawVal(r.active)) };
        const e = ticketData[num];
        if (e && (!e.sysId || !e.shortDesc)) {
          rememberTicketSnapshot(e, { sysId: getRawVal(r.sys_id), table: getRawVal(r.sys_class_name), prefix: getTicketPrefix(num), shortDesc: getVal(r.short_description) });
          snapshotChanged = true;
        }
      });
      if (snapshotChanged) persist(TICKET_DATA_KEY, ticketData);
      if (currentView === 'bugs') renderBugs();
      if (workspaceTicket) renderWorkspacePanel();
    } catch (e) {
      console.warn('SN Helper live state warning:', e.message);
    } finally {
      liveStateInFlight = false;
    }
  }

  // Open the pop-up with the side panel for a ticket number (looks up the sys_id if needed)
  async function openWorkspaceForNumber(rawNumber) {
    const number = normNumber(rawNumber);
    if (!number) return;
    const mine = myTickets.find((t) => t.number === number);
    const stored = ticketData[number];
    const sysId = mine?.sysId || stored?.sysId;
    const table = mine?.table || stored?.table;
    const prefix = getTicketPrefix(number);
    if (sysId) {
      openTicketPreview(sysId, prefix === 'CHG' ? 'CHG' : prefix, table, { workspace: true });
      return;
    }
    const token = getAuthToken();
    if (!token) return;
    try {
      const url = `/api/now/table/task?sysparm_query=${encodeURIComponent(`number=${number}`)}&sysparm_limit=1&sysparm_display_value=all&sysparm_fields=sys_id,number,sys_class_name`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json', 'X-UserToken': token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rec = ((await res.json()).result || [])[0];
      if (!rec) {
        showSimpleToast('Ticket not found', `No ticket found matching "${number}".`, '#f87171');
        return;
      }
      openTicketPreview(getRawVal(rec.sys_id), prefix === 'CHG' ? 'CHG' : prefix, getRawVal(rec.sys_class_name), { workspace: true });
    } catch (err) {
      showSimpleToast('Ticket lookup failed', err.message, '#f87171');
    }
  }

  // ----- hub tiles -----
  function renderMineHubTile() {
    const badge = document.getElementById('sn-hub-mine-count');
    const preview = document.getElementById('sn-hub-mine-preview');
    if (!badge || !preview) return;

    const openTasks = getAllOpenTasks();
    const overdue = openTasks.filter((t) => describeTaskDue(t).status === 'overdue').length;
    badge.innerText = myTicketsLoaded ? `${myTickets.length} Open` : '…';
    badge.style.background = overdue > 0 ? '#dc2626' : (myTickets.length > 0 ? '#2563eb' : '#334155');

    if (openTasks.length > 0) {
      const next = openTasks[0];
      const due = describeTaskDue(next);
      const more = openTasks.length - 1;
      preview.innerHTML = `
        <div class="sn-tile-label">Next task${overdue > 0 ? ` · <span class="sn-tile-alert">${overdue} overdue</span>` : ''}</div>
        <div class="sn-tile-title">${escapeHtml(next.title)}</div>
        <div class="sn-tile-meta">
          <span class="sn-pill sn-due-${due.status}">${escapeHtml(due.text)}</span>
          <span class="sn-pill sn-pill-ticket">${escapeHtml(next.number)}</span>
        </div>
        ${more > 0 ? `<div class="sn-tile-more">+ ${more} more open task${more === 1 ? '' : 's'}</div>` : ''}
      `;
      return;
    }

    if (!myTicketsLoaded) return;
    const withBug = myTickets.filter((t) => (ticketData[t.number]?.bugIds || []).length > 0).length;
    const withNotes = myTickets.filter((t) => (ticketData[t.number]?.notes || []).length > 0).length;
    preview.innerHTML = myTickets.length === 0
      ? `<p class="sn-hub-tool-desc">No open CS or INC tickets assigned to you right now. 🎉</p>`
      : `<p class="sn-hub-tool-desc">${myTickets.length} open ticket${myTickets.length === 1 ? '' : 's'} • ${withBug} linked to a known bug • ${withNotes} with notes. No open tasks.</p>`;
  }

  function getBugTicketNumbers(bugId) {
    return Object.keys(ticketData).filter((n) => (ticketData[n].bugIds || []).includes(bugId));
  }

  function renderBugsHubTile() {
    const badge = document.getElementById('sn-hub-bugs-count');
    const preview = document.getElementById('sn-hub-bugs-preview');
    if (!badge || !preview) return;
    const active = knownBugs.filter((b) => b.status !== 'resolved');
    badge.innerText = `${active.length} Active`;
    badge.style.background = active.length > 0 ? '#b45309' : '#334155';

    if (active.length === 0) {
      preview.innerHTML = `<p class="sn-hub-tool-desc">Track recurring issues and see every ticket reporting the same bug.</p>`;
      return;
    }
    const top = active
      .map((b) => ({ b, count: getBugTicketNumbers(b.id).length }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 2);
    preview.innerHTML = `
      <div class="sn-tile-label">Most reported</div>
      ${top.map(({ b, count }) => `
        <div class="sn-tile-bug-row">
          <span class="sn-tile-bug-title">${escapeHtml(b.title)}</span>
          <span class="sn-pill sn-pill-count">${count} ticket${count === 1 ? '' : 's'}</span>
        </div>`).join('')}
    `;
  }


  // =====================================================================
  // Password Expiry page (MAIN world). Data lives in the extension's storage, reached through the
  // ISOLATED-world bridge, so the reset-page bar on other sites can update it too.
  // =====================================================================
  let pwAccounts = [];
  let pwDetect = { enabled: false };
  let pwStatus = null; // { enabled, access, registered, pageAvailable } from the background
  let pwBridgeOk = null; // null = not tried yet
  let pwFilter = 'all';
  let pwEditingId = null;

  const pwBridge = (() => {
    const pending = new Map();
    window.addEventListener('message', (e) => {
      if (e.source !== window || !e.data) return;
      if (e.data.__snsimp === 'res') {
        const done = pending.get(e.data.id);
        if (done) { pending.delete(e.data.id); done(e.data); }
      } else if (e.data.__snsimp === 'changed') {
        loadPwData().then(() => { if ((e.data.keys || []).includes('pwDetect')) refreshPwStatus(); });
      }
    });
    function call(op, extra, timeoutMs = 6000) {
      return new Promise((resolve) => {
        const id = `pw${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'no-bridge' }); }, timeoutMs);
        pending.set(id, (r) => { clearTimeout(timer); resolve(r); });
        window.postMessage(Object.assign({ __snsimp: 'req', id, op }, extra || {}), location.origin);
      });
    }
    return { call };
  })();

  async function loadPwData() {
    const r = await pwBridge.call('get', { keys: ['pwAccounts', 'pwDetect'] });
    if (!r.ok) {
      pwBridgeOk = false;
    } else {
      pwBridgeOk = true;
      pwAccounts = Array.isArray(r.data.pwAccounts) ? r.data.pwAccounts : [];
      pwDetect = r.data.pwDetect || { enabled: false };
    }
    renderPasswords();
    renderPwHubTile();
  }

  // Read the latest list, change it, write it back (another tab or the reset-page bar may have changed it)
  async function savePwAccounts(mutate) {
    const r = await pwBridge.call('get', { keys: ['pwAccounts'] });
    if (!r.ok) {
      showSimpleToast('🔑 Couldn\'t save', 'The extension\'s storage can\'t be reached. Refresh this page and try again.', '#ef4444');
      return false;
    }
    const list = Array.isArray(r.data.pwAccounts) ? r.data.pwAccounts : [];
    mutate(list);
    const w = await pwBridge.call('set', { items: { pwAccounts: list } });
    if (!w.ok) {
      showSimpleToast('🔑 Couldn\'t save', 'The extension\'s storage can\'t be reached. Refresh this page and try again.', '#ef4444');
      return false;
    }
    pwAccounts = list;
    renderPasswords();
    renderPwHubTile();
    return true;
  }

  async function refreshPwStatus() {
    const r = await pwBridge.call('pw-status');
    pwStatus = r.ok && r.data && !r.data.error ? r.data : null;
    renderPwDetect();
  }

  const pwFmtDate = (d) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  function pwParseDate(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).split('-').map(Number);
    return y ? new Date(y, (m || 1) - 1, d || 1) : null;
  }
  function pwDaysAgo(iso) {
    const d = pwParseDate(iso);
    if (!d) return '';
    const t = new Date();
    const n = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - d) / 86400000);
    return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  }

  function pwStatusPill(info) {
    const n = info.daysLeft;
    if (info.status === 'unknown') return { cls: 'sn-due-soon', text: 'Last change date not set' };
    if (info.status === 'none') return { cls: 'sn-due-none', text: 'Doesn\'t expire' };
    if (info.status === 'overdue') return { cls: 'sn-due-overdue', text: `Expired ${-n} day${n === -1 ? '' : 's'} ago` };
    if (info.status === 'today') return { cls: 'sn-due-overdue', text: 'Expires today' };
    if (info.status === 'soon') return { cls: 'sn-pw-soon', text: `Expires in ${n} day${n === 1 ? '' : 's'}` };
    return { cls: 'sn-due-later', text: `Expires in ${n} days` };
  }

  const pwNeedsAttention = (a) => ['overdue', 'today', 'soon', 'unknown'].includes(pwDueInfo(a).status);

  function pwSorted(list) {
    const rank = { overdue: 0, today: 0, soon: 1, unknown: 2, ok: 3, none: 4 };
    return list.slice().sort((x, y) => {
      const a = pwDueInfo(x);
      const b = pwDueInfo(y);
      return (rank[a.status] - rank[b.status]) || ((a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9)) || String(x.name).localeCompare(String(y.name));
    });
  }

  function pwHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  function renderPwDetect() {
    const el = document.getElementById('sn-pw-detect');
    if (!el) return;
    if (pwBridgeOk === false) {
      el.className = 'sn-pw-detect is-error';
      el.innerHTML = `<div><strong>The extension's storage can't be reached.</strong> Refresh this page. After updating or reloading the extension, open ServiceNow tabs need a refresh.</div>`;
      return;
    }
    const enabled = !!(pwStatus ? pwStatus.enabled && pwStatus.access : pwDetect.enabled);
    const spotted = pwAccounts.filter((a) => a.resetUrl && a.detect !== 'off');
    const hosts = [...new Set(spotted.map((a) => pwHost(a.resetUrl)).filter(Boolean))];
    if (enabled) {
      el.className = 'sn-pw-detect is-on';
      el.innerHTML = `
        <div class="sn-pw-detect-text">
          <strong>✓ Reset page detection is on.</strong>
          ${hosts.length ? `Opening a reset page on ${hosts.map((h) => `<span class="sn-pill sn-pill-ref">${escapeHtml(h)}</span>`).join(' ')} shows a bar asking if you reset that account's password; Yes records today's date.` : 'Add a reset page link to an account to have its reset page spotted.'}
        </div>
        <button class="sn-link-icon-btn" id="sn-pw-detect-off">Turn off</button>`;
      return;
    }
    if (pwStatus && pwStatus.pageAvailable === false) {
      el.className = 'sn-pw-detect is-warn';
      el.innerHTML = `
        <div class="sn-pw-detect-text">
          <strong>Reset page detection needs an updated updater.</strong>
          Turning it on uses two extension files that your copy of Update Extension.bat doesn't download yet.
          Download the new updater, save it in your SNOW Simplifier folder in place of the old one, run it, then reload the extension and refresh this page.
          The new updater keeps itself up to date from now on.
        </div>
        <button class="sn-btn sn-btn-primary" id="sn-pw-get-updater" style="margin-top: 0;">⬇ Download the new updater</button>`;
      return;
    }
    el.className = 'sn-pw-detect';
    el.innerHTML = `
      <div class="sn-pw-detect-text">
        <strong>Reset page detection is off.</strong>
        When it's on, opening one of your accounts' reset pages shows a bar asking if you reset its password, and a Yes updates the date for you.
        Turning it on asks Edge to let the extension run on all websites; it only checks each page's address against your reset links.
      </div>
      <button class="sn-btn sn-btn-primary" id="sn-pw-detect-on" style="margin-top: 0;">Turn on</button>`;
  }

  function renderPasswords() {
    renderPwDetect();
    const listEl = document.getElementById('sn-pw-list');
    const filterEl = document.getElementById('sn-pw-filter');
    if (!listEl) return;
    const attention = pwAccounts.filter(pwNeedsAttention).length;
    if (filterEl) {
      filterEl.innerHTML = [['all', `All (${pwAccounts.length})`], ['attention', `Due soon or expired (${attention})`]]
        .map(([k, label]) => `<button class="sn-cat-pill ${pwFilter === k ? 'active' : ''}" data-pw-filter="${k}">${label}</button>`).join('');
    }
    if (pwBridgeOk === null) { listEl.innerHTML = '<div class="sn-empty-box">Loading…</div>'; return; }
    const search = (document.getElementById('sn-pw-search')?.value || '').trim().toLowerCase();
    const items = pwSorted(pwAccounts).filter((a) => {
      if (pwFilter === 'attention' && !pwNeedsAttention(a)) return false;
      if (!search) return true;
      return [a.name, a.system, a.username, a.resetUrl, a.instructions].join(' ').toLowerCase().includes(search);
    });
    if (!items.length) {
      listEl.innerHTML = `<div class="sn-empty-box">${pwAccounts.length === 0
        ? 'No accounts yet. Click <strong>➕ Add account</strong> to start tracking when a password was last changed.'
        : 'No accounts match this filter.'}</div>`;
      return;
    }
    listEl.innerHTML = items.map((a) => {
      const info = pwDueInfo(a);
      const pill = pwStatusPill(info);
      const hist = (a.history || []).slice(0, 4);
      return `
        <div class="sn-bug-card sn-pw-card sn-pw-card-${info.status}">
          <div class="sn-bug-top">
            <span class="sn-bug-title">🔑 ${escapeHtml(a.name)}</span>
            <span class="sn-pill ${pill.cls}">${escapeHtml(pill.text)}</span>
            ${a.system ? `<span class="sn-pill sn-pill-ref">${escapeHtml(a.system)}</span>` : ''}
            ${a.username ? `<span class="sn-pill sn-pill-count" title="Username">👤 ${escapeHtml(a.username)}</span>` : ''}
          </div>
          <div class="sn-pw-dates">
            <span>Last changed <strong>${a.lastChanged ? escapeHtml(pwFmtDate(pwParseDate(a.lastChanged))) : 'not set'}</strong>${a.lastChanged ? ` (${escapeHtml(pwDaysAgo(a.lastChanged))})` : ''}</span>
            ${info.due ? `<span>Next change due <strong>${escapeHtml(pwFmtDate(info.due))}</strong> · every ${escapeHtml(a.expiryDays)} days</span>` : ''}
          </div>
          ${a.resetUrl ? `<div class="sn-pw-reset">
            <a class="sn-pw-reset-link" href="${escapeHtml(a.resetUrl)}" target="_blank" rel="noopener noreferrer">Open reset page ↗</a>
            <span class="sn-muted">${escapeHtml(pwHost(a.resetUrl))}${a.detect === 'off' ? ' · not spotted' : a.detect === 'page' ? ' · spotted on that page' : ' · spotted anywhere on the site'}</span>
          </div>` : ''}
          ${a.instructions ? `<details class="sn-pw-steps"${!a.resetUrl ? ' open' : ''}><summary>How to reset it</summary><div class="sn-pw-steps-body">${escapeHtml(a.instructions)}</div></details>` : ''}
          <div class="sn-bug-footer">
            <span class="sn-muted">${hist.length ? `Changed: ${hist.map((h) => `${escapeHtml(pwFmtDate(pwParseDate(h.date)))}${h.how === 'detected' ? ' (spotted)' : ''}`).join(', ')}` : 'No changes recorded yet'}</span>
            <div class="sn-link-actions">
              <button class="sn-link-icon-btn sn-pw-done-btn" data-pw-action="changed" data-id="${escapeHtml(a.id)}" title="Record today as the date it was changed">✓ Changed today</button>
              <button class="sn-link-icon-btn" data-pw-action="edit" data-id="${escapeHtml(a.id)}">Edit</button>
              <button class="sn-link-icon-btn danger" data-pw-action="delete" data-id="${escapeHtml(a.id)}">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function renderPwHubTile() {
    const badge = document.getElementById('sn-hub-pw-count');
    const preview = document.getElementById('sn-hub-pw-preview');
    if (!badge || !preview) return;
    if (pwBridgeOk === false) { badge.innerText = '!'; badge.style.background = '#334155'; return; }
    const infos = pwAccounts.map((a) => ({ a, info: pwDueInfo(a) }));
    const overdue = infos.filter((x) => x.info.status === 'overdue' || x.info.status === 'today').length;
    const soon = infos.filter((x) => x.info.status === 'soon').length;
    badge.innerText = overdue ? `${overdue} Expired` : soon ? `${soon} Due soon` : `${pwAccounts.length} Tracked`;
    badge.style.background = overdue ? '#dc2626' : soon ? '#b45309' : '#334155';
    const next = pwSorted(pwAccounts).find((a) => pwDueInfo(a).due);
    if (!pwAccounts.length) {
      preview.innerHTML = '<p class="sn-hub-tool-desc">Track when your account passwords were last changed and when they expire. No passwords are stored.</p>';
      return;
    }
    if (!next) {
      preview.innerHTML = `<p class="sn-hub-tool-desc">${pwAccounts.length} account${pwAccounts.length === 1 ? '' : 's'} tracked. None has an expiry period set.</p>`;
      return;
    }
    const info = pwDueInfo(next);
    const pill = pwStatusPill(info);
    preview.innerHTML = `
      <div class="sn-tile-label">Next to expire${overdue ? ` · <span class="sn-tile-alert">${overdue} expired</span>` : ''}</div>
      <div class="sn-tile-title">${escapeHtml(next.name)}</div>
      <div class="sn-tile-meta"><span class="sn-pill ${pill.cls}">${escapeHtml(pill.text)}</span><span class="sn-pill sn-pill-ticket">${escapeHtml(pwFmtDate(info.due))}</span></div>`;
  }

  // Once a day per account: a toast (and a desktop notification if alerts are allowed) when it's due soon or expired
  function checkPwReminders() {
    if (!pwBridgeOk) return;
    const today = pwToday();
    let reminded = loadStoredJson('sn_helper_pw_reminded', {});
    if (!reminded || typeof reminded !== 'object') reminded = {};
    const due = pwAccounts.filter((a) => ['overdue', 'today', 'soon'].includes(pwDueInfo(a).status) && reminded[a.id] !== today);
    if (!due.length) return;
    due.forEach((a) => { reminded[a.id] = today; });
    localStorage.setItem('sn_helper_pw_reminded', JSON.stringify(reminded));
    const lines = due.map((a) => `${a.name}: ${pwStatusPill(pwDueInfo(a)).text.toLowerCase()}`);
    const title = due.length === 1 ? '🔑 Password due for a change' : `🔑 ${due.length} passwords due for a change`;
    showSimpleToast(title, lines.join(' • '), '#f59e0b', { label: 'Open Password Expiry →', onClick: () => { document.getElementById('sn-helper-overlay')?.classList.remove('sn-hidden'); switchView('passwords'); } });
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title.replace('🔑 ', ''), { body: lines.join('\n') });
    } catch (e) { /* ignore */ }
  }

  // The latest Update Extension.bat from GitHub, saved as a download (falls back to its GitHub page)
  const UPDATER_RAW_URL = 'https://raw.githubusercontent.com/iMxAndyy/SNOW-Simplifier/main/Update%20Extension.bat';
  const UPDATER_PAGE_URL = 'https://github.com/iMxAndyy/SNOW-Simplifier/blob/main/Update%20Extension.bat';
  async function pwDownloadUpdater() {
    try {
      const res = await fetch(`${UPDATER_RAW_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!/curl/i.test(text)) throw new Error('unexpected file');
      const blob = new Blob([text.replace(/\r?\n/g, '\r\n')], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'Update Extension.bat';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      showSimpleToast('⬇ Updater downloaded', 'Move "Update Extension.bat" from Downloads into your SNOW Simplifier folder (replace the old one), run it, then reload the extension.', '#3b82f6');
    } catch (e) {
      window.open(UPDATER_PAGE_URL, '_blank', 'noopener');
      showSimpleToast('⬇ Get the updater from GitHub', 'A GitHub tab has opened: use its download button, then put the file in your SNOW Simplifier folder in place of the old one.', '#3b82f6');
    }
  }

  function initPasswordEvents() {
    const formCard = document.getElementById('sn-pw-form-card');
    const heading = document.getElementById('sn-pw-form-heading');
    const listEl = document.getElementById('sn-pw-list');
    const f = {
      name: document.getElementById('sn-pw-name'),
      system: document.getElementById('sn-pw-system'),
      username: document.getElementById('sn-pw-username'),
      last: document.getElementById('sn-pw-last'),
      expiry: document.getElementById('sn-pw-expiry'),
      warn: document.getElementById('sn-pw-warn'),
      url: document.getElementById('sn-pw-url'),
      detect: document.getElementById('sn-pw-detect-mode'),
      steps: document.getElementById('sn-pw-steps')
    };
    const openForm = (acc) => {
      pwEditingId = acc ? acc.id : null;
      heading.innerText = acc ? `🔑 Edit ${acc.name}` : '🔑 Add account';
      f.name.value = acc ? acc.name || '' : '';
      f.system.value = acc ? acc.system || '' : '';
      f.username.value = acc ? acc.username || '' : '';
      f.last.value = acc ? acc.lastChanged || '' : pwToday();
      f.expiry.value = acc ? (acc.expiryDays || '') : '90';
      f.warn.value = acc ? (acc.warnDays ?? 14) : '14';
      f.url.value = acc ? acc.resetUrl || '' : '';
      f.detect.value = acc ? acc.detect || 'site' : 'site';
      f.steps.value = acc ? acc.instructions || '' : '';
      formCard.classList.remove('sn-hidden');
      f.name.focus();
    };
    const closeForm = () => { formCard.classList.add('sn-hidden'); pwEditingId = null; };

    document.getElementById('sn-pw-toggle-form-btn').addEventListener('click', () => {
      if (!formCard.classList.contains('sn-hidden') && !pwEditingId) closeForm(); else openForm(null);
    });
    document.getElementById('sn-pw-cancel-btn').addEventListener('click', closeForm);
    document.getElementById('sn-pw-save-btn').addEventListener('click', async () => {
      const name = f.name.value.trim();
      if (!name) { f.name.focus(); showSimpleToast('🔑 Name needed', 'Give the account a name.', '#ef4444'); return; }
      const url = f.url.value.trim();
      if (url && !/^https?:\/\//i.test(url)) { f.url.focus(); showSimpleToast('🔑 Check the link', 'The reset page link should start with https:// (or http://).', '#ef4444'); return; }
      const expiry = parseInt(f.expiry.value, 10);
      const warn = parseInt(f.warn.value, 10);
      const values = {
        name, system: f.system.value.trim(), username: f.username.value.trim(), lastChanged: f.last.value || '',
        expiryDays: expiry > 0 ? expiry : null, warnDays: warn >= 0 ? warn : 14, resetUrl: url, detect: f.detect.value, instructions: f.steps.value.trim(), updatedAt: Date.now()
      };
      const editing = pwEditingId;
      const ok = await savePwAccounts((list) => {
        const existing = editing && list.find((a) => a.id === editing);
        if (existing) {
          if (values.lastChanged && values.lastChanged !== existing.lastChanged) existing.history = [{ date: values.lastChanged, how: 'edited' }, ...(existing.history || [])].slice(0, 20);
          Object.assign(existing, values);
        } else {
          list.push(Object.assign({ id: `pw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now(), history: values.lastChanged ? [{ date: values.lastChanged, how: 'added' }] : [] }, values));
        }
      });
      if (!ok) return;
      closeForm();
      showSimpleToast(editing ? '🔑 Account updated' : '🔑 Account added', name, '#22c55e');
      if (url && values.detect !== 'off' && !pwDetect.enabled) setTimeout(() => showSimpleToast('🔑 Tip', 'Turn on reset page detection (top of the page) to have this reset page spotted when you visit it.', '#3b82f6'), 400);
    });

    document.getElementById('sn-pw-search').addEventListener('input', renderPasswords);
    document.getElementById('sn-pw-filter').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pw-filter]');
      if (!b) return;
      pwFilter = b.getAttribute('data-pw-filter');
      renderPasswords();
    });

    listEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pw-action]');
      if (!b) return;
      const id = b.getAttribute('data-id');
      const acc = pwAccounts.find((a) => a.id === id);
      if (!acc) return;
      const action = b.getAttribute('data-pw-action');
      if (action === 'edit') { openForm(acc); formCard.scrollIntoView({ block: 'nearest' }); return; }
      if (action === 'delete') {
        if (!confirm(`Delete "${acc.name}" from Password Expiry?`)) return;
        await savePwAccounts((list) => { const i = list.findIndex((a) => a.id === id); if (i >= 0) list.splice(i, 1); });
        return;
      }
      if (action === 'changed') {
        const today = pwToday();
        await savePwAccounts((list) => {
          const a = list.find((x) => x.id === id);
          if (!a) return;
          a.lastChanged = today;
          a.history = [{ date: today, how: 'manual' }, ...(a.history || [])].slice(0, 20);
          a.updatedAt = Date.now();
        });
        const info = pwDueInfo(pwAccounts.find((a) => a.id === id) || acc);
        showSimpleToast('🔑 Recorded', `${acc.name}: changed today${info.due ? `, next due ${pwFmtDate(info.due)}` : ''}.`, '#22c55e');
      }
    });

    document.getElementById('sn-pw-detect').addEventListener('click', async (e) => {
      if (e.target.closest('#sn-pw-detect-on')) {
        const r = await pwBridge.call('pw-open-access');
        if (!r.ok || !r.data) { showSimpleToast('🔑 Couldn\'t start', 'The extension can\'t be reached. Refresh this page and try again.', '#ef4444'); return; }
        if (r.data.error === 'missing-page') {
          showSimpleToast('🔑 Update needed', 'This needs two extension files your updater doesn\'t download yet. Get the new Update Extension.bat, run it, reload the extension, then try again.', '#ef4444', { label: '⬇ Download the new updater', onClick: pwDownloadUpdater });
          refreshPwStatus();
          return;
        }
        showSimpleToast('🔑 One more step', 'A new tab has opened: click "Allow and turn on" there, then accept Edge\'s prompt.', '#3b82f6');
      }
      if (e.target.closest('#sn-pw-get-updater')) {
        pwDownloadUpdater();
        return;
      }
      if (e.target.closest('#sn-pw-detect-off')) {
        if (!confirm('Turn off reset page detection? The extension\'s access to other websites will be removed.')) return;
        await pwBridge.call('pw-disable');
        await loadPwData();
        await refreshPwStatus();
        showSimpleToast('🔑 Detection off', 'Reset pages won\'t be spotted any more. Your accounts are unchanged.', '#64748b');
      }
    });

    document.getElementById('sn-pw-export-btn').addEventListener('click', () => {
      const payload = { type: 'sn-simplifier-password-expiry', version: 1, exportedAt: new Date().toISOString(), accounts: pwAccounts };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `password-expiry-${pwToday()}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    const importInput = document.getElementById('sn-pw-import-input');
    document.getElementById('sn-pw-import-btn').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || data.type !== 'sn-simplifier-password-expiry' || !Array.isArray(data.accounts)) throw new Error('This file is not a Password Expiry export.');
        let added = 0;
        let updated = 0;
        const ok = await savePwAccounts((list) => {
          data.accounts.forEach((inc) => {
            if (!inc || !inc.name) return;
            const clean = { id: inc.id, name: String(inc.name), system: inc.system || '', username: inc.username || '', lastChanged: inc.lastChanged || '', expiryDays: inc.expiryDays || null,
              warnDays: inc.warnDays ?? 14, resetUrl: inc.resetUrl || '', detect: inc.detect || 'site', instructions: inc.instructions || '', history: Array.isArray(inc.history) ? inc.history.slice(0, 20) : [], createdAt: inc.createdAt || Date.now(), updatedAt: inc.updatedAt || Date.now() };
            const existing = list.find((a) => (clean.id && a.id === clean.id) || a.name.toLowerCase() === clean.name.toLowerCase());
            if (existing) {
              if ((clean.lastChanged || '') >= (existing.lastChanged || '')) { Object.assign(existing, clean, { id: existing.id }); updated++; }
            } else {
              list.push(Object.assign(clean, { id: clean.id || `pw${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }));
              added++;
            }
          });
        });
        if (ok) showSimpleToast('⬆ Accounts imported', `${added} new, ${updated} updated.`, '#22c55e');
      } catch (err) {
        showSimpleToast('⬆ Import failed', err.message, '#ef4444');
      }
    });
  }

  // ----- Ticket state categories & "time in open state" -----
  let mineOpenSort = localStorage.getItem('sn_helper_mine_open_sort') === '1';
  let stateChoiceLabels = null; // { table: { value: label } } from sys_choice
  let auditAvailable = null; // null = not tried yet, true = state history readable, false = access denied
  let openSinceCache = loadStoredJson('sn_helper_open_since', {});
  if (!openSinceCache || typeof openSinceCache !== 'object' || Array.isArray(openSinceCache)) openSinceCache = {};

  // Out-of-box values, used only if sys_choice can't be read
  const DEFAULT_STATE_CHOICES = {
    incident: { 1: 'New', 2: 'In Progress', 3: 'On Hold', 6: 'Resolved', 7: 'Closed', 8: 'Canceled' },
    sn_customerservice_case: { 1: 'New', 10: 'Open', 18: 'Awaiting Info', 6: 'Resolved', 3: 'Closed', 7: 'Cancelled' }
  };

  // open = needs work now • hold = parked / waiting on someone else • other = anything else
  function ticketStateCategory(label) {
    const st = (label || '').toLowerCase();
    if (/hold|pending|await|waiting|suspend|deferred/.test(st)) return 'hold';
    if (/resolved|closed|cancel|complete/.test(st)) return 'other';
    if (/new|open|progress|active|assigned|work|draft/.test(st)) return 'open';
    return 'other';
  }

  function parseServiceNowUtc(str) {
    if (!str) return null;
    const d = new Date(String(str).trim().replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  async function ensureStateChoices() {
    if (stateChoiceLabels) return;
    stateChoiceLabels = JSON.parse(JSON.stringify(DEFAULT_STATE_CHOICES));
    const token = getAuthToken();
    if (!token) return;
    try {
      const q = 'nameINincident,sn_customerservice_case,task^element=state^language=en';
      const res = await fetch(`/api/now/table/sys_choice?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=name,value,label&sysparm_limit=300`, {
        headers: { 'Accept': 'application/json', 'X-UserToken': token }
      });
      if (!res.ok) return;
      ((await res.json()).result || []).forEach((c) => {
        const name = getRawVal(c.name);
        if (!name) return;
        stateChoiceLabels[name] = stateChoiceLabels[name] || {};
        stateChoiceLabels[name][getRawVal(c.value)] = getVal(c.label);
      });
    } catch (e) {}
  }

  function stateLabelFor(table, value) {
    const v = String(value ?? '');
    const choices = stateChoiceLabels || DEFAULT_STATE_CHOICES;
    return choices[table]?.[v] ?? choices.task?.[v] ?? '';
  }

  function isOpenStateValue(table, value) {
    if (value === '' || value === null || value === undefined) return false;
    return ticketStateCategory(stateLabelFor(table, value)) === 'open';
  }

  // Sources, in order: state history (sys_audit) → state metrics (metric_instance) → this browser's own tracking
  let metricsAvailable = null; // null = not tried yet, true = readable, false = access denied
  let openSinceDiag = { audit: 'untried', metrics: 'untried' }; // ok | empty | denied | error | untried
  const OPEN_SINCE_META_KEY = 'sn_helper_open_since_meta';
  const OPEN_SINCE_RECHECK_MS = 10 * 60 * 1000; // retry remote sources for locally tracked tickets every 10 min
  const OBSERVED_MAX_GAP_MS = 5 * 60 * 1000; // a change seen within this of the last check counts as exact

  function isLocalOpenSource(src) {
    return src === 'first-seen' || src === 'observed' || src === 'observed-gap';
  }

  async function queryAuditOpenSince(list) {
    const found = {};
    if (!list.length || auditAvailable === false) return found;
    try {
      const ids = list.map((t) => t.sysId).join(',');
      const q = `documentkeyIN${ids}^fieldname=state^ORDERBYDESCsys_created_on`;
      const res = await fetch(`/api/now/table/sys_audit?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=documentkey,oldvalue,newvalue,sys_created_on&sysparm_limit=2000`, {
        headers: { 'Accept': 'application/json', 'X-UserToken': getAuthToken() }
      });
      if (res.status === 401 || res.status === 403) {
        auditAvailable = false;
        openSinceDiag.audit = 'denied';
        return found;
      }
      if (!res.ok) { openSinceDiag.audit = 'error'; return found; }
      const rows = (await res.json()).result || [];
      // No rows at all can mean row-level security is hiding them, so don't treat it as "never changed"
      if (rows.length === 0) { openSinceDiag.audit = 'empty'; return found; }
      auditAvailable = true;
      openSinceDiag.audit = 'ok';
      const byDoc = {};
      rows.forEach((a) => {
        const key = getRawVal(a.documentkey);
        (byDoc[key] = byDoc[key] || []).push(a);
      });
      list.forEach((t) => {
        const history = (byDoc[t.sysId] || []).sort((x, y) =>
          (parseServiceNowUtc(getRawVal(y.sys_created_on)) || 0) - (parseServiceNowUtc(getRawVal(x.sys_created_on)) || 0));
        let since = null;
        // Walk back through open→open moves (e.g. New → In Progress) to the change that entered the open state
        for (const a of history) {
          if (isOpenStateValue(t.table, getRawVal(a.oldvalue))) continue;
          since = parseServiceNowUtc(getRawVal(a.sys_created_on));
          break;
        }
        if (since !== null) found[t.sysId] = { since, source: 'history' };
        else if (parseServiceNowUtc(t.openedRaw) !== null) found[t.sysId] = { since: parseServiceNowUtc(t.openedRaw), source: 'opened' };
      });
    } catch (e) {
      openSinceDiag.audit = 'error';
    }
    return found;
  }

  // metric_instance holds one row per period a ticket spent in each state (where a state metric is defined)
  async function queryMetricsOpenSince(list) {
    const found = {};
    if (!list.length || metricsAvailable === false) return found;
    try {
      const ids = list.map((t) => t.sysId).join(',');
      const q = `idIN${ids}^definition.field=state^ORDERBYDESCstart`;
      const res = await fetch(`/api/now/table/metric_instance?sysparm_query=${encodeURIComponent(q)}&sysparm_fields=id,value,start,end&sysparm_limit=2000`, {
        headers: { 'Accept': 'application/json', 'X-UserToken': getAuthToken() }
      });
      if (res.status === 401 || res.status === 403) {
        metricsAvailable = false;
        openSinceDiag.metrics = 'denied';
        return found;
      }
      if (!res.ok) { openSinceDiag.metrics = 'error'; return found; }
      const rows = (await res.json()).result || [];
      metricsAvailable = true;
      const byDoc = {};
      rows.forEach((m) => {
        const key = getRawVal(m.id);
        (byDoc[key] = byDoc[key] || []).push(m);
      });
      list.forEach((t) => {
        const periods = (byDoc[t.sysId] || [])
          .map((m) => ({ label: getVal(m.value), start: parseServiceNowUtc(getRawVal(m.start)) }))
          .filter((p) => p.start !== null)
          .sort((a, b) => b.start - a.start);
        // The newest period must be the current (open) state, otherwise the metrics are stale for this ticket
        if (!periods.length || ticketStateCategory(periods[0].label) !== 'open') return;
        let since = periods[0].start;
        for (let i = 1; i < periods.length; i++) {
          if (ticketStateCategory(periods[i].label) !== 'open') break;
          since = periods[i].start;
        }
        found[t.sysId] = { since, source: 'metrics' };
      });
      openSinceDiag.metrics = Object.keys(found).length ? 'ok' : 'empty';
    } catch (e) {
      openSinceDiag.metrics = 'error';
    }
    return found;
  }

  // Work out when each open ticket last ENTERED an open state (never its age)
  async function updateOpenSince(tickets) {
    const now = Date.now();
    const meta = loadStoredJson(OPEN_SINCE_META_KEY, {}) || {};
    const lastSeenAt = Number(meta.lastSeenAt) || 0;

    const openTickets = tickets.filter((t) => ticketStateCategory(t.state) === 'open' && t.sysId);
    const needLookup = openTickets.filter((t) => {
      const c = openSinceCache[t.sysId];
      if (!c || c.category !== 'open') return true;
      if (isLocalOpenSource(c.source)) return now - (c.checkedAt || 0) > OPEN_SINCE_RECHECK_MS;
      return c.stateValue !== t.stateValue || c.updated !== t.updated;
    });

    let remaining = needLookup;
    const fromAudit = await queryAuditOpenSince(remaining);
    remaining = remaining.filter((t) => !fromAudit[t.sysId]);
    const fromMetrics = await queryMetricsOpenSince(remaining);

    needLookup.forEach((t) => {
      const hit = fromAudit[t.sysId] || fromMetrics[t.sysId];
      if (hit) {
        openSinceCache[t.sysId] = { stateValue: t.stateValue, updated: t.updated, category: 'open', since: hit.since, source: hit.source, checkedAt: now };
      }
    });

    // Own tracking for anything the remote sources couldn't answer
    openTickets.forEach((t) => {
      if (fromAudit[t.sysId] || fromMetrics[t.sysId]) return;
      const c = openSinceCache[t.sysId];
      if (c && c.category === 'open') {
        // Already being timed: an open → open move (e.g. New → In Progress) keeps the original time
        c.stateValue = t.stateValue;
        c.updated = t.updated;
        if (needLookup.includes(t)) c.checkedAt = now;
        return;
      }
      if (c && c.category !== 'open') {
        // We saw it move into an open state
        const gap = lastSeenAt ? now - lastSeenAt : Infinity;
        openSinceCache[t.sysId] = gap <= OBSERVED_MAX_GAP_MS
          ? { stateValue: t.stateValue, updated: t.updated, category: 'open', since: now, source: 'observed', checkedAt: now }
          : { stateValue: t.stateValue, updated: t.updated, category: 'open', since: now, windowStart: lastSeenAt || null, source: 'observed-gap', checkedAt: now };
        return;
      }
      openSinceCache[t.sysId] = { stateValue: t.stateValue, updated: t.updated, category: 'open', since: now, source: 'first-seen', checkedAt: now };
    });

    // Remember non-open states so a later move into an open state can be observed
    tickets.forEach((t) => {
      const cat = ticketStateCategory(t.state);
      if (cat !== 'open' && t.sysId) openSinceCache[t.sysId] = { stateValue: t.stateValue, updated: t.updated, category: cat, since: null, source: 'state' };
    });

    // Drop tickets no longer assigned to you
    const live = new Set(tickets.map((t) => t.sysId));
    Object.keys(openSinceCache).forEach((id) => { if (!live.has(id)) delete openSinceCache[id]; });
    persist('sn_helper_open_since', openSinceCache);
    persist(OPEN_SINCE_META_KEY, { lastSeenAt: now });
  }

  function formatDurationShort(ms) {
    const mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ${mins % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  function openAgeHtml(t) {
    if (ticketStateCategory(t.state) !== 'open') return '';
    const c = openSinceCache[t.sysId];
    if (!c || !c.since) return '';
    const ms = Date.now() - c.since;
    const heat = ms >= 3 * 86400000 ? 'hot' : (ms >= 86400000 ? 'warm' : 'fresh');
    const fmt = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const when = fmt(c.since);
    const why = {
      history: `In an open state since ${when} (from the ticket's state history)`,
      metrics: `In an open state since ${when} (from ServiceNow state metrics)`,
      opened: `In an open state since it was opened, ${when} (no state changes recorded)`,
      observed: `Seen moving into an open state at ${when} (tracked by this browser)`,
      'observed-gap': `Moved into an open state sometime between ${c.windowStart ? fmt(c.windowStart) : 'an earlier visit'} and ${when}, while ServiceNow wasn't open. Showing the minimum.`,
      'first-seen': `At least since ${when}. No state history was available, so this is when this browser first saw it open.`
    }[c.source] || when;
    const prefix = c.source === 'first-seen' || c.source === 'observed-gap' ? '≥ ' : '';
    return `<div class="sn-open-age sn-age-${heat}" title="${escapeHtml(why)}">⏱ ${prefix}${formatDurationShort(ms)}</div>`;
  }

  function describeOpenSinceDiag(key) {
    return { ok: 'available', empty: 'no records returned', denied: 'access denied', error: 'request failed', untried: 'not tried' }[key] || key;
  }

  function renderMineNote() {
    const note = document.getElementById('sn-mine-note');
    if (!note) return;
    const open = myTickets.filter((t) => ticketStateCategory(t.state) === 'open');
    const sources = open.map((t) => openSinceCache[t.sysId]?.source).filter(Boolean);
    const localCount = sources.filter(isLocalOpenSource).length;
    const usedMetrics = sources.includes('metrics');
    const usedHistory = sources.includes('history') || sources.includes('opened');

    if (localCount > 0) {
      note.style.display = 'block';
      note.className = 'sn-mine-note sn-mine-note-warn';
      note.innerHTML = `⚠️ ServiceNow didn't provide state history for <strong>${localCount}</strong> open ticket${localCount === 1 ? '' : 's'}, so the extension is timing ${localCount === 1 ? 'it' : 'them'} itself in this browser. Times marked <strong>≥</strong> are minimums (from when it first saw the ticket open). Any move into an open state it sees from now on is timed exactly.
        <div class="sn-mine-note-diag">Tried: state history (<code>sys_audit</code>): ${escapeHtml(describeOpenSinceDiag(openSinceDiag.audit))} • state metrics (<code>metric_instance</code>): ${escapeHtml(describeOpenSinceDiag(openSinceDiag.metrics))}. Read access to either table would give exact times.</div>`;
      return;
    }
    if (mineOpenSort) {
      const src = usedHistory && usedMetrics ? 'state history and state metrics'
        : (usedMetrics ? 'ServiceNow state metrics' : 'the ticket state history');
      note.style.display = 'block';
      note.className = 'sn-mine-note';
      note.innerHTML = `⏱ Open tickets first, longest-waiting at the top. Waiting time is measured from when each ticket last moved <strong>into</strong> an open state (from ${src}), not from when it was created. On-hold tickets are listed last.`;
      return;
    }
    note.style.display = 'none';
  }

  // ----- Assigned to Me page -----
  function notesCountBadgeHtml(number) {
    const n = (ticketData[normNumber(number)]?.notes || []).length;
    if (!n) return '';
    return ` <span class="sn-pill sn-pill-note sn-notes-count" title="${n} note${n === 1 ? '' : 's'} — open the change to view">📝 ${n}</span>`;
  }

  function bugChipHtml(bug, removable) {
    return `<span class="sn-bug-chip sn-bug-chip-${escapeHtml(bug.status || 'open')}" title="${escapeHtml(`${bug.title}${bug.reference ? ` (${bug.reference})` : ''} — ${BUG_STATUS_LABEL[bug.status] || 'Open'}`)}">🐞 <span class="sn-bug-chip-text">${escapeHtml(bug.title)}</span>${removable ? `<button type="button" class="sn-bug-chip-x" data-ws-action="unlink-bug" data-id="${escapeHtml(bug.id)}" title="Unlink this bug">&times;</button>` : ''}</span>`;
  }

  function notesTasksSummaryHtml(entry) {
    if (!entry) return '<span class="sn-muted">＋ Add</span>';
    const notes = (entry.notes || []).length;
    const tasks = entry.tasks || [];
    const open = tasks.filter((t) => !t.done).sort(compareTasks);
    const parts = [];
    if (notes) parts.push(`<span class="sn-pill sn-pill-note" title="${notes} note${notes === 1 ? '' : 's'}">📝 ${notes}</span>`);
    if (tasks.length) parts.push(`<span class="sn-pill sn-pill-task" title="${open.length} open of ${tasks.length} task${tasks.length === 1 ? '' : 's'}">☑ ${tasks.length - open.length}/${tasks.length}</span>`);
    const nextDated = open.find((t) => getTaskDueTime(t) !== null);
    if (nextDated) {
      const due = describeTaskDue(nextDated);
      parts.push(`<span class="sn-pill sn-due-${due.status}" title="${escapeHtml(nextDated.title)}">🕒 ${escapeHtml(due.text)}</span>`);
    }
    return parts.length ? parts.join(' ') : '<span class="sn-muted">＋ Add</span>';
  }

  function updateMineBugFilterOptions() {
    const sel = document.getElementById('sn-mine-bug');
    if (!sel) return;
    if (mineBugFilter.startsWith('bug:') && !knownBugs.some((b) => `bug:${b.id}` === mineBugFilter)) mineBugFilter = 'ALL';
    const opt = (value, label) => `<option value="${escapeHtml(value)}" ${mineBugFilter === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    const active = knownBugs.filter((b) => b.status !== 'resolved');
    const resolved = knownBugs.filter((b) => b.status === 'resolved');
    sel.innerHTML = [
      opt('ALL', 'All tickets'),
      opt('ANY', 'Linked to any bug'),
      opt('NONE', 'Not linked to a bug'),
      active.length ? `<optgroup label="Active bugs">${active.map((b) => opt(`bug:${b.id}`, b.title)).join('')}</optgroup>` : '',
      resolved.length ? `<optgroup label="Resolved bugs">${resolved.map((b) => opt(`bug:${b.id}`, b.title)).join('')}</optgroup>` : ''
    ].join('');
  }

  function renderMineTable() {
    const tbody = document.getElementById('sn-mine-body');
    const statusEl = document.getElementById('sn-mine-status-text');
    if (!tbody) return;
    updateMineBugFilterOptions();

    if (statusEl) {
      if (myTicketsError) statusEl.innerText = myTicketsError;
      else if (!myTicketsLoaded) statusEl.innerText = 'Loading your tickets...';
      else statusEl.innerText = `Last updated: ${new Date().toLocaleTimeString()} • ${myTickets.length} open CS/INC ticket(s) assigned to ${getCurrentUserName() || 'you'}`;
    }
    if (!myTicketsLoaded) {
      tbody.innerHTML = `<tr><td colspan="7" class="sn-empty-cell">${escapeHtml(myTicketsError || 'Loading your tickets...')}</td></tr>`;
      renderMineOther();
      return;
    }

    const search = (document.getElementById('sn-mine-search')?.value || '').trim().toLowerCase();
    const bugsById = Object.fromEntries(knownBugs.map((b) => [b.id, b]));
    const rows = myTickets.filter((t) => {
      const prefix = getTicketPrefix(t.number);
      if (mineTypeFilter !== 'ALL' && prefix !== mineTypeFilter) return false;
      const ids = (ticketData[t.number]?.bugIds || []).filter((id) => bugsById[id]);
      if (mineBugFilter === 'ANY' && ids.length === 0) return false;
      if (mineBugFilter === 'NONE' && ids.length > 0) return false;
      if (mineBugFilter.startsWith('bug:') && !ids.includes(mineBugFilter.slice(4))) return false;
      if (search && !`${t.number} ${t.shortDesc}`.toLowerCase().includes(search)) return false;
      return true;
    });

    if (mineOpenSort) {
      const groupRank = { open: 0, other: 1, hold: 2 };
      const original = new Map(rows.map((t, i) => [t, i]));
      rows.sort((a, b) => {
        const ga = groupRank[ticketStateCategory(a.state)];
        const gb = groupRank[ticketStateCategory(b.state)];
        if (ga !== gb) return ga - gb;
        if (ga === 0) {
          const sa = openSinceCache[a.sysId]?.since ?? Infinity;
          const sb = openSinceCache[b.sysId]?.since ?? Infinity;
          if (sa !== sb) return sa - sb; // longest-waiting first; unknown last
        }
        return original.get(a) - original.get(b);
      });
    }
    renderMineNote();

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="sn-empty-cell">${myTickets.length === 0 ? '🎉 No open CS or INC tickets are assigned to you.' : 'No tickets match your filters.'}</td></tr>`;
      renderMineOther();
      return;
    }

    tbody.innerHTML = rows.map((t) => {
      const entry = ticketData[t.number];
      const bugs = (entry?.bugIds || []).map((id) => bugsById[id]).filter(Boolean);
      const prefix = getTicketPrefix(t.number);
      const prioNum = (t.priority || '').charAt(0);
      const prioClass = prioNum === '1' || prioNum === '2' ? `sn-priority-${prioNum}` : '';
      const hasOverdue = (entry?.tasks || []).some((x) => !x.done && describeTaskDue(x).status === 'overdue');
      return `
        <tr class="sn-mine-row sn-mine-state-${ticketStateCategory(t.state)} ${hasOverdue ? 'sn-mine-row-alert' : ''}" data-number="${escapeHtml(t.number)}" title="Open ${escapeHtml(t.number)} with notes, tasks &amp; bugs">
          <td><span class="sn-type-badge">${escapeHtml(prefix)}</span><a class="sn-link" href="#">${escapeHtml(t.number)}</a></td>
          <td><span class="sn-badge ${prioClass}">${escapeHtml(t.priority || '—')}</span></td>
          <td><span class="sn-state-badge ${getStateBadgeClass(t.state)}">${escapeHtml(t.state || '—')}</span>${openAgeHtml(t)}</td>
          <td>${escapeHtml(t.shortDesc)}</td>
          <td class="sn-mine-bug-cell">${bugs.length ? bugs.map((b) => bugChipHtml(b, false)).join(' ') : '<span class="sn-muted">—</span>'}</td>
          <td class="sn-mine-nt-cell">${notesTasksSummaryHtml(entry)}</td>
          <td>${escapeHtml(t.updated)}</td>
        </tr>
      `;
    }).join('');
    renderMineOther();
  }

  // Tickets with open tasks that have left your queue (resolved or reassigned)
  function renderMineOther() {
    const box = document.getElementById('sn-mine-other');
    if (!box) return;
    if (!myTicketsLoaded) { box.innerHTML = ''; return; }
    const mineSet = new Set(myTickets.map((t) => t.number));
    const others = Object.keys(ticketData)
      .filter((n) => !mineSet.has(n) && (ticketData[n].tasks || []).some((t) => !t.done));
    if (others.length === 0) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div class="sn-mine-other-title">📌 Open tasks on tickets no longer in your queue (resolved or reassigned)</div>
      <div class="sn-mine-other-list">
        ${others.map((n) => {
          const e = ticketData[n];
          const open = (e.tasks || []).filter((t) => !t.done).length;
          const live = liveTicketStates[n];
          return `<button type="button" class="sn-bug-ticket" data-number="${escapeHtml(n)}">
            <strong>${escapeHtml(n)}</strong>${live?.state ? ` · ${escapeHtml(live.state)}` : ''} — ${escapeHtml(e.shortDesc || 'No description saved')}
            <span class="sn-pill sn-pill-task">☑ ${open} open</span>
          </button>`;
        }).join('')}
      </div>
    `;
  }

  function initMineEvents() {
    const typeSel = document.getElementById('sn-mine-type');
    const bugSel = document.getElementById('sn-mine-bug');
    const search = document.getElementById('sn-mine-search');
    if (typeSel) {
      typeSel.value = mineTypeFilter;
      typeSel.addEventListener('change', () => {
        mineTypeFilter = typeSel.value;
        localStorage.setItem('sn_helper_mine_type', mineTypeFilter);
        renderMineTable();
      });
    }
    if (bugSel) {
      bugSel.addEventListener('change', () => {
        mineBugFilter = bugSel.value;
        localStorage.setItem('sn_helper_mine_bug', mineBugFilter);
        renderMineTable();
      });
    }
    if (search) search.addEventListener('input', renderMineTable);
    document.getElementById('sn-mine-refresh-btn')?.addEventListener('click', () => fetchMyTickets());
    const sortBtn = document.getElementById('sn-mine-open-sort-btn');
    const syncSortBtn = () => {
      if (!sortBtn) return;
      sortBtn.classList.toggle('is-active', mineOpenSort);
      sortBtn.innerText = mineOpenSort ? '⏱ Open first ✓' : '⏱ Open first';
    };
    syncSortBtn();
    sortBtn?.addEventListener('click', () => {
      mineOpenSort = !mineOpenSort;
      localStorage.setItem('sn_helper_mine_open_sort', mineOpenSort ? '1' : '0');
      syncSortBtn();
      renderMineTable();
    });
    document.getElementById('sn-mine-bugs-btn')?.addEventListener('click', () => switchView('bugs'));

    const openFromEvent = (e) => {
      const el = e.target.closest('[data-number]');
      if (!el) return;
      e.preventDefault();
      openWorkspaceForNumber(el.getAttribute('data-number'));
    };
    document.getElementById('sn-mine-body')?.addEventListener('click', openFromEvent);
    document.getElementById('sn-mine-other')?.addEventListener('click', openFromEvent);
  }

  // ----- pop-up side panel (notes, tasks, bugs) -----
  function setPreviewWorkspaceMode(on) {
    const card = document.querySelector('#sn-preview-modal .sn-preview-card');
    const panel = document.getElementById('sn-ws-panel');
    if (card) card.classList.toggle('sn-workspace', on);
    if (panel) {
      panel.style.display = on ? 'flex' : 'none';
      if (on) panel.innerHTML = '<div class="sn-muted" style="padding: 8px;">Loading notes &amp; tasks...</div>';
      else panel.innerHTML = '';
    }
    if (!on) workspaceTicket = null;
  }

  function openWorkspacePanel(info) {
    workspaceTicket = { ...info, number: normNumber(info.number) };
    const entry = ticketData[workspaceTicket.number];
    if (entry) {
      rememberTicketSnapshot(entry, workspaceTicket);
      persist(TICKET_DATA_KEY, ticketData);
    }
    renderWorkspacePanel();
  }

  function renderWorkspacePanel() {
    const panel = document.getElementById('sn-ws-panel');
    if (!panel || !workspaceTicket) return;

    // Keep anything the user is typing and which sections are expanded
    const kept = {};
    panel.querySelectorAll('[data-keep]').forEach((el) => { kept[el.id] = el.value; });
    const openDetails = {};
    panel.querySelectorAll('details[id]').forEach((d) => { openDetails[d.id] = d.open; });
    const focusedId = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.id : null;

    const number = workspaceTicket.number;
    const entry = ticketData[number] || { bugIds: [], notes: [], tasks: [] };
    const bugsById = Object.fromEntries(knownBugs.map((b) => [b.id, b]));
    const linked = (entry.bugIds || []).map((id) => bugsById[id]).filter(Boolean);
    const linkable = knownBugs.filter((b) => !(entry.bugIds || []).includes(b.id));
    const linkableActive = linkable.filter((b) => b.status !== 'resolved');
    const linkableResolved = linkable.filter((b) => b.status === 'resolved');
    const tasks = (entry.tasks || []).slice();
    const openTasks = tasks.filter((t) => !t.done).sort(compareTasks);
    const doneTasks = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    const notes = (entry.notes || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const taskRow = (t) => {
      const due = describeTaskDue(t);
      const hasReminder = !t.done && getTaskReminderTime(t) !== null;
      return `
        <div class="sn-ws-task ${t.done ? 'is-done' : ''} ${!t.done && due.status === 'overdue' ? 'is-overdue' : ''}">
          <button type="button" class="sn-check ${t.done ? 'is-done' : ''}" data-ws-action="toggle-task" data-id="${escapeHtml(t.id)}" title="${t.done ? 'Mark as not done' : 'Mark as done'}">✓</button>
          <div class="sn-ws-task-main">
            <div class="sn-ws-task-title">${escapeHtml(t.title)}</div>
            ${t.dueDate || t.done ? `<div class="sn-ws-task-meta">
              ${t.dueDate ? `<span class="sn-pill ${t.done ? 'sn-due-none' : `sn-due-${due.status}`}">🕒 ${escapeHtml(t.done ? due.plain : due.text)}${hasReminder ? ' 🔔' : ''}</span>` : ''}
              ${t.done ? `<span class="sn-muted">Done ${escapeHtml(formatTimestamp(t.doneAt))}</span>` : ''}
            </div>` : ''}
          </div>
          <button type="button" class="sn-ws-icon-btn" data-ws-action="delete-task" data-id="${escapeHtml(t.id)}" title="Delete task">🗑</button>
        </div>`;
    };

    const notesSectionHtml = `
      <section class="sn-ws-section">
        <div class="sn-ws-title">📝 Notes <span class="sn-ws-count">${notes.length}</span>
          ${notes.length ? '<button type="button" class="sn-ws-link" data-ws-action="copy-notes" title="Copy all notes, oldest first — handy for work notes">Copy all</button>' : ''}
        </div>
        <div class="sn-ws-stack">
          <textarea id="sn-ws-note-input" class="sn-links-input" data-keep rows="3" placeholder="Add a note… (Ctrl+Enter to save)"></textarea>
          <button type="button" class="sn-ws-btn sn-ws-btn-primary" data-ws-action="add-note">Add Note</button>
        </div>
        <div class="sn-ws-notes">
          ${notes.map((n) => `
            <div class="sn-ws-note">
              <div class="sn-ws-note-meta">
                <span>${escapeHtml(formatTimestamp(n.createdAt))}</span>
                <span>
                  <button type="button" class="sn-ws-link" data-ws-action="copy-note" data-id="${escapeHtml(n.id)}">Copy</button>
                  <button type="button" class="sn-ws-link sn-ws-link-danger" data-ws-action="delete-note" data-id="${escapeHtml(n.id)}">Delete</button>
                </span>
              </div>
              <div class="sn-ws-note-text">${escapeHtml(n.text)}</div>
            </div>`).join('')}
        </div>
      </section>
    `;

    const notesOnlyHtml = `
      <div class="sn-ws-header">
        <div class="sn-ws-header-title">📝 Change notes for ${escapeHtml(number)}</div>
        <div class="sn-muted">Saved privately in this browser • shown wherever you open this change</div>
      </div>
      ${notesSectionHtml}
    `;

    panel.innerHTML = workspaceTicket.mode === 'notes' ? notesOnlyHtml : `
      <div class="sn-ws-header">
        <div class="sn-ws-header-title">Your workspace for ${escapeHtml(number)}</div>
        <div class="sn-muted">Saved privately in this browser</div>
      </div>

      <section class="sn-ws-section">
        <div class="sn-ws-title">🐞 Known Bugs <span class="sn-ws-count">${linked.length}</span></div>
        <div class="sn-ws-chips">${linked.length ? linked.map((b) => bugChipHtml(b, true)).join('') : '<span class="sn-muted">Not linked to a known bug.</span>'}</div>
        ${linkable.length ? `
          <div class="sn-ws-row">
            <select id="sn-ws-bug-select" class="sn-links-input" data-keep>
              <option value="">Link a known bug…</option>
              ${linkableActive.length ? `<optgroup label="Active">${linkableActive.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}</option>`).join('')}</optgroup>` : ''}
              ${linkableResolved.length ? `<optgroup label="Resolved">${linkableResolved.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}</option>`).join('')}</optgroup>` : ''}
            </select>
            <button type="button" class="sn-ws-btn" data-ws-action="link-bug">Link</button>
          </div>` : ''}
        <details class="sn-ws-details" id="sn-ws-newbug-details">
          <summary>＋ Create a new known bug and link it</summary>
          <div class="sn-ws-stack">
            <input type="text" id="sn-ws-newbug-title" class="sn-links-input" data-keep placeholder="Bug title *" autocomplete="off" />
            <input type="text" id="sn-ws-newbug-ref" class="sn-links-input" data-keep placeholder="Reference (e.g. PRB0012345, JIRA-123)" autocomplete="off" />
            <button type="button" class="sn-ws-btn sn-ws-btn-primary" data-ws-action="create-bug">Create &amp; link</button>
          </div>
        </details>
      </section>

      <section class="sn-ws-section">
        <div class="sn-ws-title">☑ Tasks <span class="sn-ws-count">${openTasks.length} open</span></div>
        <div class="sn-ws-tasks">${openTasks.length ? openTasks.map(taskRow).join('') : '<span class="sn-muted">No open tasks.</span>'}</div>
        <div class="sn-ws-stack sn-ws-add-task">
          <input type="text" id="sn-ws-task-title" class="sn-links-input" data-keep placeholder="New task… (Enter to add)" autocomplete="off" />
          <div class="sn-ws-row">
            <input type="date" id="sn-ws-task-date" class="sn-links-input" data-keep title="Due date" />
            <input type="time" id="sn-ws-task-time" class="sn-links-input" data-keep title="Due time" />
          </div>
          <div class="sn-ws-row">
            <select id="sn-ws-task-reminder" class="sn-links-input" data-keep title="Reminder (needs a due date; date-only tasks remind at 09:00)">
              <option value="0">🔔 At due time</option>
              <option value="15">🔔 15 min before</option>
              <option value="60">🔔 1 hour before</option>
              <option value="1440">🔔 1 day before</option>
              <option value="none">No reminder</option>
            </select>
            <button type="button" class="sn-ws-btn sn-ws-btn-primary" data-ws-action="add-task">Add Task</button>
          </div>
        </div>
        ${doneTasks.length ? `
          <details class="sn-ws-details" id="sn-ws-done-details">
            <summary>Completed (${doneTasks.length})</summary>
            <div class="sn-ws-tasks">${doneTasks.map(taskRow).join('')}</div>
          </details>` : ''}
      </section>

      ${notesSectionHtml}
    `;

    Object.keys(kept).forEach((id) => {
      const el = document.getElementById(id);
      if (el && kept[id] !== undefined && kept[id] !== '') el.value = kept[id];
    });
    Object.keys(openDetails).forEach((id) => {
      const d = document.getElementById(id);
      if (d) d.open = openDetails[id];
    });
    if (focusedId) document.getElementById(focusedId)?.focus();
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      if (!btn) return;
      const orig = btn.innerText;
      btn.innerText = '✓ Copied';
      setTimeout(() => { btn.innerText = orig; }, 1500);
    }).catch(() => alert('Could not copy to clipboard.'));
  }

  function initWorkspacePanelEvents() {
    const panel = document.getElementById('sn-ws-panel');
    if (!panel) return;

    const valueOf = (id) => (document.getElementById(id)?.value || '').trim();
    const clear = (...ids) => ids.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });

    const addTask = () => {
      if (!workspaceTicket) return;
      const title = valueOf('sn-ws-task-title');
      if (!title) { document.getElementById('sn-ws-task-title')?.focus(); return; }
      const dueDate = valueOf('sn-ws-task-date');
      const dueTime = valueOf('sn-ws-task-time');
      if (dueTime && !dueDate) { alert('Please choose a due date to go with the time.'); return; }
      const entry = getTicketEntry(workspaceTicket.number, true);
      rememberTicketSnapshot(entry, workspaceTicket);
      entry.tasks.push({ id: newId('task'), title, dueDate, dueTime, reminder: valueOf('sn-ws-task-reminder') || '0', done: false, doneAt: null, createdAt: Date.now() });
      clear('sn-ws-task-title', 'sn-ws-task-date', 'sn-ws-task-time');
      const rem = document.getElementById('sn-ws-task-reminder');
      if (rem) rem.value = '0';
      saveTicketData();
      document.getElementById('sn-ws-task-title')?.focus();
    };

    const addNote = () => {
      if (!workspaceTicket) return;
      const text = valueOf('sn-ws-note-input');
      if (!text) { document.getElementById('sn-ws-note-input')?.focus(); return; }
      const entry = getTicketEntry(workspaceTicket.number, true);
      rememberTicketSnapshot(entry, workspaceTicket);
      entry.notes.push({ id: newId('note'), text, createdAt: Date.now() });
      clear('sn-ws-note-input');
      saveTicketData();
    };

    panel.addEventListener('keydown', (e) => {
      if (e.target.id === 'sn-ws-task-title' && e.key === 'Enter') { e.preventDefault(); addTask(); }
      if (e.target.id === 'sn-ws-note-input' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); }
      if (e.target.id === 'sn-ws-newbug-title' && e.key === 'Enter') { e.preventDefault(); panel.querySelector('[data-ws-action="create-bug"]')?.click(); }
    });

    panel.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ws-action]');
      if (!el || !workspaceTicket) return;
      e.preventDefault();
      const action = el.getAttribute('data-ws-action');
      const id = el.getAttribute('data-id');
      const number = workspaceTicket.number;
      const entry = getTicketEntry(number, false);

      if (action === 'add-task') return addTask();
      if (action === 'add-note') return addNote();

      if (action === 'link-bug') {
        const bugId = valueOf('sn-ws-bug-select');
        if (!bugId) return;
        const e2 = getTicketEntry(number, true);
        rememberTicketSnapshot(e2, workspaceTicket);
        if (!e2.bugIds.includes(bugId)) e2.bugIds.push(bugId);
        clear('sn-ws-bug-select');
        saveTicketData();
        return;
      }
      if (action === 'create-bug') {
        const title = valueOf('sn-ws-newbug-title');
        if (!title) { document.getElementById('sn-ws-newbug-title')?.focus(); return; }
        const bug = { id: newId('bug'), title, reference: valueOf('sn-ws-newbug-ref'), status: 'open', description: '', workaround: '', createdAt: Date.now(), updatedAt: Date.now() };
        knownBugs.push(bug);
        persist(BUGS_KEY, knownBugs);
        const e2 = getTicketEntry(number, true);
        rememberTicketSnapshot(e2, workspaceTicket);
        e2.bugIds.push(bug.id);
        clear('sn-ws-newbug-title', 'sn-ws-newbug-ref');
        const d = document.getElementById('sn-ws-newbug-details');
        if (d) d.open = false;
        saveTicketData();
        showSimpleToast('🐞 Known bug created', `"${title}" was linked to ${number}. Add details on the Known Bugs page.`, '#f59e0b');
        return;
      }
      if (!entry) return;

      if (action === 'unlink-bug') {
        entry.bugIds = entry.bugIds.filter((b) => b !== id);
        saveTicketData();
      } else if (action === 'toggle-task') {
        const t = entry.tasks.find((x) => x.id === id);
        if (!t) return;
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        saveTicketData();
      } else if (action === 'delete-task') {
        const t = entry.tasks.find((x) => x.id === id);
        if (t && confirm(`Delete task "${t.title}"?`)) {
          entry.tasks = entry.tasks.filter((x) => x.id !== id);
          saveTicketData();
        }
      } else if (action === 'delete-note') {
        if (confirm('Delete this note?')) {
          entry.notes = entry.notes.filter((x) => x.id !== id);
          saveTicketData();
        }
      } else if (action === 'copy-note') {
        const n = entry.notes.find((x) => x.id === id);
        if (n) copyText(n.text, el);
      } else if (action === 'copy-notes') {
        const text = entry.notes.slice()
          .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
          .map((n) => `[${formatTimestamp(n.createdAt)}]\n${n.text}`)
          .join('\n\n');
        copyText(text, el);
      }
    });
  }

  // ----- Known Bugs page -----
  function bugSummaryText(bug) {
    const numbers = getBugTicketNumbers(bug.id);
    const lines = [`Known Bug: ${bug.title}`];
    if (bug.reference) lines.push(`Reference: ${bug.reference}`);
    lines.push(`Status: ${BUG_STATUS_LABEL[bug.status] || 'Open'}`);
    if (bug.description) lines.push('', 'Description:', bug.description);
    if (bug.workaround) lines.push('', 'Workaround:', bug.workaround);
    lines.push('', `Affected tickets (${numbers.length}):`);
    numbers.forEach((n) => {
      const e = ticketData[n];
      const live = liveTicketStates[n];
      lines.push(`- ${n}${e?.shortDesc ? ` — ${e.shortDesc}` : ''}${live?.state ? ` [${live.state}]` : ''}`);
    });
    return lines.join('\n');
  }

  function renderBugs() {
    const listEl = document.getElementById('sn-bug-list');
    const filterEl = document.getElementById('sn-bug-filter');
    if (!listEl) return;

    const counts = {
      active: knownBugs.filter((b) => b.status !== 'resolved').length,
      resolved: knownBugs.filter((b) => b.status === 'resolved').length,
      all: knownBugs.length
    };
    if (filterEl) {
      filterEl.innerHTML = [['active', 'Active'], ['resolved', 'Resolved'], ['all', 'All']]
        .map(([k, label]) => `<button class="sn-cat-pill ${bugsStatusFilter === k ? 'active' : ''}" data-filter="${k}">${label} (${counts[k]})</button>`)
        .join('');
    }

    const search = (document.getElementById('sn-bug-search')?.value || '').trim().toLowerCase();
    const items = knownBugs
      .filter((b) => {
        if (bugsStatusFilter === 'active' && b.status === 'resolved') return false;
        if (bugsStatusFilter === 'resolved' && b.status !== 'resolved') return false;
        if (!search) return true;
        const hay = [b.title, b.reference, b.description, b.workaround, ...getBugTicketNumbers(b.id)].join(' ').toLowerCase();
        return hay.includes(search);
      })
      .map((b) => ({ b, numbers: getBugTicketNumbers(b.id) }))
      .sort((x, y) => (y.numbers.length - x.numbers.length) || ((y.b.createdAt || 0) - (x.b.createdAt || 0)));

    if (items.length === 0) {
      listEl.innerHTML = `<div class="sn-empty-box">${knownBugs.length === 0
        ? 'No known bugs yet. Click <strong>➕ New Known Bug</strong>, or create one from a ticket on the Assigned to Me page.'
        : 'No bugs match this filter.'}</div>`;
      return;
    }

    listEl.innerHTML = items.map(({ b, numbers }) => {
      const status = b.status || 'open';
      const openCount = numbers.filter((n) => !liveTicketStates[n]?.closed).length;
      return `
        <div class="sn-bug-card sn-bug-card-${escapeHtml(status)}">
          <div class="sn-bug-top">
            <span class="sn-bug-title">🐞 ${escapeHtml(b.title)}</span>
            <span class="sn-pill sn-bug-status-${escapeHtml(status)}">${escapeHtml(BUG_STATUS_LABEL[status] || 'Open')}</span>
            ${b.reference ? `<span class="sn-pill sn-pill-ref">${escapeHtml(b.reference)}</span>` : ''}
            <span class="sn-pill sn-pill-count" title="${openCount} still open">${numbers.length} ticket${numbers.length === 1 ? '' : 's'}${numbers.length && openCount !== numbers.length ? ` · ${openCount} open` : ''}</span>
          </div>
          ${b.description ? `<p class="sn-bug-desc">${escapeHtml(b.description)}</p>` : ''}
          ${b.workaround ? `<div class="sn-bug-workaround"><span class="sn-bug-label">Workaround</span>${escapeHtml(b.workaround)}</div>` : ''}
          <div class="sn-bug-tickets">
            ${numbers.length ? numbers.map((n) => {
              const e = ticketData[n];
              const live = liveTicketStates[n];
              return `<button type="button" class="sn-bug-ticket ${live?.closed ? 'is-closed' : ''}" data-bug-action="open-ticket" data-number="${escapeHtml(n)}" title="Open ${escapeHtml(n)}">
                <strong>${escapeHtml(n)}</strong>${live?.state ? ` · ${escapeHtml(live.state)}` : ''}${e?.shortDesc ? ` — ${escapeHtml(e.shortDesc)}` : ''}
              </button>`;
            }).join('') : '<span class="sn-muted">No tickets linked yet. Open a ticket from Assigned to Me to link it.</span>'}
          </div>
          <div class="sn-bug-footer">
            <span class="sn-muted">Created ${escapeHtml(formatTimestamp(b.createdAt))}${b.updatedAt && b.updatedAt !== b.createdAt ? ` • Updated ${escapeHtml(formatTimestamp(b.updatedAt))}` : ''}</span>
            <div class="sn-link-actions">
              <button class="sn-link-icon-btn" data-bug-action="copy" data-id="${escapeHtml(b.id)}" title="Copy a summary with all affected tickets">📋 Copy summary</button>
              <button class="sn-link-icon-btn" data-bug-action="edit" data-id="${escapeHtml(b.id)}">Edit</button>
              <button class="sn-link-icon-btn danger" data-bug-action="delete" data-id="${escapeHtml(b.id)}">Delete</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function initBugsEvents() {
    const formCard = document.getElementById('sn-bug-form-card');
    const toggleBtn = document.getElementById('sn-bug-toggle-form-btn');
    const heading = document.getElementById('sn-bug-form-heading');
    const saveBtn = document.getElementById('sn-bug-save-btn');
    const listEl = document.getElementById('sn-bug-list');
    const f = {
      title: document.getElementById('sn-bug-title'),
      reference: document.getElementById('sn-bug-ref'),
      status: document.getElementById('sn-bug-status'),
      description: document.getElementById('sn-bug-desc'),
      workaround: document.getElementById('sn-bug-workaround')
    };
    if (!formCard || !listEl) return;

    const openForm = (bug) => {
      editingBugId = bug ? bug.id : null;
      f.title.value = bug?.title || '';
      f.reference.value = bug?.reference || '';
      f.status.value = bug?.status || 'open';
      f.description.value = bug?.description || '';
      f.workaround.value = bug?.workaround || '';
      heading.innerText = bug ? '✏️ Edit Known Bug' : '🐞 New Known Bug';
      saveBtn.innerText = bug ? 'Save Changes' : 'Save Bug';
      formCard.classList.remove('sn-hidden');
      toggleBtn.innerText = '✕ Close Form';
      formCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      f.title.focus();
    };
    const closeForm = () => {
      editingBugId = null;
      Object.values(f).forEach((el) => { el.value = ''; });
      f.status.value = 'open';
      formCard.classList.add('sn-hidden');
      toggleBtn.innerText = '➕ New Known Bug';
    };
    const save = () => {
      const title = f.title.value.trim();
      if (!title) { alert('Please enter a bug title.'); f.title.focus(); return; }
      const data = {
        title,
        reference: f.reference.value.trim(),
        status: f.status.value || 'open',
        description: f.description.value.trim(),
        workaround: f.workaround.value.trim()
      };
      if (editingBugId) {
        const b = knownBugs.find((x) => x.id === editingBugId);
        if (b) Object.assign(b, data, { updatedAt: Date.now() });
      } else {
        knownBugs.push({ id: newId('bug'), ...data, createdAt: Date.now(), updatedAt: Date.now() });
      }
      closeForm();
      saveKnownBugs();
    };

    toggleBtn.addEventListener('click', () => (formCard.classList.contains('sn-hidden') ? openForm(null) : closeForm()));
    document.getElementById('sn-bug-cancel-btn').addEventListener('click', closeForm);
    saveBtn.addEventListener('click', save);
    f.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

    document.getElementById('sn-bug-filter')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-filter]');
      if (!btn) return;
      bugsStatusFilter = btn.getAttribute('data-filter');
      localStorage.setItem('sn_helper_bugs_filter', bugsStatusFilter);
      renderBugs();
    });
    document.getElementById('sn-bug-search')?.addEventListener('input', renderBugs);

    listEl.addEventListener('click', (e) => {
      const el = e.target.closest('[data-bug-action]');
      if (!el) return;
      e.preventDefault();
      const action = el.getAttribute('data-bug-action');
      if (action === 'open-ticket') {
        openWorkspaceForNumber(el.getAttribute('data-number'));
        return;
      }
      const bug = knownBugs.find((b) => b.id === el.getAttribute('data-id'));
      if (!bug) return;
      if (action === 'edit') openForm(bug);
      else if (action === 'copy') copyText(bugSummaryText(bug), el);
      else if (action === 'delete') {
        const n = getBugTicketNumbers(bug.id).length;
        if (!confirm(`Delete known bug "${bug.title}"?${n ? ` It will be unlinked from ${n} ticket${n === 1 ? '' : 's'}.` : ''}`)) return;
        knownBugs = knownBugs.filter((b) => b.id !== bug.id);
        Object.values(ticketData).forEach((entry) => {
          entry.bugIds = (entry.bugIds || []).filter((id) => id !== bug.id);
        });
        if (editingBugId === bug.id) closeForm();
        persist(BUGS_KEY, knownBugs);
        saveTicketData();
      }
    });

    // Export / import: bugs plus which tickets they're linked to (notes & tasks stay private)
    document.getElementById('sn-bugs-export-btn')?.addEventListener('click', () => {
      const links = {};
      Object.keys(ticketData).forEach((n) => {
        const e = ticketData[n];
        if ((e.bugIds || []).length) links[n] = { bugIds: e.bugIds, sysId: e.sysId || '', table: e.table || '', shortDesc: e.shortDesc || '' };
      });
      const payload = { type: 'sn-simplifier-known-bugs', version: 1, exportedAt: new Date().toISOString(), bugs: knownBugs, links };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `known-bugs-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });

    const importInput = document.getElementById('sn-bugs-import-input');
    document.getElementById('sn-bugs-import-btn')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || data.type !== 'sn-simplifier-known-bugs' || !Array.isArray(data.bugs)) throw new Error('This file is not a Known Bugs export.');
        let added = 0;
        let updated = 0;
        let linked = 0;
        data.bugs.forEach((b) => {
          if (!b || !b.id || !b.title) return;
          const clean = {
            id: String(b.id), title: String(b.title), reference: String(b.reference || ''),
            status: ['open', 'fixing', 'resolved'].includes(b.status) ? b.status : 'open',
            description: String(b.description || ''), workaround: String(b.workaround || ''),
            createdAt: Number(b.createdAt) || Date.now(), updatedAt: Number(b.updatedAt) || Date.now()
          };
          const existing = knownBugs.find((x) => x.id === clean.id);
          if (!existing) { knownBugs.push(clean); added++; }
          else if ((clean.updatedAt || 0) > (existing.updatedAt || 0)) { Object.assign(existing, clean); updated++; }
        });
        const validIds = new Set(knownBugs.map((b) => b.id));
        Object.keys(data.links || {}).forEach((num) => {
          const link = data.links[num] || {};
          const ids = (Array.isArray(link.bugIds) ? link.bugIds : []).map(String).filter((id) => validIds.has(id));
          if (!ids.length || !/^[A-Za-z]+\d+$/.test(num)) return;
          const entry = getTicketEntry(num, true);
          rememberTicketSnapshot(entry, { sysId: String(link.sysId || ''), table: String(link.table || ''), shortDesc: String(link.shortDesc || '') });
          ids.forEach((id) => { if (!entry.bugIds.includes(id)) { entry.bugIds.push(id); linked++; } });
        });
        persist(BUGS_KEY, knownBugs);
        saveTicketData();
        refreshLiveTicketStates();
        showSimpleToast('⬆ Known Bugs imported', `${added} new, ${updated} updated, ${linked} ticket link(s) added.`, '#22c55e');
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    });
  }

  function getStateBadgeClass(stateText) {
    if (!stateText) return 'state-default';
    const clean = stateText.toLowerCase().trim();
    
    if (clean.includes('approved')) {
      return 'state-approved';
    }
    if (clean.includes('requested')) {
      return 'state-requested';
    }
    if (clean.includes('open') || clean.includes('new') || clean.includes('in progress') || clean.includes('implement')) {
      return 'state-open';
    }
    if (clean.includes('hold') || clean.includes('pending') || clean.includes('awaiting') || clean.includes('assess') || clean.includes('authorize') || clean.includes('scheduled')) {
      return 'state-on-hold';
    }
    if (clean.includes('resolved') || clean.includes('closed') || clean.includes('completed') || clean.includes('review')) {
      return 'state-resolved';
    }
    if (clean.includes('cancel') || clean.includes('reject')) {
      return 'state-cancelled';
    }
    return 'state-default';
  }

  // Shrinks the hub to fit the screen height (down to MIN_SCALE) so smaller displays
  // see the whole hub without scrolling. Below that it scrolls, starting from the top.
  function setupHubAutoScale() {
    const area = document.querySelector('.sn-hub-main-area');
    const wrapper = document.getElementById('sn-hub-wrapper');
    if (!area || !wrapper || typeof ResizeObserver === 'undefined') return;

    const MIN_SCALE = 0.7;
    const STACKED_LAYOUT_MAX_WIDTH = 1100; // matches the @media rule in styles.css
    let frame = null;

    const fit = () => {
      frame = null;
      wrapper.style.zoom = '';
      if (window.innerWidth <= STACKED_LAYOUT_MAX_WIDTH || area.clientHeight === 0) return;

      const cs = getComputedStyle(area);
      const availableHeight = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const naturalHeight = wrapper.offsetHeight;
      if (naturalHeight > availableHeight) {
        wrapper.style.zoom = Math.max(MIN_SCALE, availableHeight / naturalHeight).toFixed(3);
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };

    new ResizeObserver(schedule).observe(area);
    window.addEventListener('resize', schedule);
    schedule();
  }

  function init() {
    const checkExist = setInterval(() => {
      if (getAuthToken() && document.body) {
        clearInterval(checkExist);
        buildUI();
        setupHubAutoScale();
        fetchTickets();
        fetchChanges();
        keepSessionAlive();
        checkForExtensionUpdate();
        setInterval(() => {
          fetchTickets();
          fetchChanges();
          keepSessionAlive();
          fetchMyTickets();
          if (currentView === 'bugs') refreshLiveTicketStates();
          renderMineHubTile();
        }, POLL_INTERVAL_MS);
        fetchMyTickets();
        checkTaskReminders();
        setInterval(checkTaskReminders, TASK_REMINDER_CHECK_MS);
        initPersonalDataCrossTabSync();
        loadPwData().then(() => { checkPwReminders(); if (currentView === 'passwords') refreshPwStatus(); });
        setInterval(checkPwReminders, 60 * 60 * 1000);
        setInterval(checkForExtensionUpdate, UPDATE_CHECK_INTERVAL_MS);
      }
    }, 1500);
  }

  init();
})();

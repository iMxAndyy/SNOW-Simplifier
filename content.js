(function () {
  if (window.top !== window.self) return;

  // Version & GitHub Auto-Check Config
  const FALLBACK_VERSION = '1.0.1';
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

  // --- CHANGE MANAGEMENT STATE ---
  let allChanges = [];
  let chgSelectedGroup = localStorage.getItem('sn_helper_chg_group') || DEFAULT_GROUP;
  let chgSelectedAssigned = localStorage.getItem('sn_helper_chg_assigned') || 'ALL';
  let chgSelectedRequested = localStorage.getItem('sn_helper_chg_requested') || 'ALL';
  let savedChgApprovalsRaw = localStorage.getItem('sn_helper_chg_approvals');
  let chgSelectedApprovals = savedChgApprovalsRaw ? JSON.parse(savedChgApprovalsRaw) : null;

  function getLocalVersion() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        return chrome.runtime.getManifest().version;
      }
    } catch (e) {}
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

        if (banner && bannerText) {
          bannerText.innerHTML = `🚀 <strong>Update Available (v${remoteVer})!</strong> You are currently on v${localVer}. Run <code>Update_Extension.bat</code> in your extension folder, then refresh ServiceNow.`;
          banner.classList.remove('sn-hidden');
        }
      }
    } catch (err) {
      // Silently ignore if GitHub repo hasn't been populated yet or blocked by network
    }
  }

  function getAuthToken() {
    return window.g_ck || window.NOW?.user_token || window.NOW?.g_ck || null;
  }

  let lastDeepKeepAlive = 0;

  function keepSessionAlive() {
    const token = getAuthToken();
    if (!token) return;

    // Use ServiceNow's built-in UserPreference processor endpoint.
    // This is a lightweight backend transaction that securely resets the server-side session timer
    // without touching the UI DOM or triggering any page refreshes or flashes.
    fetch(`/xmlhttp.do?sysparm_processor=UserPreference&sysparm_type=get&sysparm_name=my_home_navigation_page&_=${Date.now()}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'X-UserToken': token
      }
    }).catch(() => {});

    // Auto-click any unexpected session warning modal buttons if they appear on screen
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

  let cachedUserId = localStorage.getItem('sn_helper_user_sys_id') || null;

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

  async function resolveCurrentUserId() {
    const existing = getCurrentUserId();
    if (existing) return existing;

    const token = getAuthToken();
    if (!token) return null;

    try {
      const res = await fetch('/api/now/table/sys_user?sysparm_query=sys_id=javascript:gs.getUserID()&sysparm_fields=sys_id,name&sysparm_limit=1', {
        headers: { 'Accept': 'application/json', 'X-UserToken': token }
      });
      if (res.ok) {
        const data = (await res.json()).result || [];
        if (data.length > 0 && data[0].sys_id) {
          cachedUserId = data[0].sys_id;
          localStorage.setItem('sn_helper_user_sys_id', cachedUserId);
          return cachedUserId;
        }
      }
    } catch (err) {
      console.warn('Could not resolve user sys_id from API:', err);
    }
    return null;
  }

  function getVal(field) {
    if (!field) return '';
    if (typeof field === 'object') return (field.display_value || field.value || '').trim();
    return String(field).trim();
  }

  function getFirstAvailable(record, fieldNames) {
    for (const f of fieldNames) {
      const val = getVal(record[f]);
      if (val) return val;
    }
    return '';
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
      <div class="sn-toast-title">${ticket.number} • Priority: ${ticket.priority || '—'}</div>
      <div class="sn-toast-desc">${ticket.short_description || 'No description'}</div>
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
      <option value="${g}" ${notificationGroup === g ? 'selected' : ''}>${g}</option>
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
      changes: document.getElementById('sn-view-changes')
    };

    Object.keys(views).forEach(k => {
      if (views[k]) views[k].classList.toggle('sn-view-hidden', k !== currentView);
    });
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
        <div class="sn-hub-wrapper">
          <div class="sn-hub-hero">
            <h1>Support Hub <span style="font-size: 14px; font-weight: 500; color: #64748b; vertical-align: middle;">v${localVer}</span></h1>
            <p>Fast-access operational workspace for ServiceNow. Triage incoming unassigned tickets, search existing cases, or review change requests while background monitoring runs continuously.</p>
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
        </div>
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
        <div class="sn-preview-body">
          <div class="sn-preview-meta-grid" id="sn-modal-meta-grid"></div>

          <div class="sn-preview-section">
            <span class="sn-preview-section-title">Short Description</span>
            <div class="sn-preview-desc-box" id="sn-modal-short-desc" style="max-height: 80px;">—</div>
          </div>

          <div class="sn-preview-section">
            <span class="sn-preview-section-title">Full Description / Notes</span>
            <div class="sn-preview-desc-box" id="sn-modal-desc">Loading description...</div>
          </div>
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

    const closePreview = () => previewModal.classList.remove('show');
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

    const chgDropBtn = document.getElementById('sn-chg-approval-drop-btn');
    const chgDropContent = document.getElementById('sn-chg-approval-drop-content');
    chgDropBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chgDropContent.classList.toggle('show');
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
          return; // Exit cleanly without throwing an error
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
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 28px; color: #94a3b8;">🎉 All clear! No unassigned CS or INC tickets in <strong>${targetGroup}</strong>.</td></tr>`;
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
            <td><span class="sn-type-badge">${prefix}</span><a class="sn-link" href="#" data-sysid="${t.sys_id}">${t.number}</a></td>
            <td><span class="sn-badge ${prioClass}">${t.priority || '—'}</span></td>
            <td><span class="sn-state-badge ${stateClass}">${stateVal}</span></td>
            <td>${t.short_description || ''}</td>
            <td>${groupName}</td>
            <td><span class="sn-unassigned-pill">Unassigned</span> <button class="sn-assign-btn" data-sysid="${t.sys_id}">Assign to me</button></td>
            <td>${t.opened_at || ''}</td>
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
      groupOpts += `<option value="${g}" ${selectedGroup === g ? 'selected' : ''}>${g}</option>`;
    });
    groupSelect.innerHTML = groupOpts;

    const checkboxesContainer = document.getElementById('sn-state-checkboxes');
    if (checkboxesContainer) {
      checkboxesContainer.innerHTML = sortedStates.map((st) => {
        const isChecked = selectedStates.includes(st) ? 'checked' : '';
        return `
          <label class="sn-dropdown-item">
            <input type="checkbox" value="${st}" ${isChecked} class="sn-state-cb" />
            ${st}
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
        userOpts += `<option value="${u}" ${selectedUser === u ? 'selected' : ''}>${u}</option>`;
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
          ? rawUser 
          : `<span class="sn-unassigned-pill">Unassigned</span> <button class="sn-assign-btn" data-sysid="${t.sys_id}">Assign to me</button>`;
        
        const prefix = getTicketPrefix(t.number);
        const prioNum = (t.priority || '').charAt(0);
        const prioClass = prioNum === '1' || prioNum === '2' ? `sn-priority-${prioNum}` : '';

        const stateVal = t.state || '—';
        const stateClass = getStateBadgeClass(stateVal);

        return `
          <tr>
            <td><span class="sn-type-badge">${prefix}</span><a class="sn-link" href="#" data-sysid="${t.sys_id}">${t.number}</a></td>
            <td><span class="sn-badge ${prioClass}">${t.priority || '—'}</span></td>
            <td><span class="sn-state-badge ${stateClass}">${stateVal}</span></td>
            <td>${t.short_description || ''}</td>
            <td>${groupName}</td>
            <td>${assignedToHtml}</td>
            <td>${t.opened_at || ''}</td>
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

    const fields = 'sys_id,number,priority,state,short_description,assignment_group,assigned_to,opened_at,approval,type,start_date,end_date,requested_by';
    const headers = { 'Accept': 'application/json', 'X-UserToken': token };

    try {
      if (statusText) statusText.innerText = 'Refreshing change requests...';

      const globalQuery = 'active=true^ORDERBYDESCsys_created_on';
      const globalUrl = `/api/now/table/change_request?sysparm_query=${encodeURIComponent(globalQuery)}&sysparm_limit=200&sysparm_display_value=true&sysparm_fields=${fields}`;

      const requests = [fetch(globalUrl, { headers })];
      if (chgSelectedGroup !== 'ALL') {
        const groupQuery = `active=true^assignment_group.name=${chgSelectedGroup}^ORDERBYDESCsys_created_on`;
        const groupUrl = `/api/now/table/change_request?sysparm_query=${encodeURIComponent(groupQuery)}&sysparm_limit=200&sysparm_display_value=true&sysparm_fields=${fields}`;
        requests.push(fetch(groupUrl, { headers }));
      }

      const responses = await Promise.all(requests);
      for (const r of responses) {
        if (r.status === 401 || r.status === 403) {
          if (statusText) statusText.innerText = 'Session expired or unauthorized. Please log in or refresh the page.';
          return; // Exit cleanly without throwing an error
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }

      const jsonPayloads = await Promise.all(responses.map((r) => r.json()));
      const chgMap = new Map();
      jsonPayloads.forEach((payload) => {
        (payload.result || []).forEach((c) => {
          chgMap.set(c.number, c);
        });
      });

      allChanges = Array.from(chgMap.values());
      updateChangeDropdowns();
      applyChangeFiltersAndRender();
    } catch (err) {
      console.warn('SN Helper Change Fetch Warning:', err.message);
      if (statusText) statusText.innerText = `Connection issue (${err.message}).`;
    }
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
      const gName = c.assignment_group?.display_value || 'Unassigned Group';
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
      groupOpts += `<option value="${g}" ${chgSelectedGroup === g ? 'selected' : ''}>${g}</option>`;
    });
    groupSelect.innerHTML = groupOpts;

    const checkboxesContainer = document.getElementById('sn-chg-approval-checkboxes');
    if (checkboxesContainer) {
      checkboxesContainer.innerHTML = sortedApprovals.map((ap) => {
        const isChecked = chgSelectedApprovals.includes(ap) ? 'checked' : '';
        return `
          <label class="sn-dropdown-item">
            <input type="checkbox" value="${ap}" ${isChecked} class="sn-chg-ap-cb" />
            ${ap}
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
      const gName = c.assignment_group?.display_value || 'Unassigned Group';
      return chgSelectedGroup === 'ALL' || gName === chgSelectedGroup;
    });

    if (chgSelectedApprovals && chgSelectedApprovals.length > 0) {
      filtered = filtered.filter((c) => chgSelectedApprovals.includes(getVal(c.approval) || 'Not Yet Requested'));
    } else {
      filtered = [];
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
        assOpts += `<option value="${u}" ${chgSelectedAssigned === u ? 'selected' : ''}>${u}</option>`;
      });
      assignedSelect.innerHTML = assOpts;
    }

    if (requestedSelect) {
      let reqOpts = `<option value="ALL" ${chgSelectedRequested === 'ALL' ? 'selected' : ''}>All Requesters (${sortedRequested.length})</option>`;
      sortedRequested.forEach((u) => {
        reqOpts += `<option value="${u}" ${chgSelectedRequested === u ? 'selected' : ''}>${u}</option>`;
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
        const rawUser = getVal(c.assigned_to);
        const assignedToHtml = rawUser 
          ? rawUser 
          : `<span class="sn-unassigned-pill">Unassigned</span> <button class="sn-assign-btn" data-sysid="${c.sys_id}">Assign to me</button>`;

        const requestedByName = getVal(c.requested_by) || '—';
        const chgType = getVal(c.type) || '—';
        const approvalVal = getVal(c.approval) || '—';
        const approvalClass = getStateBadgeClass(approvalVal);
        const stateVal = getVal(c.state) || '—';
        const stateClass = getStateBadgeClass(stateVal);

        const start = getVal(c.start_date);
        const end = getVal(c.end_date);
        const scheduleHtml = start 
          ? `<div><strong>Start:</strong> ${start}</div>${end ? `<div style="font-size:12px; color:#94a3b8;"><strong>End:</strong> ${end}</div>` : ''}`
          : '<span style="color:#94a3b8;">Not scheduled</span>';

        return `
          <tr>
            <td><span class="sn-type-badge">CHG</span><a class="sn-link" href="#" data-sysid="${c.sys_id}">${c.number}</a></td>
            <td><span class="sn-badge">${chgType}</span></td>
            <td><span class="sn-state-badge ${approvalClass}">${approvalVal}</span></td>
            <td><span class="sn-state-badge ${stateClass}">${stateVal}</span></td>
            <td>${c.short_description || ''}</td>
            <td>${scheduleHtml}</td>
            <td>${assignedToHtml}</td>
            <td>${requestedByName}</td>
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

  async function openTicketPreview(sysId, forcedType) {
    const token = getAuthToken();
    if (!token) return;

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
        const childService = getFirstAvailable(data, ['service_offering', 'u_child_service', 'u_sub_service']) || '—';
        const configItem = getFirstAvailable(data, ['cmdb_ci', 'u_configuration_item']) || '—';
        const groupName = getVal(data.assignment_group) || 'Unassigned Group';

        metaGrid.innerHTML = `
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">State & Type</span>
            <span class="sn-preview-meta-val">${stateType}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Approval Status</span>
            <span class="sn-preview-meta-val">${approvalStatus}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Requested By</span>
            <span class="sn-preview-meta-val">${requestedBy}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assigned To</span>
            <span class="sn-preview-meta-val">${assignedTo}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Scheduled Start</span>
            <span class="sn-preview-meta-val">${schedStart}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Scheduled End</span>
            <span class="sn-preview-meta-val">${schedEnd}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Approved By</span>
            <span class="sn-preview-meta-val">${approvedByStr}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assignment Group</span>
            <span class="sn-preview-meta-val">${groupName}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Parent / Child Service</span>
            <span class="sn-preview-meta-val">${parentService} / ${childService}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Configuration Item (CI)</span>
            <span class="sn-preview-meta-val">${configItem}</span>
          </div>
        `;

        if (!getVal(data.assigned_to)) {
          assignBtn.style.display = 'block';
          assignBtn.innerText = 'Assign to me';
          assignBtn.onclick = async () => {
            await assignToMe(data.sys_id, assignBtn);
            openTicketPreview(sysId, 'CHG');
          };
        }

        document.getElementById('sn-modal-native-link').onclick = () => {
          window.location.href = `/now/cwf/agent/record/change_request/${data.sys_id}`;
        };

      } else {
        const res = await fetch(`/api/now/table/task/${sysId}?sysparm_display_value=true&sysparm_fields=sys_id,number,priority,state,short_description,description,assignment_group,assigned_to,opened_at`, {
          headers
        });
        
        if (!res.ok) throw new Error('Failed to load ticket details.');
        const data = (await res.json()).result;
        const prefix = getTicketPrefix(data.number);

        document.getElementById('sn-modal-number').innerText = data.number;
        document.getElementById('sn-modal-prefix').innerText = prefix;
        document.getElementById('sn-modal-short-desc').innerText = data.short_description || 'No short description provided.';
        document.getElementById('sn-modal-desc').innerText = data.description || 'No description provided for this task.';

        metaGrid.innerHTML = `
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">State / Priority</span>
            <span class="sn-preview-meta-val">${data.state || '—'} (Priority: ${data.priority || '—'})</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assignment Group</span>
            <span class="sn-preview-meta-val">${data.assignment_group?.display_value || 'Unassigned Group'}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Assigned To</span>
            <span class="sn-preview-meta-val">${data.assigned_to?.display_value || 'Unassigned'}</span>
          </div>
          <div class="sn-preview-meta-item">
            <span class="sn-preview-meta-label">Opened At</span>
            <span class="sn-preview-meta-val">${data.opened_at || '—'}</span>
          </div>
        `;

        const rawAssigned = (data.assigned_to?.display_value || '').trim();
        if (!rawAssigned) {
          assignBtn.style.display = 'block';
          assignBtn.innerText = 'Assign to me';
          assignBtn.onclick = async () => {
            await assignToMe(data.sys_id, assignBtn);
            openTicketPreview(sysId, 'CS');
          };
        }

        const recordUrl = `/now/cwf/agent/record/task/${data.sys_id}`;
        document.getElementById('sn-modal-native-link').onclick = () => {
          window.location.href = recordUrl;
        };
      }
    } catch (err) {
      console.error(err);
      document.getElementById('sn-modal-number').innerText = 'Error';
      document.getElementById('sn-modal-desc').innerText = `Could not load ticket details: ${err.message}`;
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
    if (clean.includes('resolved') || clean.includes('closed') || clean.includes('completed')) {
      return 'state-resolved';
    }
    if (clean.includes('cancel') || clean.includes('reject')) {
      return 'state-cancelled';
    }
    return 'state-default';
  }

  function init() {
    const checkExist = setInterval(() => {
      if (getAuthToken() && document.body) {
        clearInterval(checkExist);
        buildUI();
        fetchTickets();
        fetchChanges();
        keepSessionAlive();
        checkForExtensionUpdate();
        setInterval(() => {
          fetchTickets();
          fetchChanges();
          keepSessionAlive();
        }, POLL_INTERVAL_MS);
        setInterval(checkForExtensionUpdate, UPDATE_CHECK_INTERVAL_MS);
      }
    }, 1500);
  }

  init();
})();
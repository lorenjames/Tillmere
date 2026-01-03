// settings.js
const api = (typeof window !== 'undefined' && window.MiddletonsApiClient)
  ? window.MiddletonsApiClient
  : null;
const invoke = (...args) => {
  if (!api || typeof api.invoke !== 'function') {
    return Promise.reject(new Error('API client unavailable.'));
  }
  return api.invoke(...args);
};

async function ensureAuthenticatedOrRedirect() {
  try {
    await invoke('auth:me');
  } catch (_) {
    try { window.location.replace('login.html'); } catch (_) { window.location.href = 'login.html'; }
  }
}
ensureAuthenticatedOrRedirect();



function requestLogoutOnClose() {
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([], { type: 'application/json' });
      navigator.sendBeacon('/api/auth/logout', blob);
      return;
    }
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      keepalive: true
    }).catch(() => { });
  } catch (_) { }
}

function confirmLogoutOnCloseRemoved {
  try {
    
    window.addEventListener('unload', () => { requestLogoutOnClose(); });
  } catch (_) { }
}


function wireCloseAppLink() {
  const closeAppLink = document.getElementById('closeAppLink');
  if (!api?.hasIpc) {
    try { if (closeAppLink) closeAppLink.style.display = 'none'; } catch (_) { }
  }
  if (closeAppLink) {
    closeAppLink.addEventListener('click', () => {
      if (!api?.hasIpc) return;
      try { invoke('app:quit'); } catch (_) { }
    });
  }
  const userGuideLink = document.getElementById('userGuideLink');
  if (!api?.hasIpc) {
    try { if (userGuideLink) userGuideLink.style.display = 'none'; } catch (_) { }
  }
  if (userGuideLink) {
    userGuideLink.addEventListener('click', (event) => {
      event.preventDefault();
      if (!api?.hasIpc) return;
      try { invoke('app:openUserGuide'); } catch (_) { }
    });
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCloseAppLink);
} else {
  wireCloseAppLink();
}

const DRAWER_DENOMS = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];
const MODE_TIMEOUT_MS = 20 * 60 * 1000;
const ROLE_ORDER = { cashier: 1, manager: 2, admin: 3 };

function denomLabel(value) {
  const denom = Number(value || 0);
  if (!Number.isFinite(denom)) return '$0';
  if (denom >= 1) return `$${denom.toFixed(0)}`;
  return `${Math.round(denom * 100)}¢`;
}
function normalizeDenominationTargets(targets = {}) {
  const safe = {};
  DRAWER_DENOMS.forEach(d => {
    const key = String(d);
    const raw = targets?.[key] ?? targets?.[d];
    const num = Math.max(0, Math.floor(Number(raw || 0)));
    safe[key] = Number.isFinite(num) ? num : 0;
  });
  return safe;
}

function formatMoneyDisplay(value) {
  const num = Number.isFinite(Number(value)) ? Number(value) : 0;
  return num.toFixed(2);
}

function escapeHtml(value) {
  const str = String(value || '');
  return str.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function computeDenominationTargetTotal(counts = {}) {
  const normalized = normalizeDenominationTargets(counts);
  return DRAWER_DENOMS.reduce((sum, denom) => sum + denom * (Number(normalized[String(denom)] || 0)), 0);
}

function updateDenominationTargetTotalDisplay(total = 0) {
  const el = document.getElementById('denomTargetTotal');
  if (!el) return;
  el.textContent = `$${formatMoneyDisplay(total)}`;
}

const ACTIVITY_EVENTS = ['click', 'keydown', 'mousemove', 'touchstart'];

let __managerMode = false;
let __developerMode = false;
let __authUser = null;
let __authRole = 'cashier';
let __passwordsModal = null;
let __activityListenerAttached = false;
let __taxExemptOrgs = [];
let __taxOrgEditingIndex = -1;

function toPct(val) { return (Number(val || 0) * 100).toFixed(2); }
function fromPct(pct) { return Number(pct || 0) / 100; }
function clampRate(rate) {
  const num = Number(rate);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function toBool(val) {
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled'].includes(v)) return false;
    return v === 'true' || v === '1' || v === 'yes' || v === 'on' || v === 'enabled';
  }
  return Boolean(val);
}
function normalizeRole(role) {
  const key = String(role || '').trim().toLowerCase();
  return ROLE_ORDER[key] ? key : 'cashier';
}
function roleRank(role) {
  return ROLE_ORDER[normalizeRole(role)];
}
function setAppConfigEncryptionStatusLabel(state) {
  try {
    const el = document.getElementById('appConfigEncryptionStatus');
    if (!el) return;
    if (!state) {
      el.textContent = 'Encryption status unavailable.';
      return;
    }
    const encrypted = !!state.encrypted;
    const available = !!state.encryptionAvailable;
    const exists = !!state.exists;
    if (available) {
      if (encrypted) {
        el.textContent = 'Encrypted with OS keychain (safeStorage).';
      } else if (exists) {
        el.textContent = 'Encryption available; config will encrypt on next update.';
      } else {
        el.textContent = 'Encryption available. Config will be encrypted when saved.';
      }
    } else {
      el.textContent = 'OS keychain unavailable; config stored as plain JSON.';
    }
  } catch (_) { }
}
async function refreshAppConfigStatus() {
  try {
    const status = await invoke('appConfig:status');
    setAppConfigEncryptionStatusLabel(status);
  } catch (_) {
    setAppConfigEncryptionStatusLabel(null);
  }
}

function updateAccessBadge() {
  const badge = document.getElementById('accessRoleBadge');
  if (!badge) return;
  const label = __authRole ? __authRole.toUpperCase() : 'UNKNOWN';
  badge.textContent = label;
  badge.className = __authRole === 'admin'
    ? 'badge bg-danger'
    : __authRole === 'manager'
      ? 'badge bg-success'
      : 'badge bg-secondary';
}

function applyRoleAccess() {
  const isManager = roleRank(__authRole) >= roleRank('manager');
  const isAdmin = roleRank(__authRole) >= roleRank('admin');
  __managerMode = isManager;
  __developerMode = isAdmin;
  try {
    document.querySelectorAll('[data-requires-manager]').forEach(el => {
      el.style.display = isManager ? '' : 'none';
    });
  } catch (_) { }
  try {
    document.querySelectorAll('[data-requires-developer]').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
  } catch (_) { }
  try {
    document.querySelectorAll('[data-requires-admin]').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
  } catch (_) { }
}

async function loadAuthUser() {
  try {
    const user = await invoke('auth:me');
    __authUser = user || null;
    __authRole = normalizeRole(user?.role);
    updateAccessBadge();
    applyRoleAccess();
    return user;
  } catch (_) {
    return null;
  }
}
let __managerModeTimer = null;
let __managerModeExpiresAt = 0;
let __developerModeTimer = null;
let __developerModeExpiresAt = 0;

function persistManagerMode(enabled, expiresAt = 0) {
  try { localStorage.setItem('managerModeEnabled', enabled ? '1' : '0'); } catch (_) {}
  try {
    if (enabled && expiresAt > 0) {
      localStorage.setItem('managerModeExpiresAt', String(expiresAt));
    } else {
      localStorage.removeItem('managerModeExpiresAt');
    }
  } catch (_) {}
  __managerModeExpiresAt = enabled ? expiresAt : 0;
}

function readManagerModeState() {
  try {
    const enabled = localStorage.getItem('managerModeEnabled') === '1';
    const expires = Math.max(0, Number(localStorage.getItem('managerModeExpiresAt') || '0'));
    if (enabled && expires && Date.now() > expires) {
      localStorage.removeItem('managerModeEnabled');
      localStorage.removeItem('managerModeExpiresAt');
      return { enabled: false, expiresAt: 0 };
    }
    return { enabled, expiresAt: expires };
  } catch (_) {
    return { enabled: false, expiresAt: 0 };
  }
}

function scheduleManagerModeTimer() {
  if (__managerModeTimer) {
    clearTimeout(__managerModeTimer);
    __managerModeTimer = null;
  }
  if (!__managerMode || !__managerModeExpiresAt) return;
  const delay = Math.max(0, __managerModeExpiresAt - Date.now());
  if (delay <= 0) {
    disableManagerModeDueToTimeout();
    return;
  }
  __managerModeTimer = setTimeout(() => {
    disableManagerModeDueToTimeout();
  }, delay);
}

function disableManagerModeDueToTimeout() {
  if (!__managerMode) return;
  setManagerMode(false);
  showToast('Manager Mode timed out.', { type: 'info' });
}

function scheduleDeveloperModeTimeout() {
  if (__developerModeTimer) {
    clearTimeout(__developerModeTimer);
    __developerModeTimer = null;
  }
  if (!__developerMode || !__developerModeExpiresAt) return;
  const delay = Math.max(0, __developerModeExpiresAt - Date.now());
  if (delay <= 0) {
    disableDeveloperModeDueToTimeout();
    return;
  }
  __developerModeTimer = setTimeout(() => disableDeveloperModeDueToTimeout(), delay);
}

function refreshManagerActivity() {
  if (!__managerMode) return;
  const now = Date.now();
  const expiresAt = now + MODE_TIMEOUT_MS;
  __managerModeExpiresAt = expiresAt;
  persistManagerMode(true, expiresAt);
  scheduleManagerModeTimer();
}

function refreshDeveloperActivity() {
  if (!__developerMode) return;
  const now = Date.now();
  __developerModeExpiresAt = now + MODE_TIMEOUT_MS;
  scheduleDeveloperModeTimeout();
}

function handleActivityEvent() {
  refreshManagerActivity();
  refreshDeveloperActivity();
}

function ensureActivityListeners() {
  if (__activityListenerAttached) return;
  try {
    ACTIVITY_EVENTS.forEach(evt => {
      document.addEventListener(evt, handleActivityEvent, { passive: true });
    });
    __activityListenerAttached = true;
  } catch (_) { }
}

function disableDeveloperModeDueToTimeout() {
  if (!__developerMode) return;
  setDeveloperMode(false);
  showToast('Developer Mode timed out.', { type: 'info' });
  try {
    invoke('settings:disableDev').catch(() => {});
  } catch (_) {}
}
function readField(id) {
  const el = document.getElementById(id);
  return String(el?.value || '').trim();
}
function clearPasswordInputs() {
  ['currentDevPwd', 'newDevPwd', 'confirmDevPwd', 'currentMgrPwd', 'newMgrPwd', 'confirmMgrPwd'].forEach(id => {
    try {
      const el = document.getElementById(id);
      if (el) el.value = '';
    } catch (_) { }
  });
}
function ensurePasswordsModal() {
  if (__passwordsModal) return __passwordsModal;
  try {
    const el = document.getElementById('passwordsModal');
    if (el && window.bootstrap) {
      __passwordsModal = bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static', keyboard: false });
    }
  } catch (_) { }
  return __passwordsModal;
}
function openPasswordsModal() {
  try {
    clearPasswordInputs();
    refreshAppConfigStatus();
    const modal = ensurePasswordsModal();
    if (modal) {
      modal.show();
      setTimeout(() => { try { document.getElementById('currentDevPwd')?.focus(); } catch (_) { } }, 90);
    }
  } catch (_) { }
}
async function changePasswords() {
  const devCur = readField('currentDevPwd');
  const devNew = readField('newDevPwd');
  const devConfirm = readField('confirmDevPwd');
  const mgrCur = readField('currentMgrPwd');
  const mgrNew = readField('newMgrPwd');
  const mgrConfirm = readField('confirmMgrPwd');

  const payload = {};
  if (devNew || devConfirm || devCur) {
    if (!devCur) { showToast('Enter the current developer password.', { type: 'error' }); return; }
    if (!devNew || !devConfirm) { showToast('Enter and confirm the new developer password.', { type: 'error' }); return; }
    if (devNew !== devConfirm) { showToast('Developer passwords do not match.', { type: 'error' }); return; }
    payload.currentDeveloper = devCur;
    payload.newDeveloper = devNew;
  }
  if (mgrNew || mgrConfirm || mgrCur) {
    if (!mgrCur) { showToast('Enter the current manager password.', { type: 'error' }); return; }
    if (!mgrNew || !mgrConfirm) { showToast('Enter and confirm the new manager password.', { type: 'error' }); return; }
    if (mgrNew !== mgrConfirm) { showToast('Manager passwords do not match.', { type: 'error' }); return; }
    payload.currentManager = mgrCur;
    payload.newManager = mgrNew;
  }
  if (!payload.newDeveloper && !payload.newManager) {
    showToast('Enter a new password to change.', { type: 'error' });
    return;
  }
  try {
    const resp = await invoke('appConfig:changePasswords', payload);
    if (resp?.ok) {
      showToast('Password(s) updated.', { type: 'success' });
      clearPasswordInputs();
      refreshAppConfigStatus();
      try { ensurePasswordsModal()?.hide(); } catch (_) { }
    } else {
      showToast(resp?.message || 'No password changes applied.', { type: 'error' });
    }
  } catch (e) {
    const code = e?.code;
    const msg = (code === 'INVALID_CURRENT_DEV_PASSWORD')
      ? 'Current developer password is incorrect.'
      : (code === 'INVALID_CURRENT_MANAGER_PASSWORD')
        ? 'Current manager password is incorrect.'
        : 'Failed to update passwords: ' + (e?.message || e);
    showToast(msg, { type: 'error' });
  }
}

function setBrandingVisibility(isDev) {
  try {
    const card = document.getElementById('brandingCard');
    if (card) card.style.display = isDev ? '' : 'none';
  } catch (_) { }
}

function syncDevModeControl(enabled) {
  try {
    const toggle = document.getElementById('devMode');
    if (toggle) toggle.checked = !!enabled;
  } catch (_) { }
}

async function requestDevPassword() {
  try {
    const modalEl = document.getElementById('devPwdModal');
    const input = document.getElementById('devPwdInput');
    const confirmBtn = document.getElementById('devPwdConfirm');
    if (modalEl && input && confirmBtn && typeof bootstrap !== 'undefined' && bootstrap?.Modal) {
      input.value = '';
      let resolved = false;
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      return await new Promise((resolve) => {
        const cleanup = () => {
          confirmBtn.removeEventListener('click', onConfirm);
          modalEl.removeEventListener('hidden.bs.modal', onHidden);
        };
        const onConfirm = () => {
          resolved = true;
          cleanup();
          modal.hide();
          resolve(input.value || '');
        };
        const onHidden = () => {
          if (!resolved) {
            cleanup();
            resolve('');
          }
        };
        confirmBtn.addEventListener('click', onConfirm);
        modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
        modal.show();
        setTimeout(() => { try { input.focus(); } catch (_) {} }, 75);
      });
    }
  } catch (_) { }
  const attempt = window.prompt('Enter developer mode password:');
  return attempt || '';
}

function setDeveloperMode(enabled, opts = {}) {
  __developerMode = roleRank(__authRole) >= roleRank('admin');
  __developerModeExpiresAt = __developerMode ? Date.now() + MODE_TIMEOUT_MS : 0;
  syncDevModeControl(false);
  setBrandingVisibility(__developerMode);
  applyRoleAccess();
}

async function enableDeveloperMode() {
  showToast('Developer access is now controlled by user roles.', { type: 'info' });
}

async function disableDeveloperMode() {
  showToast('Developer access is now controlled by user roles.', { type: 'info' });
}

async function toggleDeveloperMode() {
  showToast('Developer access is now controlled by user roles.', { type: 'info' });
}

function setManagerMode(enabled, opts = {}) {
  __managerMode = roleRank(__authRole) >= roleRank('manager');
  applyRoleAccess();
}

function getPersistedManagerMode() {
  return readManagerModeState().enabled;
}

async function requestManagerPassword() {
  try {
    const modalEl = document.getElementById('managerPwdModal');
    const input = document.getElementById('managerPwdInput');
    const confirmBtn = document.getElementById('managerPwdConfirm');
    if (modalEl && input && confirmBtn && typeof bootstrap !== 'undefined' && bootstrap?.Modal) {
      input.value = '';
      let resolved = false;
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      return await new Promise((resolve) => {
        const cleanup = () => {
          confirmBtn.removeEventListener('click', onConfirm);
          modalEl.removeEventListener('hidden.bs.modal', onHidden);
        };
        const onConfirm = () => {
          resolved = true;
          cleanup();
          modal.hide();
          resolve(input.value || '');
        };
        const onHidden = () => {
          if (!resolved) {
            cleanup();
            resolve('');
          }
        };
        confirmBtn.addEventListener('click', onConfirm);
        modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
        modal.show();
        setTimeout(() => { try { input.focus(); } catch (_) {} }, 75);
      });
    }
  } catch (_) { }
  const attempt = window.prompt('Enter manager password to enable Manager Mode:');
  return attempt || '';
}

async function toggleManagerMode() {
  showToast('Manager access is now controlled by user roles.', { type: 'info' });
}

function showToast(message, opts = {}) {
  try {
    const hostId = 'toast-host';
    let host = document.getElementById(hostId);
    if (!host) {
      host = document.createElement('div');
      host.id = hostId;
      host.style.position = 'fixed';
      host.style.zIndex = '5000';
      host.style.right = '16px';
      host.style.bottom = '16px';
      host.style.display = 'flex';
      host.style.flexDirection = 'column';
      host.style.gap = '8px';
      host.style.pointerEvents = 'none';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    const tone = (opts.type === 'error') ? '#dc3545' : (opts.type === 'success') ? '#198754' : '#0d6efd';
    el.textContent = String(message || '');
    el.style.pointerEvents = 'none';
    el.style.color = '#fff';
    el.style.background = tone;
    el.style.borderRadius = '8px';
    el.style.padding = '10px 12px';
    el.style.boxShadow = '0 6px 18px rgba(0,0,0,.18)';
    el.style.fontSize = '14px';
    host.appendChild(el);
    const ms = Math.max(1000, Number(opts.duration || 2500));
    setTimeout(() => { try { el.remove(); } catch (_) {} }, ms);
  } catch (_) {}
}

/* Customer carousel logic disabled */

function renderDenominationTargetInputs(targets = {}) {
  const container = document.getElementById('denomTargetInputs');
  if (!container) return;
  container.innerHTML = '';
  const normalized = normalizeDenominationTargets(targets);
  DRAWER_DENOMS.forEach(denom => {
    const row = document.createElement('div');
    row.className = 'row g-2 align-items-center mb-2';
    row.innerHTML = `
      <div class="col-5 col-md-4 fw-semibold">${denomLabel(denom)}</div>
      <div class="col-7 col-md-4">
        <input type="number" min="0" step="1" class="form-control form-control-sm" data-denom-target="${denom}" value="${normalized[String(denom)]}">
      </div>
      <div class="col-12 col-md-4 small text-muted">Bills to keep in drawer</div>
    `;
    container.appendChild(row);
  });
  const total = computeDenominationTargetTotal(normalized);
  updateDenominationTargetTotalDisplay(total);
  if (!container.dataset.denomsWired) {
    container.addEventListener('input', () => {
      const counts = readDenominationTargetInputs();
      updateDenominationTargetTotalDisplay(computeDenominationTargetTotal(counts));
    });
    container.dataset.denomsWired = '1';
  }
}

function readDenominationTargetInputs() {
  const container = document.getElementById('denomTargetInputs');
  const counts = {};
  if (!container) return counts;
  DRAWER_DENOMS.forEach(denom => {
    const input = container.querySelector(`[data-denom-target="${denom}"]`);
    const val = Math.max(0, Math.floor(Number(input?.value || 0)));
    counts[String(denom)] = Number.isFinite(val) ? val : 0;
  });
  return counts;
}

async function saveDenominationTargets() {
  if (!__managerMode) {
    showToast('Enable Manager Mode to change denomination targets.', { type: 'error' });
    return;
  }
  const targets = normalizeDenominationTargets(readDenominationTargetInputs());
  try {
    const saved = await invoke('settings:saveDenominationTargets', { denominationTargets: targets });
    renderDenominationTargetInputs(saved?.drawerDenominationTargets || saved?.denominationTargets || targets);
    showToast('Denomination targets saved.', { type: 'success' });
  } catch (e) {
    showToast('Failed to save denomination targets: ' + (e?.message || e), { type: 'error' });
  }
}

function readDiscountReasonsFromTextarea() {
  const textarea = document.getElementById('discountReasonsInput');
  if (!textarea) return [];
  return (textarea.value || '')
    .split(/\r?\n/)
    .map(line => String(line || '').trim())
    .filter(Boolean);
}

function writeDiscountReasonsToTextarea(list) {
  try {
    const textarea = document.getElementById('discountReasonsInput');
    if (!textarea) return;
    const lines = Array.isArray(list) && list.length ? list : [];
    textarea.value = lines.join('\n');
  } catch (_) { }
}

function normalizeTaxExemptOrgs(list) {
  const incoming = Array.isArray(list) ? list : [];
  const cleaned = [];
  const seen = new Set();
  incoming.forEach((org) => {
    const name = String(org?.name || '').trim();
    const id = String(org?.id || org?.taxId || '').trim();
    if (!name || !id) return;
    const key = `${name.toLowerCase()}|${id.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    cleaned.push({ name, id });
  });
  return cleaned.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function resetTaxOrgForm() {
  __taxOrgEditingIndex = -1;
  try { const nameEl = document.getElementById('taxOrgName'); if (nameEl) nameEl.value = ''; } catch (_) { }
  try { const idEl = document.getElementById('taxOrgId'); if (idEl) idEl.value = ''; } catch (_) { }
  try {
    const btn = document.getElementById('saveTaxOrgBtn');
    if (btn) btn.textContent = 'Add Organization';
  } catch (_) { }
  try {
    const cancelBtn = document.getElementById('cancelTaxOrgEditBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
  } catch (_) { }
}

function renderTaxOrgTable() {
  const tbody = document.querySelector('#taxOrgTable tbody');
  const empty = document.getElementById('taxOrgEmpty');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!Array.isArray(__taxExemptOrgs) || __taxExemptOrgs.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  __taxExemptOrgs.forEach((org, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${org.name}</td>
      <td>${org.id}</td>
      <td>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-primary" data-role="edit">Edit</button>
          <button class="btn btn-outline-danger" data-role="delete">Delete</button>
        </div>
      </td>`;
    const editBtn = tr.querySelector('[data-role="edit"]');
    const delBtn = tr.querySelector('[data-role="delete"]');
    if (editBtn) editBtn.addEventListener('click', () => startTaxOrgEdit(idx));
    if (delBtn) delBtn.addEventListener('click', () => deleteTaxOrg(idx));
    tbody.appendChild(tr);
  });
}

function startTaxOrgEdit(idx) {
  const org = __taxExemptOrgs[idx];
  if (!org) return;
  __taxOrgEditingIndex = idx;
  try { const nameEl = document.getElementById('taxOrgName'); if (nameEl) nameEl.value = org.name; } catch (_) { }
  try { const idEl = document.getElementById('taxOrgId'); if (idEl) idEl.value = org.id; } catch (_) { }
  try {
    const btn = document.getElementById('saveTaxOrgBtn');
    if (btn) btn.textContent = 'Update Organization';
  } catch (_) { }
  try {
    const cancelBtn = document.getElementById('cancelTaxOrgEditBtn');
    if (cancelBtn) cancelBtn.style.display = '';
  } catch (_) { }
}

async function persistTaxExemptOrgs(message = 'Tax exempt organizations saved.') {
  try {
    const saved = await invoke('settings:saveTaxExemptOrgs', { taxExemptOrgs: __taxExemptOrgs });
    __taxExemptOrgs = normalizeTaxExemptOrgs(saved?.taxExemptOrgs || __taxExemptOrgs);
    renderTaxOrgTable();
    resetTaxOrgForm();
    showToast(message, { type: 'success' });
  } catch (e) {
    showToast('Failed to save tax exempt organizations: ' + (e?.message || e), { type: 'error' });
  }
}

async function addOrUpdateTaxOrg() {
  if (!__managerMode) {
    showToast('Enable Manager Mode to manage tax exempt organizations.', { type: 'error' });
    return;
  }
  const name = String(document.getElementById('taxOrgName')?.value || '').trim();
  const id = String(document.getElementById('taxOrgId')?.value || '').trim();
  const okId = /^[a-z0-9]+$/i.test(id);
  if (!name) { showToast('Enter a name or organization.', { type: 'error' }); return; }
  if (!okId) { showToast('Tax ID must be alphanumeric (no spaces).', { type: 'error' }); return; }
  const entry = { name, id };
  if (__taxOrgEditingIndex >= 0 && __taxExemptOrgs[__taxOrgEditingIndex]) {
    __taxExemptOrgs[__taxOrgEditingIndex] = entry;
    __taxExemptOrgs = normalizeTaxExemptOrgs(__taxExemptOrgs);
    await persistTaxExemptOrgs('Organization updated.');
    return;
  }
  __taxExemptOrgs.push(entry);
  __taxExemptOrgs = normalizeTaxExemptOrgs(__taxExemptOrgs);
  await persistTaxExemptOrgs('Organization added.');
}

async function deleteTaxOrg(idx) {
  if (!__managerMode) {
    showToast('Enable Manager Mode to manage tax exempt organizations.', { type: 'error' });
    return;
  }
  if (!__taxExemptOrgs[idx]) return;
  __taxExemptOrgs.splice(idx, 1);
  await persistTaxExemptOrgs('Organization deleted.');
}

// --- Vendor promotions (settings UI only) ---
let __vendorPromotions = [];
let __promoModal = null;
let __promoEditModal = null;
let __promoEditingIndex = -1;
let __vendorList = [];
let __promoDeleteModal = null;
let __promoDeleteIndex = -1;

function todayYmdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayStartTs() {
  const t = todayYmdLocal();
  return Date.parse(`${t}T00:00:00`);
}
function ensureNonOverlappingPromos(list) {
  const byVendor = new Map();
  (Array.isArray(list) ? list : []).forEach(p => {
    const key = String(p.vendorCode || '').trim().toLowerCase();
    if (!key) return;
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key).push(p);
  });
  const result = [];
  byVendor.forEach(arr => {
    const sorted = arr.slice().sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
    let lastEnd = -Infinity;
    sorted.forEach(p => {
      if (Number.isFinite(p.startTs) && Number.isFinite(p.endTs) && p.startTs > lastEnd) {
        result.push(p);
        lastEnd = p.endTs;
      }
    });
  });
  return result;
}
function promoRangesOverlap(a, b) {
  if (!a || !b) return false;
  const keyA = String(a.vendorCode || '').trim().toLowerCase();
  const keyB = String(b.vendorCode || '').trim().toLowerCase();
  if (!keyA || !keyB || keyA !== keyB) return false;
  const aStart = Date.parse(`${a.startDate}T00:00:00`);
  const aEnd = Date.parse(`${a.endDate}T23:59:59`);
  const bStart = Date.parse(`${b.startDate}T00:00:00`);
  const bEnd = Date.parse(`${b.endDate}T23:59:59`);
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false;
  return (aStart <= bEnd) && (bStart <= aEnd);
}
function normalizeVendorPromotions(list) {
  const arr = Array.isArray(list) ? list : [];
  const normalized = arr
    .map((p) => {
      const vendorCode = String(p?.vendorCode || '').trim();
      const vendorName = String(p?.vendorName || '').trim();
      const type = p?.type === 'amount' ? 'amount' : 'percent';
      const rawValue = Number(p?.value || 0);
      const value = type === 'percent'
        ? Math.max(0, Math.min(100, rawValue))
        : Math.max(0, rawValue);
      const startDate = String(p?.startDate || '').trim();
      const endDate = String(p?.endDate || '').trim();
      const startTs = Date.parse(`${startDate}T00:00:00`);
      const endTs = Date.parse(`${endDate}T23:59:59`);
      if (!vendorCode || !startDate || !endDate) return null;
      if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null;
      if (value <= 0) return null;
      const swap = startTs > endTs;
      return {
        id: String(p?.id || `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`),
        vendorCode,
        vendorName,
        type,
        value,
        startDate: swap ? endDate : startDate,
        endDate: swap ? startDate : endDate,
        startTs: swap ? endTs : startTs,
        endTs: swap ? startTs : endTs
      };
    })
    .filter(Boolean);
  const nonOverlap = ensureNonOverlappingPromos(normalized);
  return nonOverlap
    .map(p => ({
      id: p.id,
      vendorCode: p.vendorCode,
      vendorName: p.vendorName,
      type: p.type,
      value: p.value,
      startDate: p.startDate,
      endDate: p.endDate
    }))
    .sort((a, b) => {
      const v = a.vendorCode.localeCompare(b.vendorCode, undefined, { sensitivity: 'base' });
      if (v !== 0) return v;
      return a.startDate.localeCompare(b.startDate);
    });
}
function getVendorLabel(code, fallbackName = '') {
  const safeCode = String(code || '').trim();
  if (!safeCode) return fallbackName || '';
  const v = (__vendorList || []).find(vv => String(vv?.code || '').trim().toLowerCase() === safeCode.toLowerCase());
  if (v && v.name) return `${v.name} (${safeCode})`;
  if (fallbackName) return `${fallbackName} (${safeCode})`;
  return safeCode;
}
function renderVendorPromoSummary() {
  const el = document.getElementById('vendorPromoSummary');
  if (!el) return;
  if (!Array.isArray(__vendorPromotions) || __vendorPromotions.length === 0) {
    el.textContent = 'No promotions configured.';
    return;
  }
  const snippets = __vendorPromotions.slice(0, 3).map(p => {
    const vendor = getVendorLabel(p.vendorCode, p.vendorName || p.vendorCode);
    return `${vendor}: ${p.startDate} - ${p.endDate}`;
  });
  const more = __vendorPromotions.length > snippets.length ? ` (+${__vendorPromotions.length - snippets.length} more)` : '';
  el.textContent = `${__vendorPromotions.length} promotion${__vendorPromotions.length === 1 ? '' : 's'} configured. ${snippets.join('; ')}${more}`;
}
function renderVendorPromoInlineTable() {
  const tbody = document.querySelector('#vendorPromoInline tbody');
  const empty = document.getElementById('vendorPromoInlineEmpty');
  const table = document.getElementById('vendorPromoInline');
  if (!tbody || !table) return;
  tbody.innerHTML = '';
  const hasPromos = Array.isArray(__vendorPromotions) && __vendorPromotions.length > 0;
  if (!hasPromos) {
    if (empty) empty.style.display = '';
    table.style.display = 'none';
    return;
  }
  table.style.display = '';
  if (empty) empty.style.display = 'none';
  __vendorPromotions.forEach(p => {
    const tr = document.createElement('tr');
    const discountLabel = p.type === 'percent'
      ? `${p.value}% off`
      : `$${Number(p.value || 0).toFixed(2)} off`;
    const vendor = getVendorLabel(p.vendorCode, p.vendorName || p.vendorCode);
    tr.innerHTML = `
      <td>${vendor}</td>
      <td>${discountLabel}</td>
      <td>${p.startDate} - ${p.endDate}</td>
    `;
    tbody.appendChild(tr);
  });
}
function populatePromoVendorSelect(target) {
  const sel = target || document.getElementById('promoVendorSelect');
  if (!sel) return;
  const previous = sel.value || '';
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select vendor';
  placeholder.disabled = true;
  placeholder.selected = true;
  sel.appendChild(placeholder);
  (__vendorList || []).forEach(v => {
    const code = String(v?.code || '').trim();
    const label = v?.name ? `${v.name} (${code || v.name})` : (code || 'Vendor');
    if (!code && !label) return;
    const opt = document.createElement('option');
    opt.value = code || label;
    opt.textContent = label;
    sel.appendChild(opt);
  });
  if (previous && [...sel.options].some(o => o.value === previous)) sel.value = previous;
}
async function loadVendorsForPromos() {
  try {
    const list = await invoke('vendors:load');
    __vendorList = Array.isArray(list) ? list : [];
    populatePromoVendorSelect(document.getElementById('promoVendorSelect'));
    populatePromoVendorSelect(document.getElementById('editPromoVendorSelect'));
    renderVendorPromoTable();
  } catch (_) { }
}
function resetVendorPromoForm() {
  __promoEditingIndex = -1;
  try {
    const vendorSel = document.getElementById('promoVendorSelect');
    if (vendorSel) vendorSel.selectedIndex = 0;
    document.getElementById('promoType').value = 'percent';
    document.getElementById('promoValue').value = '';
    const startEl = document.getElementById('promoStart');
    const endEl = document.getElementById('promoEnd');
    const today = todayYmdLocal();
    if (startEl) startEl.min = today;
    if (endEl) endEl.min = today;
    if (startEl) startEl.value = today;
    if (endEl) endEl.value = today;
    const btn = document.getElementById('saveVendorPromoBtn');
    if (btn) btn.textContent = 'Add Promotion';
  } catch (_) { }
}
function renderVendorPromoTable() {
  const tbody = document.querySelector('#vendorPromoTable tbody');
  const empty = document.getElementById('vendorPromoEmpty');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!Array.isArray(__vendorPromotions) || __vendorPromotions.length === 0) {
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  __vendorPromotions.forEach((p, idx) => {
    const tr = document.createElement('tr');
    const discountLabel = p.type === 'percent'
      ? `${p.value}% off`
      : `$${Number(p.value || 0).toFixed(2)} off`;
    const vendor = getVendorLabel(p.vendorCode, p.vendorName || p.vendorCode);
    tr.innerHTML = `
      <td>${vendor}</td>
      <td>${discountLabel}</td>
      <td>${p.startDate} - ${p.endDate}</td>
      <td>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-primary" data-role="edit">Edit</button>
          <button class="btn btn-outline-danger" data-role="delete">Delete</button>
        </div>
      </td>`;
    const editBtn = tr.querySelector('[data-role="edit"]');
    const delBtn = tr.querySelector('[data-role="delete"]');
    if (editBtn) editBtn.addEventListener('click', () => editVendorPromo(idx));
    if (delBtn) delBtn.addEventListener('click', () => openVendorPromoDeleteModal(idx));
    tbody.appendChild(tr);
  });
  renderVendorPromoInlineTable();
}
function openVendorPromoModal() {
  if (!__managerMode) {
    showToast('Enable Manager Mode to manage vendor promotions.', { type: 'error' });
    return;
  }
  try {
    resetVendorPromoForm();
    if (!__promoModal) {
      const el = document.getElementById('vendorPromoModal');
      if (el && window.bootstrap) __promoModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });
    }
    resetVendorPromoForm();
    renderVendorPromoTable();
    if (__promoModal) {
      __promoModal.show();
      setTimeout(() => { try { document.getElementById('promoVendorSelect')?.focus(); } catch (_) { } }, 80);
    }
  } catch (_) { }
  loadVendorsForPromos();
}
async function persistVendorPromos(message = 'Vendor promotions saved.') {
  try {
    const saved = await invoke('settings:saveVendorPromotions', { vendorPromotions: __vendorPromotions });
    __vendorPromotions = normalizeVendorPromotions(saved?.vendorPromotions || __vendorPromotions);
    renderVendorPromoSummary();
    renderVendorPromoInlineTable();
    renderVendorPromoTable();
    showToast(message, { type: 'success' });
  } catch (e) {
    showToast('Failed to save vendor promotions: ' + (e?.message || e), { type: 'error' });
  }
}
async function addOrUpdateVendorPromo() {
  const vendorCode = String(document.getElementById('promoVendorSelect')?.value || '').trim();
  const type = document.getElementById('promoType')?.value === 'amount' ? 'amount' : 'percent';
  const valueRaw = Number(document.getElementById('promoValue')?.value || 0);
  const startDate = String(document.getElementById('promoStart')?.value || '').trim();
  const endDate = String(document.getElementById('promoEnd')?.value || '').trim();
  if (!vendorCode) { showToast('Select a vendor for the promotion.', { type: 'error' }); return; }
  if (!startDate || !endDate) { showToast('Enter a start and end date.', { type: 'error' }); return; }
  let value = Math.max(0, valueRaw);
  if (type === 'percent') value = Math.min(100, value);
  if (value <= 0) { showToast('Enter a discount greater than zero.', { type: 'error' }); return; }
  const startTs = Date.parse(`${startDate}T00:00:00`);
  const endTs = Date.parse(`${endDate}T23:59:59`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) { showToast('Enter valid start/end dates.', { type: 'error' }); return; }
  const todayTs = todayStartTs();
  if (startTs < todayTs || endTs < todayTs) { showToast('Promotions cannot be set in the past.', { type: 'error' }); return; }
  const vendorObj = (__vendorList || []).find(v => String(v?.code || '').trim().toLowerCase() === vendorCode.toLowerCase());
  const vendorName = vendorObj?.name || vendorCode;
  const promo = {
    id: `promo-${Date.now()}`,
    vendorCode,
    vendorName,
    type,
    value,
    startDate: startTs <= endTs ? startDate : endDate,
    endDate: startTs <= endTs ? endDate : startDate
  };
  const collision = __vendorPromotions.find((p) => promoRangesOverlap(p, promo));
  if (collision) {
    showToast('Another promotion for this vendor overlaps this date range. Only one active promo per vendor at a time.', { type: 'error' });
    return;
  }
  __vendorPromotions.push(promo);
  __vendorPromotions = normalizeVendorPromotions(__vendorPromotions);
  await persistVendorPromos('Promotion added.');
  resetVendorPromoForm();
}
function editVendorPromo(idx) {
  const promo = __vendorPromotions[idx];
  if (!promo) return;
  __promoEditingIndex = idx;
  try {
    ensurePromoEditModal();
    const vendorSel = document.getElementById('editPromoVendorSelect');
    const typeEl = document.getElementById('editPromoType');
    const valueEl = document.getElementById('editPromoValue');
    const startEl = document.getElementById('editPromoStart');
    const endEl = document.getElementById('editPromoEnd');
    const today = todayYmdLocal();
    if (startEl) startEl.min = today;
    if (endEl) endEl.min = today;
    if (vendorSel) vendorSel.value = promo.vendorCode || '';
    if (typeEl) typeEl.value = promo.type === 'amount' ? 'amount' : 'percent';
    if (valueEl) valueEl.value = promo.value;
    if (startEl) startEl.value = promo.startDate || '';
    if (endEl) endEl.value = promo.endDate || '';
    renderVendorPromoTable();
    __promoEditModal?.show();
    setTimeout(() => { try { vendorSel?.focus(); } catch (_) { } }, 80);
  } catch (_) { }
}
async function deleteVendorPromo(idx) {
  const promo = __vendorPromotions[idx];
  if (!promo) return;
  __vendorPromotions.splice(idx, 1);
  await persistVendorPromos('Promotion deleted.');
  resetVendorPromoForm();
}
function ensurePromoEditModal() {
  if (__promoEditModal) return __promoEditModal;
  const el = document.getElementById('vendorPromoEditModal');
  if (el && window.bootstrap) __promoEditModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });
  const btn = document.getElementById('updateVendorPromoBtn');
  if (btn && !btn.dataset._wired) {
    btn.addEventListener('click', () => updateVendorPromoFromModal());
    btn.dataset._wired = '1';
  }
  if (el && !el.dataset._wiredHide) {
    el.addEventListener('hidden.bs.modal', () => { __promoEditingIndex = -1; });
    el.dataset._wiredHide = '1';
  }
  return __promoEditModal;
}
async function updateVendorPromoFromModal() {
  const vendorCode = String(document.getElementById('editPromoVendorSelect')?.value || '').trim();
  const type = document.getElementById('editPromoType')?.value === 'amount' ? 'amount' : 'percent';
  const valueRaw = Number(document.getElementById('editPromoValue')?.value || 0);
  const startDate = String(document.getElementById('editPromoStart')?.value || '').trim();
  const endDate = String(document.getElementById('editPromoEnd')?.value || '').trim();
  if (__promoEditingIndex < 0 || !__vendorPromotions[__promoEditingIndex]) { try { __promoEditModal?.hide(); } catch (_) { } return; }
  if (!vendorCode) { showToast('Select a vendor for the promotion.', { type: 'error' }); return; }
  if (!startDate || !endDate) { showToast('Enter a start and end date.', { type: 'error' }); return; }
  let value = Math.max(0, valueRaw);
  if (type === 'percent') value = Math.min(100, value);
  if (value <= 0) { showToast('Enter a discount greater than zero.', { type: 'error' }); return; }
  const startTs = Date.parse(`${startDate}T00:00:00`);
  const endTs = Date.parse(`${endDate}T23:59:59`);
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) { showToast('Enter valid start/end dates.', { type: 'error' }); return; }
  const todayTs = todayStartTs();
  if (startTs < todayTs || endTs < todayTs) { showToast('Promotions cannot be set in the past.', { type: 'error' }); return; }
  const vendorObj = (__vendorList || []).find(v => String(v?.code || '').trim().toLowerCase() === vendorCode.toLowerCase());
  const vendorName = vendorObj?.name || vendorCode;
  const promo = {
    id: __vendorPromotions[__promoEditingIndex].id,
    vendorCode,
    vendorName,
    type,
    value,
    startDate: startTs <= endTs ? startDate : endDate,
    endDate: startTs <= endTs ? endDate : startDate
  };
  const collision = __vendorPromotions.find((p, idx) => idx !== __promoEditingIndex && promoRangesOverlap(p, promo));
  if (collision) {
    showToast('Another promotion for this vendor overlaps this date range. Only one active promo per vendor at a time.', { type: 'error' });
    return;
  }
  __vendorPromotions[__promoEditingIndex] = promo;
  __vendorPromotions = normalizeVendorPromotions(__vendorPromotions);
  await persistVendorPromos('Promotion updated.');
  __promoEditModal?.hide();
  __promoEditingIndex = -1;
  resetVendorPromoForm();
}
function ensureVendorPromoDeleteModal() {
  if (__promoDeleteModal) return __promoDeleteModal;
  const el = document.getElementById('vendorPromoDeleteModal');
  if (el && window.bootstrap) __promoDeleteModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });
  const confirmBtn = document.getElementById('confirmVendorPromoDeleteBtn');
  if (confirmBtn && !confirmBtn.dataset._wired) {
    confirmBtn.addEventListener('click', async () => {
      const idx = __promoDeleteIndex;
      __promoDeleteIndex = -1;
      try { __promoDeleteModal?.hide(); } catch (_) { }
      if (idx >= 0) await deleteVendorPromo(idx);
    });
    confirmBtn.dataset._wired = '1';
  }
  if (el && !el.dataset._wiredHide) {
    el.addEventListener('hidden.bs.modal', () => { __promoDeleteIndex = -1; });
    el.dataset._wiredHide = '1';
  }
  return __promoDeleteModal;
}
function openVendorPromoDeleteModal(idx) {
  const promo = __vendorPromotions[idx];
  if (!promo) return;
  __promoDeleteIndex = idx;
  const label = document.getElementById('vendorPromoDeleteLabel');
  const vendorLabel = getVendorLabel(promo.vendorCode, promo.vendorName || promo.vendorCode);
  if (label) label.textContent = `${vendorLabel} • ${promo.startDate} - ${promo.endDate}`;
  const modal = ensureVendorPromoDeleteModal();
  try { modal?.show(); } catch (_) { }
}

async function loadSettings() {
  try {
    const s = await invoke('settings:load');
    const rate = Number(s?.taxRate ?? 0.0725);
    document.getElementById('taxRatePct').value = toPct(rate);
    const giftRate = Number(s?.giftCardSurchargeRate ?? 0.03);
    const giftRateEl = document.getElementById('giftCardSurchargePct');
    if (giftRateEl) giftRateEl.value = toPct(giftRate);
    setDeveloperMode(false);
    const sp = Boolean(s?.silentPrint);
    const spEl = document.getElementById('silentPrint');
    if (spEl) spEl.checked = sp;
    const gs = Boolean(s?.greyscalePrint);
    const gsEl = document.getElementById('greyscalePrint');
    if (gsEl) gsEl.checked = gs;
    const displayEnabled = (s?.customerDisplayEnabled === undefined) ? true : toBool(s.customerDisplayEnabled);
    const displayToggle = document.getElementById('customerDisplayEnabled');
    if (displayToggle) displayToggle.checked = displayEnabled;
    // Branding fields
    try {
      const navBrand = document.querySelector('.navbar-brand');
      if (navBrand && s?.bizName) navBrand.textContent = String(s.bizName);
    } catch (_) { }
    try {
      const nameEl = document.getElementById('bizName');
      if (nameEl) nameEl.value = String(s?.bizName || '');
    } catch (_) { }
    try {
      const addrEl = document.getElementById('bizAddress');
      if (addrEl) addrEl.value = String(s?.bizAddress || '');
    } catch (_) { }
    try {
      const phoneEl = document.getElementById('bizPhone');
      if (phoneEl) phoneEl.value = String(s?.bizPhone || '');
    } catch (_) { }
    try {
      const logoPrev = document.getElementById('logoPreview');
      const src = String(s?.logoPath || '').trim();
      if (logoPrev) {
        if (src) {
          logoPrev.src = src;
          logoPrev.style.display = '';
        } else {
          logoPrev.removeAttribute('src');
          logoPrev.style.display = 'none';
        }
      }
    } catch (_) { }

    // Populate printers (Electron provides printer list; web keeps default option)
    if (api?.hasIpc) {
      try {
        const printers = await invoke('print:listPrinters');
        const sel = document.getElementById('printerSelect');
        if (sel) {
          const savedName = String(s?.printerName || '');
          // reset options (keep first default option)
          sel.innerHTML = '';
          const defOpt = document.createElement('option');
          defOpt.value = '';
          defOpt.textContent = 'System Default';
          sel.appendChild(defOpt);
          (printers || []).forEach(p => {
            const name = String(p?.name || '').trim();
            if (!name) return;
            const label = String(p?.displayName || name);
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = label + (p?.isDefault ? ' (Default)' : '');
            sel.appendChild(opt);
          });
          sel.value = savedName || '';
        }
      } catch (_) { /* ignore */ }
    } else {
      try {
        const sel = document.getElementById('printerSelect');
        if (sel) {
          const savedName = String(s?.printerName || '');
          sel.innerHTML = '';
          const defOpt = document.createElement('option');
          defOpt.value = '';
          defOpt.textContent = 'System Default';
          sel.appendChild(defOpt);
          sel.value = savedName || '';
        }
      } catch (_) { }
    }

    // Discount reasons
    writeDiscountReasonsToTextarea(s?.discountReasons || []);
    __taxExemptOrgs = normalizeTaxExemptOrgs(s?.taxExemptOrgs || []);
    renderTaxOrgTable();
    resetTaxOrgForm();
    __vendorPromotions = normalizeVendorPromotions(s?.vendorPromotions || []);
    renderVendorPromoSummary();
    renderVendorPromoInlineTable();
    renderVendorPromoTable();
    try {
      renderDenominationTargetInputs(s?.drawerDenominationTargets || s?.denominationTargets || {});
    } catch (_) { }
  } catch (e) { showToast('Failed to load settings: ' + (e?.message || e), { type: 'error' }); }
}

async function saveTaxSettings() {
  try {
    const pct = document.getElementById('taxRatePct').value;
    const rate = clampRate(fromPct(pct));
    const saved = await invoke('settings:saveTax', { taxRate: rate });
    showToast('Saved. Tax rate: ' + toPct(saved.taxRate) + '%', { type: 'success' });
  } catch (e) { showToast('Failed to save tax rate: ' + (e?.message || e), { type: 'error' }); }
}

async function saveGiftCardSurchargeSettings() {
  try {
    if (!__managerMode) {
      showToast('Enable Manager Mode to edit the gift card surcharge.', { type: 'error' });
      return;
    }
    const pct = document.getElementById('giftCardSurchargePct')?.value || '';
    const rate = clampRate(fromPct(pct));
    const saved = await invoke('settings:saveGiftCardSurcharge', { giftCardSurchargeRate: rate });
    showToast('Saved. Gift card surcharge: ' + toPct(saved.giftCardSurchargeRate) + '%', { type: 'success' });
  } catch (e) { showToast('Failed to save gift card surcharge: ' + (e?.message || e), { type: 'error' }); }
}

async function saveDevSettings() {
  await toggleDeveloperMode();
}

async function savePrintSettings() {
  try {
    const silentPrint = !!document.getElementById('silentPrint')?.checked;
    const printerName = String(document.getElementById('printerSelect')?.value || '');
    const greyscalePrint = !!document.getElementById('greyscalePrint')?.checked;
    const saved = await invoke('settings:saveSilent', { silentPrint, printerName, greyscalePrint });
    showToast(
      `Saved. Silent Print: ${saved.silentPrint ? 'On' : 'Off'} | Greyscale: ${saved.greyscalePrint ? 'On' : 'Off'}`,
      { type: 'success' }
    );
  } catch (e) { showToast('Failed to save printing settings: ' + (e?.message || e), { type: 'error' }); }
}

async function saveCustomerDisplaySettings(enabled) {
  try {
    const saved = await invoke('settings:saveCustomerDisplay', { customerDisplayEnabled: !!enabled });
    const on = saved?.customerDisplayEnabled === undefined ? true : toBool(saved.customerDisplayEnabled);
    const toggle = document.getElementById('customerDisplayEnabled');
    if (toggle) toggle.checked = on;
    showToast(`Customer Display: ${on ? 'On' : 'Off'}`, { type: 'success' });
  } catch (e) {
    showToast('Failed to save customer display setting: ' + (e?.message || e), { type: 'error' });
  }
}

function openCustomerDisplayWindow() {
  if (api?.hasIpc) return null;
  const url = 'customer-cart.html';
  const features = 'popup=yes,width=1280,height=720,menubar=no,toolbar=no,location=no,status=no';
  const opened = window.open(url, 'middletonsCustomerCart', features);
  if (opened) {
    try { opened.focus(); } catch (_) { }
  }
  return opened || null;
}

async function refreshCustomerDisplay() {
  try {
    openCustomerDisplayWindow();
    await invoke('customer-cart:refresh');
    showToast('Customer display refreshed.', { type: 'success' });
  } catch (e) {
    showToast('Failed to refresh customer display: ' + (e?.message || e), { type: 'error' });
  }
}

async function saveBrandingSettings() {
  try {
    const bizName = document.getElementById('bizName')?.value || '';
    const bizAddress = document.getElementById('bizAddress')?.value || '';
    const bizPhone = document.getElementById('bizPhone')?.value || '';
    const logoInput = document.getElementById('logoInput');
    const payload = { bizName, bizAddress, bizPhone };
    if (api?.hasIpc) {
      try {
        const file = logoInput && logoInput.files && logoInput.files[0];
        if (file && file.path) payload.logoFilePath = String(file.path || '');
      } catch (_) { }
    }
    const saved = await invoke('settings:saveBranding', payload);
    showToast('Branding saved.', { type: 'success' });
    try {
      const navBrand = document.querySelector('.navbar-brand');
      if (navBrand && saved?.bizName) navBrand.textContent = String(saved.bizName);
    } catch (_) { }
    try {
      const logoPrev = document.getElementById('logoPreview');
      const src = String(saved?.logoPath || '').trim();
      if (logoPrev) {
        if (src) {
          logoPrev.src = src;
          logoPrev.style.display = '';
        } else {
          logoPrev.removeAttribute('src');
          logoPrev.style.display = 'none';
        }
      }
    } catch (_) { }
    try {
      if (logoInput) logoInput.value = '';
    } catch (_) { }
  } catch (e) { showToast('Failed to save branding: ' + (e?.message || e), { type: 'error' }); }
}

async function saveDiscountReasons() {
  try {
    if (!__managerMode) {
      showToast('Enable Manager Mode to edit discount reasons.', { type: 'error' });
      return;
    }
    const reasons = readDiscountReasonsFromTextarea();
    const saved = await invoke('settings:saveDiscountReasons', { discountReasons: reasons });
    writeDiscountReasonsToTextarea(saved?.discountReasons || reasons);
    showToast('Saved discount reasons.', { type: 'success' });
  } catch (e) { showToast('Failed to save discount reasons: ' + (e?.message || e), { type: 'error' }); }
}

async function authFetch(url, options = {}) {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const message = data?.error || resp.statusText || 'Request failed';
    throw new Error(message);
  }
  return data;
}

function showUserAdminError(message) {
  const el = document.getElementById('userAdminError');
  if (!el) return;
  el.textContent = message;
  el.style.display = message ? '' : 'none';
}

function renderUsersTable(users = []) {
  const body = document.getElementById('usersTableBody');
  if (!body) return;
  body.innerHTML = '';
  users.forEach(user => {
    const tr = document.createElement('tr');
    tr.dataset.userId = String(user.id);
    tr.innerHTML = `
      <td>${escapeHtml(user.username)}</td>
      <td><input class="form-control form-control-sm" value="${escapeHtml(user.displayName || '')}" data-field="displayName" /></td>
      <td>
        <select class="form-select form-select-sm" data-field="role">
          <option value="cashier">Cashier</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </select>
      </td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-primary me-1" data-action="save">Save</button>
        <button class="btn btn-sm btn-outline-secondary" data-action="reset">Reset Password</button>
      </td>
    `;
    const roleSelect = tr.querySelector('[data-field="role"]');
    if (roleSelect) roleSelect.value = String(user.role || 'cashier');
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-action="save"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      if (!row) return;
      const id = row.dataset.userId;
      const displayName = row.querySelector('[data-field="displayName"]')?.value || '';
      const role = row.querySelector('[data-field="role"]')?.value || 'cashier';
      try {
        await authFetch(`/api/admin/users/${encodeURIComponent(id)}`, {
          method: 'PUT',
          body: JSON.stringify({ displayName, role })
        });
        showToast('User updated.', { type: 'success' });
      } catch (err) {
        showToast(err?.message || 'Failed to update user.', { type: 'error' });
      }
    });
  });
  body.querySelectorAll('[data-action="reset"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      if (!row) return;
      const id = row.dataset.userId;
      const username = row.querySelector('td')?.textContent || 'user';
      const next = window.prompt(`Enter a new password for ${username}:`);
      if (!next) return;
      try {
        await authFetch(`/api/admin/users/${encodeURIComponent(id)}/password`, {
          method: 'POST',
          body: JSON.stringify({ password: next })
        });
        showToast('Password reset.', { type: 'success' });
      } catch (err) {
        showToast(err?.message || 'Failed to reset password.', { type: 'error' });
      }
    });
  });
}

async function loadUsers() {
  if (roleRank(__authRole) < roleRank('admin')) return;
  try {
    const users = await authFetch('/api/admin/users');
    renderUsersTable(Array.isArray(users) ? users : []);
  } catch (err) {
    showUserAdminError(err?.message || 'Failed to load users.');
  }
}

async function handleCreateUser(event) {
  event.preventDefault();
  showUserAdminError('');
  const username = document.getElementById('newUserUsername')?.value || '';
  const displayName = document.getElementById('newUserDisplayName')?.value || '';
  const role = document.getElementById('newUserRole')?.value || 'cashier';
  const password = document.getElementById('newUserPassword')?.value || '';
  if (!username || !password) {
    showUserAdminError('Username and password are required.');
    return;
  }
  try {
    await authFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, displayName, role, password })
    });
    document.getElementById('newUserUsername').value = '';
    document.getElementById('newUserDisplayName').value = '';
    document.getElementById('newUserPassword').value = '';
    showToast('User created.', { type: 'success' });
    await loadUsers();
  } catch (err) {
    showUserAdminError(err?.message || 'Failed to create user.');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  ensureActivityListeners();
  loadAuthUser().then(loadUsers);
  document.getElementById('saveBtn')?.addEventListener('click', saveTaxSettings);
  document.getElementById('saveGiftCardSurchargeBtn')?.addEventListener('click', saveGiftCardSurchargeSettings);
  document.getElementById('savePrintBtn')?.addEventListener('click', savePrintSettings);
  document.getElementById('saveBrandingBtn')?.addEventListener('click', saveBrandingSettings);
  document.getElementById('saveDiscountReasonsBtn')?.addEventListener('click', saveDiscountReasons);
  document.getElementById('saveTaxOrgBtn')?.addEventListener('click', addOrUpdateTaxOrg);
  document.getElementById('cancelTaxOrgEditBtn')?.addEventListener('click', resetTaxOrgForm);
  document.getElementById('openVendorPromosBtn')?.addEventListener('click', openVendorPromoModal);
  document.getElementById('saveVendorPromoBtn')?.addEventListener('click', addOrUpdateVendorPromo);
  document.getElementById('saveDenomTargetsBtn')?.addEventListener('click', saveDenominationTargets);
  document.getElementById('customerDisplayEnabled')?.addEventListener('change', (event) => {
    saveCustomerDisplaySettings(event?.target?.checked);
  });
  document.getElementById('refreshCustomerDisplayBtn')?.addEventListener('click', refreshCustomerDisplay);
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try { await invoke('auth:logout'); } catch (_) { }
    window.location.href = 'login.html';
  });
  document.getElementById('createUserForm')?.addEventListener('submit', handleCreateUser);
  if (api) {
    try {
      invoke('app:getVersion').then(v => {
        const el = document.getElementById('appVersion');
        if (el) el.textContent = 'v' + (v || '');
      }).catch(() => {});
    } catch (_) {}
  } else {
    const el = document.getElementById('appVersion');
    if (el) el.textContent = 'web';
  }
  loadVendorsForPromos();
  try { ensurePromoEditModal(); } catch (_) { }
    try {
      api?.on?.('settings:changed', (_evt, payload) => {
        if (payload?.drawerDenominationTargets || payload?.denominationTargets) {
          renderDenominationTargetInputs(payload.drawerDenominationTargets || payload.denominationTargets || {});
        }
        if (Array.isArray(payload?.taxExemptOrgs)) {
          __taxExemptOrgs = normalizeTaxExemptOrgs(payload.taxExemptOrgs);
          renderTaxOrgTable();
          resetTaxOrgForm();
        }
        if (Object.prototype.hasOwnProperty.call(payload || {}, 'giftCardSurchargeRate')) {
          const giftRateEl = document.getElementById('giftCardSurchargePct');
          if (giftRateEl) giftRateEl.value = toPct(payload.giftCardSurchargeRate || 0);
        }
        if (Object.prototype.hasOwnProperty.call(payload || {}, 'customerDisplayEnabled')) {
          const displayToggle = document.getElementById('customerDisplayEnabled');
          if (displayToggle) displayToggle.checked = toBool(payload.customerDisplayEnabled);
        }
      });
    } catch (_) {}
});
window.addEventListener('load', () => { loadSettings(); refreshAppConfigStatus(); });

// Test-friendly exports (no impact in Electron runtime)
try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      toBool,
      setBrandingVisibility,
      loadSettings,
      saveDevSettings,
      toggleDeveloperMode,
      setDeveloperMode
    };
  }
} catch (_) { }

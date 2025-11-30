// settings.js
const { ipcRenderer } = require('electron');

function toPct(val) { return (Number(val || 0) * 100).toFixed(2); }
function fromPct(pct) { return Number(pct || 0) / 100; }

function toBool(val) {
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled'].includes(v)) return false;
    return v === 'true' || v === '1' || v === 'yes' || v === 'on' || v === 'enabled';
  }
  return Boolean(val);
}

function setBrandingVisibility(isDev) {
  try {
    const card = document.getElementById('brandingCard');
    if (card) card.style.display = isDev ? '' : 'none';
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

async function loadSettings() {
  try {
    const s = await ipcRenderer.invoke('settings:load');
    const rate = Number(s?.taxRate ?? 0.0725);
    document.getElementById('taxRatePct').value = toPct(rate);
    const dev = toBool(s?.developerMode);
    const devEl = document.getElementById('devMode');
    if (devEl) devEl.checked = dev;
    setBrandingVisibility(dev);
    const sp = Boolean(s?.silentPrint);
    const spEl = document.getElementById('silentPrint');
    if (spEl) spEl.checked = sp;
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

    // Populate printers
    try {
      const printers = await ipcRenderer.invoke('print:listPrinters');
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

    // Discount reasons
    writeDiscountReasonsToTextarea(s?.discountReasons || []);
  } catch (e) { showToast('Failed to load settings: ' + (e?.message || e), { type: 'error' }); }
}

async function saveTaxSettings() {
  try {
    const pct = document.getElementById('taxRatePct').value;
    const rate = fromPct(pct);
    const saved = await ipcRenderer.invoke('settings:saveTax', { taxRate: rate });
    showToast('Saved. Tax rate: ' + toPct(saved.taxRate) + '%', { type: 'success' });
  } catch (e) { showToast('Failed to save tax rate: ' + (e?.message || e), { type: 'error' }); }
}

async function saveDevSettings() {
  try {
    const developerMode = !!document.getElementById('devMode')?.checked;
    let password = '';
    if (developerMode) {
      password = await requestDevPassword();
      if (!password) {
        document.getElementById('devMode').checked = false;
        setBrandingVisibility(false);
        showToast('Developer mode not enabled (no password entered).', { type: 'error' });
        return;
      }
    }
    const saved = await ipcRenderer.invoke('settings:saveDev', { developerMode, password });
    const devSaved = toBool(saved?.developerMode);
    document.getElementById('devMode').checked = devSaved;
    setBrandingVisibility(devSaved);
    showToast('Saved. Developer Mode: ' + (devSaved ? 'On' : 'Off'), { type: 'success' });
  } catch (e) {
    document.getElementById('devMode').checked = false;
    setBrandingVisibility(false);
    const msg = (e && (e.code === 'INVALID_DEV_PASSWORD' || String(e.message || '').toLowerCase().includes('invalid developer password')))
      ? 'Invalid Password Entered.'
      : 'Failed to save developer mode: ' + (e?.message || e);
    showToast(msg, { type: 'error' });
  }
}

async function savePrintSettings() {
  try {
    const silentPrint = !!document.getElementById('silentPrint')?.checked;
    const printerName = String(document.getElementById('printerSelect')?.value || '');
    const saved = await ipcRenderer.invoke('settings:saveSilent', { silentPrint, printerName });
    showToast('Saved. Silent Print: ' + (saved.silentPrint ? 'On' : 'Off'), { type: 'success' });
  } catch (e) { showToast('Failed to save printing settings: ' + (e?.message || e), { type: 'error' }); }
}

async function saveBrandingSettings() {
  try {
    const bizName = document.getElementById('bizName')?.value || '';
    const bizAddress = document.getElementById('bizAddress')?.value || '';
    const bizPhone = document.getElementById('bizPhone')?.value || '';
    const logoInput = document.getElementById('logoInput');
    let logoFilePath = '';
    try {
      const file = logoInput && logoInput.files && logoInput.files[0];
      if (file && file.path) logoFilePath = String(file.path || '');
    } catch (_) { }
    const saved = await ipcRenderer.invoke('settings:saveBranding', {
      bizName,
      bizAddress,
      bizPhone,
      logoFilePath
    });
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
    const reasons = readDiscountReasonsFromTextarea();
    const saved = await ipcRenderer.invoke('settings:saveDiscountReasons', { discountReasons: reasons });
    writeDiscountReasonsToTextarea(saved?.discountReasons || reasons);
    showToast('Saved discount reasons.', { type: 'success' });
  } catch (e) { showToast('Failed to save discount reasons: ' + (e?.message || e), { type: 'error' }); }
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveBtn')?.addEventListener('click', saveTaxSettings);
  document.getElementById('saveDevBtn')?.addEventListener('click', saveDevSettings);
  document.getElementById('savePrintBtn')?.addEventListener('click', savePrintSettings);
  document.getElementById('saveBrandingBtn')?.addEventListener('click', saveBrandingSettings);
  document.getElementById('saveDiscountReasonsBtn')?.addEventListener('click', saveDiscountReasons);
  try {
    ipcRenderer.invoke('app:getVersion').then(v => {
      const el = document.getElementById('appVersion');
      if (el) el.textContent = 'v' + (v || '');
    }).catch(() => {});
  } catch (_) {}
});
window.addEventListener('load', loadSettings);

// Test-friendly exports (no impact in Electron runtime)
try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      toBool,
      setBrandingVisibility,
      loadSettings,
      saveDevSettings
    };
  }
} catch (_) { }

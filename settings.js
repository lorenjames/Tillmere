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

// --- Vendor promotions (settings UI only) ---
let __vendorPromotions = [];
let __promoModal = null;
let __promoEditingIndex = -1;
let __vendorList = [];

function todayYmdLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function normalizeVendorPromotions(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
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
      const [safeStart, safeEnd] = startTs <= endTs ? [startDate, endDate] : [endDate, startDate];
      return {
        id: String(p?.id || `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`),
        vendorCode,
        vendorName,
        type,
        value,
        startDate: safeStart,
        endDate: safeEnd
      };
    })
    .filter(Boolean)
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
function populatePromoVendorSelect() {
  const sel = document.getElementById('promoVendorSelect');
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
    const list = await ipcRenderer.invoke('vendors:load');
    __vendorList = Array.isArray(list) ? list : [];
    populatePromoVendorSelect();
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
    if (delBtn) delBtn.addEventListener('click', () => deleteVendorPromo(idx));
    tbody.appendChild(tr);
  });
}
function openVendorPromoModal() {
  try {
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
async function persistVendorPromos() {
  try {
    const saved = await ipcRenderer.invoke('settings:saveVendorPromotions', { vendorPromotions: __vendorPromotions });
    __vendorPromotions = normalizeVendorPromotions(saved?.vendorPromotions || __vendorPromotions);
    renderVendorPromoSummary();
    renderVendorPromoTable();
    showToast('Vendor promotions saved.', { type: 'success' });
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
  const vendorObj = (__vendorList || []).find(v => String(v?.code || '').trim().toLowerCase() === vendorCode.toLowerCase());
  const vendorName = vendorObj?.name || vendorCode;
  const promo = {
    id: (__promoEditingIndex >= 0 && __vendorPromotions[__promoEditingIndex]) ? __vendorPromotions[__promoEditingIndex].id : `promo-${Date.now()}`,
    vendorCode,
    vendorName,
    type,
    value,
    startDate: startTs <= endTs ? startDate : endDate,
    endDate: startTs <= endTs ? endDate : startDate
  };
  if (__promoEditingIndex >= 0 && __vendorPromotions[__promoEditingIndex]) {
    __vendorPromotions[__promoEditingIndex] = promo;
  } else {
    __vendorPromotions.push(promo);
  }
  __vendorPromotions = normalizeVendorPromotions(__vendorPromotions);
  await persistVendorPromos();
  resetVendorPromoForm();
}
function editVendorPromo(idx) {
  const promo = __vendorPromotions[idx];
  if (!promo) return;
  __promoEditingIndex = idx;
  try {
    document.getElementById('promoVendorSelect').value = promo.vendorCode || '';
    document.getElementById('promoType').value = promo.type === 'amount' ? 'amount' : 'percent';
    document.getElementById('promoValue').value = promo.value;
    document.getElementById('promoStart').value = promo.startDate || '';
    document.getElementById('promoEnd').value = promo.endDate || '';
    const btn = document.getElementById('saveVendorPromoBtn');
    if (btn) btn.textContent = 'Update Promotion';
    renderVendorPromoTable();
  } catch (_) { }
}
async function deleteVendorPromo(idx) {
  const promo = __vendorPromotions[idx];
  if (!promo) return;
  if (!window.confirm('Delete this vendor promotion?')) return;
  __vendorPromotions.splice(idx, 1);
  await persistVendorPromos();
  resetVendorPromoForm();
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
    __vendorPromotions = normalizeVendorPromotions(s?.vendorPromotions || []);
    renderVendorPromoSummary();
    renderVendorPromoTable();
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
  document.getElementById('openVendorPromosBtn')?.addEventListener('click', openVendorPromoModal);
  document.getElementById('saveVendorPromoBtn')?.addEventListener('click', addOrUpdateVendorPromo);
  try {
    ipcRenderer.invoke('app:getVersion').then(v => {
      const el = document.getElementById('appVersion');
      if (el) el.textContent = 'v' + (v || '');
    }).catch(() => {});
  } catch (_) {}
  loadVendorsForPromos();
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

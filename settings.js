// settings.js
const { ipcRenderer } = require('electron');

function toPct(val) { return (Number(val || 0) * 100).toFixed(2); }
function fromPct(pct) { return Number(pct || 0) / 100; }

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

async function loadSettings() {
  try {
    const s = await ipcRenderer.invoke('settings:load');
    const rate = Number(s?.taxRate ?? 0.0725);
    document.getElementById('taxRatePct').value = toPct(rate);
    const dev = Boolean(s?.developerMode);
    const devEl = document.getElementById('devMode');
    if (devEl) devEl.checked = dev;
    const sp = Boolean(s?.silentPrint);
    const spEl = document.getElementById('silentPrint');
    if (spEl) spEl.checked = sp;

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
    const saved = await ipcRenderer.invoke('settings:saveDev', { developerMode });
    showToast('Saved. Developer Mode: ' + (saved.developerMode ? 'On' : 'Off'), { type: 'success' });
  } catch (e) { showToast('Failed to save developer mode: ' + (e?.message || e), { type: 'error' }); }
}

async function savePrintSettings() {
  try {
    const silentPrint = !!document.getElementById('silentPrint')?.checked;
    const printerName = String(document.getElementById('printerSelect')?.value || '');
    const saved = await ipcRenderer.invoke('settings:saveSilent', { silentPrint, printerName });
    showToast('Saved. Silent Print: ' + (saved.silentPrint ? 'On' : 'Off'), { type: 'success' });
  } catch (e) { showToast('Failed to save printing settings: ' + (e?.message || e), { type: 'error' }); }
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveBtn')?.addEventListener('click', saveTaxSettings);
  document.getElementById('saveDevBtn')?.addEventListener('click', saveDevSettings);
  document.getElementById('savePrintBtn')?.addEventListener('click', savePrintSettings);
  try {
    ipcRenderer.invoke('app:getVersion').then(v => {
      const el = document.getElementById('appVersion');
      if (el) el.textContent = 'v' + (v || '');
    }).catch(() => {});
  } catch (_) {}
});
window.addEventListener('load', loadSettings);

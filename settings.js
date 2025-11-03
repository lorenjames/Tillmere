// settings.js
const { ipcRenderer } = require('electron');

function toPct(val) { return (Number(val || 0) * 100).toFixed(2); }
function fromPct(pct) { return Number(pct || 0) / 100; }

async function loadSettings() {
  try {
    const s = await ipcRenderer.invoke('settings:load');
    const rate = Number(s?.taxRate ?? 0.0725);
    document.getElementById('taxRatePct').value = toPct(rate);
    const dev = Boolean(s?.developerMode);
    const devEl = document.getElementById('devMode');
    if (devEl) devEl.checked = dev;
  } catch (e) {
    alert('Failed to load settings: ' + (e?.message || e));
  }
}

async function saveTaxSettings() {
  try {
    const pct = document.getElementById('taxRatePct').value;
    const rate = fromPct(pct);
    const saved = await ipcRenderer.invoke('settings:saveTax', { taxRate: rate });
    alert('Saved. New tax rate: ' + toPct(saved.taxRate) + '%');
  } catch (e) {
    alert('Failed to save tax rate: ' + (e?.message || e));
  }
}

async function saveDevSettings() {
  try {
    const developerMode = !!document.getElementById('devMode')?.checked;
    const saved = await ipcRenderer.invoke('settings:saveDev', { developerMode });
    alert('Saved. Developer Mode: ' + (saved.developerMode ? 'On' : 'Off'));
  } catch (e) {
    alert('Failed to save developer mode: ' + (e?.message || e));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveBtn')?.addEventListener('click', saveTaxSettings);
  document.getElementById('saveDevBtn')?.addEventListener('click', saveDevSettings);
});
window.addEventListener('load', loadSettings);

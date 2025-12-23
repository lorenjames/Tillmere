// cashiers.js
const { ipcRenderer } = require('electron');

function wireCloseAppLink() {
    const closeAppLink = document.getElementById('closeAppLink');
    if (closeAppLink) {
        closeAppLink.addEventListener('click', () => {
            try { ipcRenderer.invoke('app:quit'); } catch (_) { }
        });
    }
    const userGuideLink = document.getElementById('userGuideLink');
    if (userGuideLink) {
        userGuideLink.addEventListener('click', (event) => {
            event.preventDefault();
            try { ipcRenderer.invoke('app:openUserGuide'); } catch (_) { }
        });
    }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireCloseAppLink);
} else {
  wireCloseAppLink();
}

let cache = [];
let __cashierEditIndex = -1;
let __pinModalIndex = -1;
let __developerMode = false;
function escapeHtml(s) { return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

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
        setTimeout(() => { try { el.remove(); } catch (_) { } }, ms);
    } catch (_) { }
}

function focusElement(selectorOrElement) {
    try {
        const el = typeof selectorOrElement === 'string' ? document.querySelector(selectorOrElement) : selectorOrElement;
        if (el && typeof el.focus === 'function') {
            el.focus();
        }
    } catch (_) { }
}

async function refreshDeveloperModeState() {
    try {
        const settings = await ipcRenderer.invoke('settings:load');
        __developerMode = !!settings?.developerMode;
    } catch (_) { }
}

async function load() { const list = await ipcRenderer.invoke('cashiers:load'); cache = Array.isArray(list) ? list : []; cache.sort((a, b) => (a.name || '').localeCompare(b.name || '')); }
async function save() { cache = await ipcRenderer.invoke('cashiers:save', cache); cache.sort((a, b) => (a.name || '').localeCompare(b.name || '')); }

async function render() {
    await load();
    const tbody = document.getElementById('cashierTable');
    tbody.innerHTML = '';
    cache.forEach((c, i) => {
        const tr = document.createElement('tr');
        const resetButton = (__developerMode && c.pinSet)
            ? `<button class="btn btn-outline-warning" onclick="resetCashierPin(${i})">Reset PIN</button>`
            : '';
        tr.innerHTML = `
          <td>
            <div>${escapeHtml(c.name || '')}</div>
            <div class="small text-muted">${c.pinSet ? 'PIN set' : 'PIN not set'}</div>
          </td>
          <td>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-primary" onclick="openCashierEdit(${i})">Edit</button>
              <button class="btn btn-outline-success" onclick="openSetPinModal(${i})">Set PIN</button>
              <button class="btn btn-outline-danger" onclick="deleteCashier(${i})">Delete</button>
              ${resetButton}
            </div>
          </td>
        `;
        tbody.appendChild(tr);
    });
}
window.addCashier = async function () {
    const inp = document.getElementById('newCashier');
    const name = (inp.value || '').trim();
    if (!name) { showToast('Cashier name is required.', { type: 'error' }); focusElement('#newCashier'); return; }
    await load();
    if (cache.some(c => (c.name || '').toLowerCase() === name.toLowerCase())) { showToast('Cashier already exists.', { type: 'error' }); focusElement('#newCashier'); return; }
    cache.push({ name, pinSet: false });
    await save();
    inp.value = '';
    render();
};
window.openCashierEdit = async function (i) {
    await load();
    if (!cache[i]) return;
    __cashierEditIndex = i;
    try { document.getElementById('edit_cashier_name').value = cache[i].name || ''; } catch (_) { }
    try {
        const el = document.getElementById('cashierEditModal');
        if (el && window.bootstrap && window.bootstrap.Modal) {
            const m = window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' });
            m.show();
        } else {
            el?.classList.add('show');
            el?.setAttribute('style', 'display:block');
        }
    } catch (_) { }
};
window.saveCashierEdit = async function () {
    if (__cashierEditIndex < 0) return;
    await load();
    const i = __cashierEditIndex;
    if (!cache[i]) return;
    const name = String(document.getElementById('edit_cashier_name')?.value || '').trim();
    if (!name) { showToast('Cashier name cannot be empty.', { type: 'error' }); focusElement('#edit_cashier_name'); return; }
    if (cache.some((c, idx) => idx !== i && (c.name || '').toLowerCase() === name.toLowerCase())) { showToast('Cashier already exists.', { type: 'error' }); focusElement('#edit_cashier_name'); return; }
    cache[i].name = name;
    await save();
    try {
        const el = document.getElementById('cashierEditModal');
        if (el && window.bootstrap && window.bootstrap.Modal) {
            const m = window.bootstrap.Modal.getOrCreateInstance(el);
            m.hide();
        } else {
            el?.classList.remove('show');
            el?.setAttribute('style', 'display:none');
        }
    } catch (_) { }
    __cashierEditIndex = -1;
    render();
};
window.openSetPinModal = async function (i) {
    await load();
    if (!cache[i]) return;
    __pinModalIndex = i;
    try {
        document.getElementById('pinModalTitle').textContent = `Set PIN - ${cache[i].name}`;
        document.getElementById('pinModalValue').value = '';
        document.getElementById('pinModalConfirm').value = '';
        const curWrap = document.getElementById('pinModalCurrentWrap');
        const curInput = document.getElementById('pinModalCurrent');
        if (curWrap) curWrap.classList.toggle('d-none', !cache[i].pinSet);
        if (curInput) curInput.value = '';
    } catch (_) { }
    try {
        const el = document.getElementById('cashierPinModal');
        if (el && window.bootstrap && window.bootstrap.Modal) {
            const m = window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' });
            m.show();
            setTimeout(() => { try { document.getElementById('pinModalValue')?.focus(); } catch (_) { } }, 150);
        } else {
            el?.classList.add('show');
            el?.setAttribute('style', 'display:block');
        }
    } catch (_) { }
};
window.applyPinModal = async function () {
    if (__pinModalIndex < 0) return;
    await load();
    const row = cache[__pinModalIndex];
    if (!row) return;
    const name = row.name;
    const currentPin = String(document.getElementById('pinModalCurrent')?.value || '').trim();
    const pin = String(document.getElementById('pinModalValue')?.value || '').trim();
    const confirm = String(document.getElementById('pinModalConfirm')?.value || '').trim();
    if (!pin || !confirm) { showToast('Enter PIN and confirm.', { type: 'error' }); return; }
    if (pin !== confirm) { showToast('PINs do not match.', { type: 'error' }); return; }
    if (!/^[0-9]{4,8}$/.test(pin)) { showToast('PIN must be 4-8 digits.', { type: 'error' }); return; }
    if (row.pinSet && !currentPin) { showToast('Enter current PIN.', { type: 'error' }); return; }
    try {
        await ipcRenderer.invoke('cashiers:setPin', { name, pin, currentPin });
        showToast('PIN updated.', { type: 'success' });
        __pinModalIndex = -1;
        try {
            const el = document.getElementById('cashierPinModal');
            if (el && window.bootstrap && window.bootstrap.Modal) window.bootstrap.Modal.getOrCreateInstance(el).hide();
            else { el?.classList.remove('show'); el?.setAttribute('style', 'display:none'); }
        } catch (_) { }
        await render();
    } catch (e) {
        console.error(e);
        showToast('Failed to set PIN: ' + (e?.message || ''), { type: 'error' });
    }
};
window.resetCashierPin = async function (i) {
    if (!__developerMode) {
        showToast('Developer Mode is required to reset PINs.', { type: 'error' });
        return;
    }
    await load();
    const row = cache[i];
    if (!row) return;
    if (!row.pinSet) {
        showToast('Cashier has no PIN to reset.', { type: 'info' });
        return;
    }
    if (!confirm(`Reset PIN for "${row.name}"? This will require them to set a new PIN.`)) return;
    try {
        await ipcRenderer.invoke('cashiers:resetPin', { name: row.name });
        showToast('PIN cleared; cashier must set a new one.', { type: 'success' });
        await render();
    } catch (e) {
        console.error(e);
        showToast('Failed to reset PIN: ' + (e?.message || ''), { type: 'error' });
    }
};
window.deleteCashier = async function (i) {
    await load();
    if (!cache[i]) return;
    if (!confirm(`Delete cashier "${cache[i].name}"?`)) return;
    cache.splice(i, 1);
    await save();
    render();
};
// (admin auth removed - rollback)

try {
    ipcRenderer.on('settings:changed', (_evt, payload) => {
        if (typeof payload?.developerMode === 'boolean') {
            const next = !!payload.developerMode;
            if (next !== __developerMode) {
                __developerMode = next;
                render().catch(() => { });
            }
        }
    });
} catch (_) { }

window.onload = async function(){
  try { document.getElementById('cashier_edit_save_btn')?.addEventListener('click', () => { try { saveCashierEdit(); } catch(_){} }); } catch(_){}
  try { document.getElementById('cashier_pin_save_btn')?.addEventListener('click', () => { try { applyPinModal(); } catch(_){} }); } catch(_){}
  await refreshDeveloperModeState();
  await render();
};

// vendors.js
const { ipcRenderer } = require('electron');

function escapeHtml(s) { return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

let cache = [];
let __vendorEditIndex = -1;
let sortField = 'name';
const SORT_LABELS = { name: 'Name (A-Z)', code: 'Vendor Code (A-Z)' };

function sortCache() {
    const primary = sortField;
    const fallback = primary === 'code' ? 'name' : 'code';
    cache.sort((aRaw, bRaw) => {
        const aPrimary = String(aRaw?.[primary] || '').trim();
        const bPrimary = String(bRaw?.[primary] || '').trim();
        if (aPrimary && bPrimary) {
            const cmp = aPrimary.localeCompare(bPrimary, undefined, { sensitivity: 'base' });
            if (cmp !== 0) return cmp;
        } else if (aPrimary) {
            return -1;
        } else if (bPrimary) {
            return 1;
        }
        const aFallback = String(aRaw?.[fallback] || '').trim();
        const bFallback = String(bRaw?.[fallback] || '').trim();
        return aFallback.localeCompare(bFallback, undefined, { sensitivity: 'base' });
    });
}
function updateSortButton() {
    const btn = document.getElementById('vendorSortButton');
    if (!btn) return;
    const label = SORT_LABELS[sortField] || '';
    btn.textContent = label ? `Sort: ${label}` : 'Sort';
}
async function loadFromDisk() {
    const list = await ipcRenderer.invoke('vendors:load');
    cache = Array.isArray(list) ? list.slice() : [];
    sortCache();
}
async function saveToDisk() {
    cache = await ipcRenderer.invoke('vendors:save', cache);
    sortCache();
}
async function renderTable(options = {}) {
    const { reload = true } = options;
    if (reload) await loadFromDisk();
    else sortCache();
    updateSortButton();
    const tbody = document.querySelector('#vendorTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    cache.forEach((v, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
        <td>${escapeHtml(v.code || '')}</td>
        <td>${escapeHtml(v.name || '')}</td>
        <td>${escapeHtml(v.phone || '')}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button class="btn btn-outline-primary" onclick="openVendorEdit(${idx})">Edit</button>
            <button class="btn btn-outline-danger" onclick="deleteVendor(${idx})">Delete</button>
          </div>
        </td>
      `;
        tbody.appendChild(tr);
    });
}
window.addVendor = async function () {
    const nameEl = document.getElementById('newVendorName');
    const phoneEl = document.getElementById('newVendorPhone');
    const codeEl = document.getElementById('newVendorCode');
    const name = (nameEl.value || '').trim();
    const phone = (phoneEl.value || '').trim();
    const code = (codeEl.value || '').trim();
    if (!name) return alert('Vendor name is required.');
    await loadFromDisk();
    if (code && cache.some(v => (v.code || '').toLowerCase() === code.toLowerCase())) return alert('Vendor code must be unique.');
    cache.push({ name, phone, code });
    await saveToDisk();
    nameEl.value = ''; phoneEl.value = ''; codeEl.value = '';
    renderTable();
};
window.openVendorEdit = async function (i) {
    await loadFromDisk();
    if (!cache[i]) return;
    __vendorEditIndex = i;
    try {
        document.getElementById('edit_vendor_code').value = cache[i].code || '';
        document.getElementById('edit_vendor_name').value = cache[i].name || '';
        document.getElementById('edit_vendor_phone').value = cache[i].phone || '';
    } catch (_) { }
    try {
        const el = document.getElementById('vendorEditModal');
        if (el && window.bootstrap && window.bootstrap.Modal) {
            const m = window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' });
            m.show();
        } else {
            el?.classList.add('show');
            el?.setAttribute('style', 'display:block');
        }
    } catch (_) { }
};
window.saveVendorEdit = async function () {
    if (__vendorEditIndex < 0) return;
    await loadFromDisk();
    const i = __vendorEditIndex;
    if (!cache[i]) return;
    const code = String(document.getElementById('edit_vendor_code')?.value || '').trim();
    const name = String(document.getElementById('edit_vendor_name')?.value || '').trim();
    const phone = String(document.getElementById('edit_vendor_phone')?.value || '').trim();
    if (!name) return alert('Vendor name cannot be empty.');
    if (code) {
        const lower = code.toLowerCase();
        if (cache.some((v, idx) => idx !== i && (v.code || '').toLowerCase() === lower)) return alert('Vendor code must be unique.');
    }
    cache[i] = { name, phone, code };
    await saveToDisk();
    try {
        const el = document.getElementById('vendorEditModal');
        if (el && window.bootstrap && window.bootstrap.Modal) {
            const m = window.bootstrap.Modal.getOrCreateInstance(el);
            m.hide();
        } else {
            el?.classList.remove('show');
            el?.setAttribute('style', 'display:none');
        }
    } catch (_) { }
    __vendorEditIndex = -1;
    renderTable();
};
window.deleteVendor = async function (i) {
    await loadFromDisk();
    if (!cache[i]) return;
    if (!confirm(`Delete vendor "${cache[i].name}"?`)) return;
    cache.splice(i, 1);
    await saveToDisk();
    renderTable();
};
window.setVendorSort = function (field) {
    if (field !== 'name' && field !== 'code') return;
    sortField = field;
    sortCache();
    renderTable({ reload: false });
};
// (admin auth removed - rollback)

window.onload = function(){
  try { document.getElementById('vendor_edit_save_btn')?.addEventListener('click', () => { try { saveVendorEdit(); } catch(_){} }); } catch(_){}
  renderTable();
};

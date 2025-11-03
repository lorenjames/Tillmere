// vendors.js
const { ipcRenderer } = require('electron');

function escapeHtml(s) { return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

let cache = [];
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
        <td><input type="text" class="form-control" value="${escapeHtml(v.code || '')}" onchange="editVendor(${idx}, 'code', this.value)"></td>
      <td><input type="text" class="form-control" value="${escapeHtml(v.name || '')}" onchange="editVendor(${idx}, 'name', this.value)"></td>
      <td><input type="text" class="form-control" value="${escapeHtml(v.phone || '')}" onchange="editVendor(${idx}, 'phone', this.value)"></td>
      <td><button class="btn btn-outline-danger btn-sm" onclick="deleteVendor(${idx})">Delete</button></td>
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
window.editVendor = async function (i, field, value) {
    await loadFromDisk();
    if (!cache[i]) return;
    const val = String(value || '').trim();
    if (field === 'name' && !val) return alert('Vendor name cannot be empty.');
    if (field === 'code' && val) {
        const lower = val.toLowerCase();
        if (cache.some((v, idx) => idx !== i && (v.code || '').toLowerCase() === lower)) return alert('Vendor code must be unique.');
    }
    cache[i][field] = val;
    await saveToDisk();
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

window.onload = renderTable;

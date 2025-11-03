// receipts.js
const { ipcRenderer } = require('electron');

let all = [];
let filtered = [];
let currentPage = 1;
let pageSize = 10;

const $ = sel => document.querySelector(sel);
const norm = s => String(s || '').trim().toLowerCase();
function money(n) { return Number(n || 0).toFixed(2); }
function esc(s) { return String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
function toMoneyNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}
function deriveOriginalPrice(it) {
  if (typeof it?.originalPrice === 'number' && !Number.isNaN(it.originalPrice)) {
    return toMoneyNumber(it.originalPrice);
  }
  const price = toMoneyNumber(it?.price || 0);
  const discount = toMoneyNumber(it?.discountAmount || 0);
  return toMoneyNumber(price + discount);
}
function deriveDiscount(it) {
  const finalPrice = toMoneyNumber(it?.price || 0);
  const original = deriveOriginalPrice(it);
  const discountAmount = Math.max(0, toMoneyNumber(it?.discountAmount ?? (original - finalPrice)));
  const reason = discountAmount > 0 ? String(it?.discountReason || '').trim() : '';
  const type = discountAmount > 0 ? (it?.discountType === 'percent' ? 'percent' : 'amount') : 'none';
  const value = discountAmount > 0
    ? (type === 'percent' ? toMoneyNumber(it?.discountValue || 0) : discountAmount)
    : 0;
  return { finalPrice, original, discountAmount, reason, type, value };
}
function formatPercentText(value) {
  const pct = toMoneyNumber(value);
  if (pct <= 0) return '';
  const isWhole = Math.abs(pct - Math.round(pct)) < 0.01;
  const str = isWhole ? String(Math.round(pct)) : pct.toFixed(2).replace(/\.?0+$/, '');
  return `${str}%`;
}
function formatDiscountLabel(type, value, amount) {
  if (type === 'percent') {
    const pct = formatPercentText(value);
    return pct ? `${pct} off` : '';
  }
  if (type === 'amount') {
    const amt = toMoneyNumber(amount || value);
    if (amt <= 0) return '';
    return `$${money(amt)} off`;
  }
  return '';
}
function buildDiscountSuffix(type, value, amount, reason, escapeFn = s => s) {
  const parts = [];
  const trimmed = String(reason || '').trim();
  if (trimmed) parts.push(escapeFn(trimmed));
  const label = formatDiscountLabel(type, value, amount);
  if (label) parts.push(escapeFn(label));
  return parts.length ? ` (${parts.join(', ')})` : '';
}
function toDateInputValue(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------- load & filters ----------
async function loadAll() {
  const list = await ipcRenderer.invoke('receipts:load');
  all = Array.isArray(list) ? list : [];
  all.sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}
async function populateCashiersFilter() {
  const sel = $('#cashierFilter');
  sel.innerHTML = '<option value="">All</option>';
  const names = Array.from(new Set(all.map(r => r.cashier).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  names.forEach(n => { const opt = document.createElement('option'); opt.value = n; opt.textContent = n; sel.appendChild(opt); });
}

function applyFilters() {
  const q = ($('#q').value || '').toLowerCase().trim();
  const fromVal = $('#fromDate').value;
  const toVal = $('#toDate').value;
  const cashier = $('#cashierFilter').value;
  const payment = $('#paymentFilter').value;
  const voidFilter = $('#voidFilter')?.value || 'hide';

  // Interpret dates in local time to avoid UTC day-shift
  const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
  const to = toVal ? new Date(toVal + 'T23:59:59') : null;

  filtered = all.filter(r => {
    if (voidFilter === 'hide' && r.voided) return false;
    const when = r.datetime ? new Date(r.datetime) : null;
    if (from && when && when < from) return false;
    if (to && when && when > to) return false;
    if (cashier && (r.cashier || '') !== cashier) return false;
    if (payment && (r.payment || '') !== payment) return false;

    if (q) {
      const hay = [
        r.number, r.cashier, r.payment,
        ...(r.items || []).map(i => i.name),
        ...(r.items || []).map(i => i.vendor),
        ...(r.items || []).map(i => i.vendorCode || ''),
        r.voidInfo?.reason || ''
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Reset to first page whenever filters change
  currentPage = 1;
  renderTable();
  renderVendorSubtotals();
}

// ---------- vendor subtotals ----------
function renderVendorSubtotals() {
  const bucket = {}; // by resolved vendor (code preferred, fallback to name)
  filtered.forEach(r => {
    if (r.voided) return;
    (r.items || []).forEach(it => {
      let key = String(it.vendorCode || '').trim();
      if (!key) {
        const input = String(it.vendor || '').trim();
        if (input) {
          const v = (window.__vendorsCache || []).find(vv => (vv.code || '').trim().toLowerCase() === input.toLowerCase() || (vv.name || '').trim().toLowerCase() === input.toLowerCase())
            || (window.__vendorsCache || []).find(vv => (vv.code || '').replace(/\s+/g, '').toLowerCase() === input.replace(/\s+/g, '').toLowerCase());
          key = String((v && v.code) || input).trim();
        }
      }
      if (!key) return;
      bucket[key] = (bucket[key] || 0) + Number(it.price || 0);
    });
  });
  const wrap = $('#vendorSubtotals');
  wrap.innerHTML = '';
  const codes = Object.keys(bucket).sort();
  if (!codes.length) { wrap.innerHTML = '<div class="text-muted">No vendor subtotals for current filter.</div>'; return; }
  codes.forEach(c => {
    const col = document.createElement('div');
    col.className = 'col-6 col-md-4 col-lg-3';
    col.innerHTML = `
      <div class="border rounded p-2">
        <div class="text-muted small">Vendor</div>
        <div class="fw-semibold">${esc(c)}</div>
        <div class="text-end">$${money(bucket[c])}</div>
      </div>`;
    wrap.appendChild(col);
  });
  // Total of all vendors in current filter
  const total = codes.reduce((sum, c) => sum + Number(bucket[c] || 0), 0);
  const totalEl = document.getElementById('vendorSubtotalsTotal');
  if (totalEl) totalEl.textContent = `Total (Current Filter): $${money(total)}`;
}

// ---------- table with inline handlers ----------
function renderTable() {
  const tbody = document.querySelector('#receiptsTable');
  tbody.innerHTML = '';
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageRows = filtered.slice(start, end);

  const countEl = document.getElementById('countLabel');
  if (countEl) countEl.textContent = `${total} receipt${total === 1 ? '' : 's'} • Page ${currentPage} of ${totalPages}`;
  const pageInfo = document.getElementById('pageInfo');
  if (pageInfo) pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  const prevBtn = document.getElementById('prevPageBtn');
  const nextBtn = document.getElementById('nextPageBtn');
  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;

  pageRows.forEach(r => {
    const rawId = String(r.id || r.number || '').trim();
    const comments = (r.items || []).map(i => (i.comment || '').trim()).filter(Boolean);
    const commentPreview = comments.length
      ? (comments.length > 2
        ? comments.slice(0, 2).join('; ') + '…'
        : comments.join('; '))
      : '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.datetime ? new Date(r.datetime).toLocaleString() : ''}</td>
      <td>
        ${esc(r.number || r.id || '')}
        ${r.voided ? `<div class="text-danger small">VOIDED ${r.voidInfo?.when ? '(' + new Date(r.voidInfo.when).toLocaleString() + ')' : ''}</div>` : ''}
        ${commentPreview ? `<div class="text-muted small">Notes: ${esc(commentPreview)}</div>` : ''}
      </td>
      <td>${esc(r.cashier || '')}</td>
      <td>${esc(r.payment || '')}</td>
      <td class="text-end">$${money(r.subtotal)}</td>
      <td class="text-end">$${money(r.tax)}</td>
      <td class="text-end fw-semibold">$${money(r.total)}</td>
      <td>
        <div class="btn-group btn-group-sm">
          <button type="button" class="btn btn-outline-primary"
                  onclick="window.__onReceiptAction(event,'view','${rawId}')">View</button>
          <button type="button" class="btn btn-outline-primary"
                  onclick="window.__onReceiptAction(event,'print','${rawId}')">Print</button>
          ${r.voided
        ? `<button type="button" class="btn btn-outline-dark" disabled>Voided</button>`
        : `<button type="button" class="btn btn-outline-danger"
                         onclick="window.__onReceiptAction(event,'void','${rawId}')">Void</button>`
      }
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------- view/print window (shows VOID banner + reason/by/when) ----------
async function openReceiptWindow(r, opts = {}) {
  const autoPrint = !!opts.autoPrint;
  const vendors = await ipcRenderer.invoke('vendors:load');
  const norm = s => String(s || '').trim().toLowerCase();
  const resolveCode = (item) => {
    if (item.vendorCode) return item.vendorCode;
    const input = item.vendor || '';
    if (!input) return '';
    let v = vendors.find(vv => norm(vv.name) === norm(input) || norm(vv.code) === norm(input));
    if (v) return v.code || '';
    v = vendors.find(vv => norm(vv.code).replace(/\s+/g, '') === norm(input).replace(/\s+/g, ''));
    return v?.code || '';
  };

  const style = `
  <style>
    :root{--accent:#2b2b2b;--muted:#6c757d;--border:#e5e7eb;--bold:#111827;--danger:#dc3545;}
    .rcpt{width:320px;margin:0 auto;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--bold);font-size:12px;line-height:1.35;}
    .rcpt hr{border:0;border-top:1px dashed var(--border);margin:10px 0;}
    .rcpt .center{text-align:center}.rcpt .muted{color:var(--muted)}
    .rcpt .hd{display:flex;align-items:center;gap:10px;margin-bottom:6px}
    .rcpt .brand{font-weight:700;font-size:13px;letter-spacing:.3px}
    .rcpt .addr{font-size:11px}
    .rcpt .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;margin-top:8px}
    .rcpt .meta div span{color:var(--muted)}
    .rcpt table{width:100%;border-collapse:collapse}
    .rcpt th,.rcpt td{padding:6px 0}
    .rcpt th{text-align:left;color:var(--muted);font-weight:600;font-size:11px;border-bottom:1px solid var(--border)}
    .rcpt td.price,.rcpt th.price{text-align:right}
    .rcpt td.vendor{color:var(--muted);font-size:11px}
    .rcpt .totals .row{display:flex;justify-content:space-between;padding:2px 0}
    .rcpt .totals .row.total{font-weight:700;font-size:13px}
    .rcpt .foot{margin-top:10px;font-size:11px}
    .void-banner{background:var(--danger);color:#fff;text-align:center;font-weight:800;padding:4px 6px;margin:6px 0;border-radius:4px;letter-spacing:.5px}
    .void-meta{grid-column:1 / -1; color:var(--danger); font-weight:700;}
    .void-reason{grid-column:1 / -1;}
  </style>`;


  const vendorTotals = {};
  const rows = (r.items || []).map(it => {
    const { finalPrice, original, discountAmount, reason, type, value } = deriveDiscount(it);
    const hasDiscount = discountAmount > 0;
    const discountSuffix = hasDiscount ? buildDiscountSuffix(type, value, discountAmount, reason, esc) : '';
    const code = resolveCode(it);
    if (code) vendorTotals[code] = (vendorTotals[code] || 0) + finalPrice;
    return `
      <tr>
        <td>
          ${esc(it.name)}
          ${code ? `<div class="vendor">Vendor: ${esc(code)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="text-decoration:line-through;">Original: $${money(original)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="color:#dc3545;">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
        </td>
        <td class="price">$${money(finalPrice)}</td>
      </tr>`;
  }).join('');

  const codes = Object.keys(vendorTotals).sort();
  const vendorBlock = codes.length
    ? `
      <tr><td colspan="2"><hr></td></tr>
      <tr><td colspan="2"><strong>Vendor Subtotals</strong></td></tr>
      ${codes.map(c => `<tr><td class="vendor">• ${esc(c)}</td><td class="price">$${money(vendorTotals[c])}</td></tr>`).join('')}
    `
    : '';

  const voidBanner = r.voided ? `<div class="void-banner">VOIDED</div>` : '';
  const voidMeta = r.voided
    ? `
      <div class="void-meta">VOIDED</div>
      <div class="void-reason"><span>Reason:</span> <strong>${esc(r.voidInfo?.reason || '')}</strong>
        ${r.voidInfo?.user ? ` — <span class="muted">by ${esc(r.voidInfo.user)}</span>` : ''}
        ${r.voidInfo?.when ? ` <span class="muted">on ${new Date(r.voidInfo.when).toLocaleString()}</span>` : ''}
      </div>
    `
    : '';

  const html = `
  <html>
    <head>
      <title>${esc(r.number || r.id || 'Receipt')}</title>
      <base href="${document.baseURI}">
      ${style}
      ${autoPrint ? '<script>window.addEventListener(\'load\',()=>{ window.print(); }); window.addEventListener(\'afterprint\',()=>{ window.close(); });<\/script>' : ''}
    </head>
    <body>
    <div class="rcpt">
      ${voidBanner}
      <div class="hd">
        <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="40" height="40">
        <div>
          <div class="brand">Middleton’s Antiques &amp; Uniques</div>
          <div class="addr muted">123 Antique Row, Lincoln, NE • (402) 555-1212</div>
        </div>
      </div>

      <div class="meta">
        <div><span>Receipt #:</span> <strong>${esc(r.number || r.id)}</strong></div>
        <div><span>Date:</span> <strong>${r.datetime ? new Date(r.datetime).toLocaleString() : ''}</strong></div>
        <div><span>Cashier:</span> <strong>${esc(r.cashier || '—')}</strong></div>
        <div><span>Payment:</span> <strong>${esc(r.payment || '—')}</strong></div>
        ${voidMeta}
      </div>

      <hr>

      <table>
        <thead><tr><th>Item</th><th class="price">Price</th></tr></thead>
        <tbody>
          ${rows}
          ${vendorBlock}
        </tbody>
      </table>

      <div class="totals">
        <hr>
        <div class="row"><div>Subtotal</div><div>$${money(r.subtotal)}</div></div>
        <div class="row"><div>Tax (${(Number(r.taxRate || 0) * 100).toFixed(2)}%)</div><div>$${money(r.tax)}</div></div>
        <div class="row total"><div>Total</div><div>$${money(r.total)}</div></div>
      </div>

      <div class="foot center">
        <hr>
        <div class="muted">Returns within 7 days with receipt. Thank you for shopping small!</div>
      </div>
    </div>
    </body>
  </html>`;

  const w = window.open('', '', 'width=420,height=700');
  w.document.write(html);
  w.document.close();
  return w;
}

// ---------- CSV export ----------
function toCSV(rows) {
  const header = ['Number', 'DateTime', 'Cashier', 'Payment', 'Subtotal', 'Tax', 'Total', 'Voided', 'VoidReason', 'Items', 'ItemComments'];
  const lines = [header.join(',')];
  rows.forEach(r => {
    const itemsText = (r.items || []).map(i => `${i.name} ($${money(i.price)}${i.vendorCode ? `, ${i.vendorCode}` : i.vendor ? `, ${i.vendor}` : ''})`).join('; ');
    const commentsText = (r.items || []).map(i => (i.comment || '').trim()).filter(Boolean).join('; ');
    const line = [
      r.number || r.id || '',
      r.datetime || '',
      r.cashier || '',
      r.payment || '',
      money(r.subtotal),
      money(r.tax),
      money(r.total),
      r.voided ? 'YES' : 'NO',
      r.voidInfo?.reason || '',
      itemsText.replaceAll(',', ';'),
      commentsText.replaceAll(',', ';')
    ].map(v => `"${String(v).replaceAll('"', '""')}"`).join(',');
    lines.push(line);
  });
  return lines.join('\r\n');
}
function exportCSV() {
  const csv = toCSV(filtered);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `receipts_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}

// ---------- Void modal helpers (cashier OBJECT + reason) ----------
let __voidModal, __resolveVoid;

async function getCashiersList() {
  // Actual json objects from disk
  let list = await ipcRenderer.invoke('cashiers:load');
  if (!Array.isArray(list)) list = [];
  if (list.length === 0) list = [{ name: 'Manager' }];
  return list;
}

async function populateVoidCashiers() {
  const sel = document.getElementById('voidCashierSelect');
  if (!sel) return;
  sel.innerHTML = '';

  const cashiers = await getCashiersList();
  cashiers.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    opt.dataset.cashier = JSON.stringify(c); // stash full object for confirm
    opt.dataset.index = String(idx);
    sel.appendChild(opt);
  });

  const currentFilter = (document.getElementById('cashierFilter')?.value || '').trim();
  if (currentFilter) sel.value = currentFilter;
}

function setupVoidModal() {
  const el = document.getElementById('voidModal');
  if (!el) return;
  __voidModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });

  const confirmBtn = document.getElementById('voidConfirmBtn');
  const cancelBtn = document.getElementById('voidCancelBtn');
  const closeX = document.getElementById('voidCloseX');
  const input = document.getElementById('voidReasonInput');
  const sel = document.getElementById('voidCashierSelect');

  const finish = (val) => {
    if (__resolveVoid) __resolveVoid(val);
    __resolveVoid = null;
    try { __voidModal.hide(); } catch (_) { }
  };

  confirmBtn.onclick = () => {
    const reason = (input.value || '').trim();
    const opt = sel.options[sel.selectedIndex];
    let cashierObj = null;
    try { cashierObj = opt?.dataset?.cashier ? JSON.parse(opt.dataset.cashier) : null; } catch (_) { }
    const user = (cashierObj?.name || sel.value || 'Manager').trim();
    finish({ reason, user, cashier: cashierObj });
  };
  cancelBtn.onclick = () => finish(null);
  if (closeX) closeX.onclick = () => finish(null);

  el.addEventListener('shown.bs.modal', async () => {
    await populateVoidCashiers();
    input.value = '';
    input.focus();
  });
}

function askVoidInfo() {
  if (!__voidModal) setupVoidModal();
  return new Promise(res => {
    __resolveVoid = res;
    __voidModal.show();
  });
}

// ---------- Inline button action handler ----------
window.__onReceiptAction = async function __onReceiptAction(e, action, id) {
  try {
    if (!id) return;

    if (action === 'view') {
      const r = await ipcRenderer.invoke('receipts:get', id);
      if (!r) return alert(`Receipt not found for id: ${id}`);
      await openReceiptWindow(r, { autoPrint: false });
      return;
    }

    if (action === 'print') {
      const r = await ipcRenderer.invoke('receipts:get', id);
      if (!r) return alert(`Receipt not found for id: ${id}`);
      const w = await openReceiptWindow(r, { autoPrint: true });
      try { w.focus(); } catch (_) { }
      return;
    }

    if (action === 'void') {
      const btn = e.currentTarget || e.target;
      const info = await askVoidInfo();
      if (info === null) return; // cancelled
      const { reason, user, cashier } = info;

      if (btn && btn.tagName === 'BUTTON') {
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = 'Voiding…';
        try {
          const resp = await ipcRenderer.invoke('receipts:void', { id, reason, user, userObj: cashier });
          if (!resp) {
            alert(`Unable to void receipt. ID sent: ${id}\nTip: click "Reindex IDs" and try again.`);
            btn.disabled = false; btn.textContent = prev;
            return;
          }
          await loadAll();
          applyFilters();
        } catch (err) {
          alert('Error voiding receipt: ' + (err?.message || err));
          btn.disabled = false; btn.textContent = prev;
        }
      } else {
        const resp = await ipcRenderer.invoke('receipts:void', { id, reason, user, userObj: cashier });
        if (!resp) return alert(`Unable to void receipt. ID sent: ${id}`);
        await loadAll(); applyFilters();
      }
      return;
    }

  } catch (err) {
    console.error('Action error:', err);
    alert('Unexpected error: ' + (err?.message || err));
  }
};

// ---------- init ----------
window.addEventListener('load', async () => {
  try { window.__vendorsCache = await ipcRenderer.invoke('vendors:load'); } catch (_) { window.__vendorsCache = []; }
  await loadAll();
  await populateCashiersFilter();
  applyFilters();

  $('#applyBtn').addEventListener('click', applyFilters);
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') applyFilters(); });
  $('#exportBtn').addEventListener('click', exportCSV);
  $('#voidFilter').addEventListener('change', applyFilters);
  $('#reindexBtn').addEventListener('click', async () => {
    const res = await ipcRenderer.invoke('receipts:reindex');
    alert(res.changed ? `Reindexed ${res.count} receipts.` : 'No changes needed.');
    await loadAll(); applyFilters();
  });

  // Hide/show Reindex button based on Developer Mode
  try {
    const s = await ipcRenderer.invoke('settings:load');
    const dev = !!s?.developerMode;
    const btn = document.getElementById('reindexBtn');
    if (btn) btn.style.display = dev ? '' : 'none';
  } catch (_) { }

  try {
    ipcRenderer.on('settings:changed', (_evt, payload) => {
      const dev = !!payload?.developerMode;
      const btn = document.getElementById('reindexBtn');
      if (btn) btn.style.display = dev ? '' : 'none';
    });
  } catch (_) { }

  // Quick filters: Today / Yesterday
  const todayBtn = document.getElementById('todayBtn');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    const now = new Date();
    const ymd = toDateInputValue(now);
    const from = document.getElementById('fromDate');
    const to = document.getElementById('toDate');
    if (from) from.value = ymd;
    if (to) to.value = ymd;
    applyFilters();
  });
  const yesterdayBtn = document.getElementById('yesterdayBtn');
  if (yesterdayBtn) yesterdayBtn.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const ymd = toDateInputValue(d);
    const from = document.getElementById('fromDate');
    const to = document.getElementById('toDate');
    if (from) from.value = ymd;
    if (to) to.value = ymd;
    applyFilters();
  });

  // Pagination wiring
  const sizeSel = document.getElementById('pageSizeSelect');
  if (sizeSel) {
    sizeSel.addEventListener('change', () => {
      const v = parseInt(sizeSel.value, 10);
      pageSize = isNaN(v) || v <= 0 ? 10 : v;
      currentPage = 1;
      renderTable();
    });
    // Default to 10
    const v = parseInt(sizeSel.value, 10);
    pageSize = isNaN(v) || v <= 0 ? 10 : v;
  }
  const prevBtn = document.getElementById('prevPageBtn');
  const nextBtn = document.getElementById('nextPageBtn');
  if (prevBtn) prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderTable(); } });
  if (nextBtn) nextBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    if (currentPage < totalPages) { currentPage++; renderTable(); }
  });

  // Clear filters
  const clearBtn = document.getElementById('clearBtn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    const q = document.getElementById('q');
    const from = document.getElementById('fromDate');
    const to = document.getElementById('toDate');
    const cashier = document.getElementById('cashierFilter');
    const payment = document.getElementById('paymentFilter');
    const voids = document.getElementById('voidFilter');
    if (q) q.value = '';
    if (from) from.value = '';
    if (to) to.value = '';
    if (cashier) cashier.value = '';
    if (payment) payment.value = '';
    if (voids) voids.value = 'hide';
    applyFilters();
  });

  // Debug button if present
  const dbg = document.getElementById('debugBtn');
  if (dbg) {
    dbg.addEventListener('click', async () => {
      const info = await ipcRenderer.invoke('debug:info');
      alert(
        `Receipts path:\n${info.receiptsPath}\n\n` +
        `Count: ${info.count}\n\n` +
        `Sample IDs:\n` +
        info.sampleIds.map(x => `id=${x.id} | number=${x.number}`).join('\n')
      );
    });
  }

  // Initialize the modal-based void prompt
  setupVoidModal();
});

// --- Override: view/print window as full-page Sales Invoice ---
async function openReceiptWindow(r, opts = {}) {
  const autoPrint = !!opts.autoPrint;
  const vendors = await ipcRenderer.invoke('vendors:load');
  const norm = s => String(s || '').trim().toLowerCase();
  const resolveCode = (item) => {
    if (item.vendorCode) return item.vendorCode;
    const input = item.vendor || '';
    if (!input) return '';
    let v = vendors.find(vv => norm(vv.name) === norm(input) || norm(vv.code) === norm(input));
    if (v) return v.code || '';
    v = vendors.find(vv => norm(vv.code).replace(/\s+/g, '') === norm(input).replace(/\s+/g, ''));
    return v?.code || '';
  };

  const style = `
  <style>
    @page { size: Letter portrait; margin: 0.5in; }
    :root{
      --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; --danger:#dc3545;
      --bg:#ffffff; --sheet:#ffffff; --screenbg:#f3f4f6;
    }
    html,body{height:100%}
    body{background:var(--screenbg); margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:var(--ink);}
    .invoice{max-width:8.5in; margin:0 auto;}
    /* extra bottom padding to avoid overlap with QR block */
    .sheet{position:relative; background:var(--sheet); margin:20px; padding:32px 40px 200px 40px; box-shadow:0 2px 10px rgba(0,0,0,.08);} 
    .bgmark{position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:70%; height:auto; opacity:.10; pointer-events:none; display:none;
      filter: blur(0.8px);
      -webkit-mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
              mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
      -webkit-mask-size: 100% 100%;
              mask-size: 100% 100%; }
    .actions{display:flex; justify-content:flex-end; margin-bottom:8px}
    .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
    .header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .brand-wrap{display:flex;gap:12px;align-items:center}
    .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
    .addr{color:var(--muted);font-size:12px;margin-top:2px}
    .title{font-size:22px;font-weight:800;letter-spacing:.5px;color:var(--emph);text-transform:uppercase}
    .meta{display:grid;grid-template-columns: repeat(2,minmax(180px,1fr)); gap:8px 16px; margin-top:12px}
    .meta .label{color:var(--muted)}
    .void-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .void-watermark span{transform:rotate(-25deg);font-size:120px;font-weight:900;color:rgba(220,53,69,.14);}

    table{width:100%;border-collapse:collapse;margin-top:16px}
    thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
    tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
    th.num, td.num{ text-align:right }
    .desc{font-weight:600}
    .vendor{color:var(--muted);font-size:11px}
    .totals{margin-top:12px;display:grid;grid-template-columns: 1fr auto;row-gap:6px}
    .totals .label{color:var(--muted)}
    .totals .val{min-width:120px;text-align:right}
    .totals .grand{font-weight:800;font-size:16px;color:var(--emph)}
    .notes{margin-top:16px;color:var(--muted);font-size:12px}
    .vendor-sub{margin-top:10px}
    .vendor-sub h4{margin:10px 0 4px 0;font-size:12px}
    .vendor-sub table td{border:none;padding:4px 8px}
    /* By default, QR sits after content (last page only). If single page, JS adds .qr-fixed to pin it to page bottom */
    .socialQR{position:static; display:flex; flex-direction:row-reverse; align-items:center; gap:10px; text-align:right; margin-top:12px}
    .socialQR img{width:90px; height:auto; border-radius:8px; border:1px solid var(--border)}
    .socialQR .msg{font-weight:700; font-size:12px; line-height:1.2}
    @media print { .qr-fixed{ position: fixed; right: 0.5in; bottom: 0.5in; } }

    @media print{
      body{background:#fff}
      .sheet{margin:0; box-shadow:none}
      .actions{display:none}
      .vendor-sub{display:none}
      .bgmark{position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:70%; height:auto; opacity:.10; pointer-events:none; display:block;
        filter: blur(0.8px);
        -webkit-mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
                mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
        -webkit-mask-size: 100% 100%;
                mask-size: 100% 100%; }
    }
  </style>`;

  const vendorTotals = {};
  const rows = (r.items || []).map((it, idx) => {
    const { finalPrice, original, discountAmount, reason, type, value } = deriveDiscount(it);
    const hasDiscount = discountAmount > 0;
    const discountSuffix = hasDiscount ? buildDiscountSuffix(type, value, discountAmount, reason, esc) : '';
    const code = resolveCode(it);
    if (code) vendorTotals[code] = (vendorTotals[code] || 0) + finalPrice;
    const qty = 1;
    const unit = finalPrice;
    const amount = qty * unit;
    return `
      <tr>
        <td class="num">${idx + 1}</td>
        <td>
          <div class="desc">${esc(it.name)}</div>
          ${it.comment ? `<div class="vendor">${esc(it.comment)}</div>` : ''}
          ${code ? `<div class="vendor">Vendor: ${esc(code)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="text-decoration:line-through;">Original: $${money(original)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="color:#dc3545;">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
        </td>
        <td class="num">${qty}</td>
        <td class="num">$${money(unit)}</td>
        <td class="num">$${money(amount)}</td>
      </tr>`;
  }).join('');

  const codes = Object.keys(vendorTotals).sort();
  const vendorBlock = codes.length
    ? `
      <div class="vendor-sub">
        <h4>Vendor Subtotals</h4>
        <table>
          <tbody>
            ${codes.map(c => `<tr><td class="vendor">• ${esc(c)}</td><td class="num">$${money(vendorTotals[c])}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const voidWatermark = r.voided ? `<div class="void-watermark"><span>VOID</span></div>` : '';
  const voidInline = r.voided
    ? `
        <div class="label">Voided</div>
        <div><strong>${esc(r.voidInfo?.reason || '')}</strong>
        ${r.voidInfo?.user ? ` • <span class="label">by ${esc(r.voidInfo.user)}</span>` : ''}
        ${r.voidInfo?.when ? ` <span class="label">on ${new Date(r.voidInfo.when).toLocaleString()}</span>` : ''}
        </div>`
    : '';

  const html = `
  <html>
  <head>
    <meta charset="utf-8" />
    <title>${esc(r.number || r.id || 'Invoice')}</title>
    <base href="${document.baseURI}">
    ${style}
    <script>
      // Decide if content fits on one page; if so, pin QR to page bottom.
      function adjustQrPosition(){
        try{
          var qr = document.querySelector('.socialQR');
          var sheet = document.querySelector('.sheet');
          if(!qr || !sheet) return;
          var prev = qr.style.display; qr.style.display = 'none';
          var contentH = sheet.scrollHeight; qr.style.display = prev;
          var printableH = 96 * 10; // 10in printable area (Letter 11in - 1in margins)
          if(contentH <= printableH){ qr.classList.add('qr-fixed'); } else { qr.classList.remove('qr-fixed'); }
        }catch(e){}
      }
      window.addEventListener('load', adjustQrPosition);
    </script>
    ${autoPrint ? `<script>
      window.addEventListener('load', function(){
        try {
          var imgs = Array.prototype.slice.call(document.images || []);
          var pending = imgs.filter(function(i){ return !i.complete; });
          if (pending.length === 0) { window.print(); return; }
          var left = pending.length;
          pending.forEach(function(img){ img.addEventListener('load', function(){ if(--left===0) window.print(); }, { once:true }); });
        } catch (e) { window.print(); }
      });
      window.addEventListener('afterprint', function(){ try { window.close(); } catch(_){} });
    </script>` : ''}
  </head>
  <body>
    <div class="invoice">
      <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
      <div class="sheet">
        <img class="bgmark" src="assets/MiddletonsStoreFrontLogoBW.png" alt="">
        ${voidWatermark}
        <div class="header">
          <div class="brand-wrap">
            <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="96" height="96" style="border-radius:12px" />
            <div>
              <div class="brand">Middleton's Antiques &amp; Uniques</div>
              <div class="addr">123 Antique Row, Lincoln, NE · (402) 555-1212</div>
            </div>
          </div>
          <div class="title">Sales Invoice</div>
        </div>

        <div class="meta">
          <div><div class="label">Invoice #</div><div><strong>${esc(r.number || r.id)}</strong></div></div>
          <div><div class="label">Date</div><div><strong>${r.datetime ? new Date(r.datetime).toLocaleString() : ''}</strong></div></div>
          <div><div class="label">Cashier</div><div><strong>${esc(r.cashier || '-')}</strong></div></div>
          <div><div class="label">Payment</div><div><strong>${esc(r.payment || '-')}</strong></div></div>
          ${voidInline}
        </div>

        <table>
          <thead>
            <tr>
              <th class="num" style="width:48px">#</th>
              <th>Description</th>
              <th class="num" style="width:64px">Qty</th>
              <th class="num" style="width:100px">Unit</th>
              <th class="num" style="width:110px">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan=5 class="label">No items</td></tr>`}
          </tbody>
        </table>

        ${vendorBlock}

        <div class="totals">
          <div class="label">Subtotal</div><div class="val">$${money(r.subtotal)}</div>
          <div class="label">Tax (${(Number(r.taxRate || 0) * 100).toFixed(2)}%)</div><div class="val">$${money(r.tax)}</div>
          <div class="label grand">Total</div><div class="val grand">$${money(r.total)}</div>
        </div>

        <div class="notes">
          Thank you for shopping small!
        </div>

        <div class="socialQR">
          <img src="assets/url_qrcodecreator.com_09_16_06.png" alt="Facebook QR code">
          <div class="msg">Visit us on Facebook!! Like, Follow, Share</div>
        </div>
      </div>
    </div>
  </body>
  </html>`;

  const w = window.open('', '', 'width=960,height=900');
  w.document.write(html);
  try {
    const setAddr = () => {
      const txt = '1615 S 17th St, Lincoln, NE 68502 · 531-500-0135';
      const nodes = w.document.querySelectorAll('.addr, .addr.muted, #rcpt-address');
      nodes.forEach(n => n.textContent = txt);
    };
    setAddr();
  } catch (_) { }
  w.document.close();
  return w;
}



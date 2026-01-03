// receipts.js
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


let __suppressUnloadPrompt = false;
function markInternalNavigation(event) {
  try {
    const anchor = event?.target?.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) __suppressUnloadPrompt = true;
  } catch (_) { }
}
function shouldConfirmClose() {
  return !__suppressUnloadPrompt;
}
try { document.addEventListener('click', markInternalNavigation, true); } catch (_) { }


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

function confirmLogoutOnClose() {
  try {
    window.addEventListener('beforeunload', (event) => {
      if (!shouldConfirmClose()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('unload', () => { requestLogoutOnClose(); });
  } catch (_) { }
}
confirmLogoutOnClose();

const canEditReceipts = !!api;

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

let all = [];
let filtered = [];
let currentPage = 1;
let pageSize = 10;
let selectedVendorKey = '';
// Branding for receipts/reports views (name/address/phone/logo)
let branding = {
  bizName: "Middleton's Antiques & Uniques",
  bizAddress: '1615 S 17th St, Lincoln, NE 68502',
  bizPhone: '531-500-0135',
  logoPath: ''
};
let __greyscalePrint = false;
let GIFT_CARD_SURCHARGE_RATE = 0.03;
function getGreyscalePrintCss() {
  return __greyscalePrint ? '@media print { html{ filter: grayscale(100%); } }' : '';
}
function getBrandingName() {
  return String(branding?.bizName || "Middleton's Antiques & Uniques");
}
function getBrandingAddressLine() {
  const addr = String(branding?.bizAddress || '').trim();
  const phone = String(branding?.bizPhone || '').trim();
  if (addr && phone) return `${addr} · ${phone}`;
  return addr || phone || '';
}
function getBrandingLogoSrc(defaultPath) {
  const src = String(branding?.logoPath || '').trim();
  return src || defaultPath;
}
function applyBrandingToReceiptsPage() {
  try {
    const name = getBrandingName();
    const navBrand = document.querySelector('.navbar-brand');
    if (navBrand) navBrand.textContent = name;
  } catch (_) { }
}
function applyBrandingToReceiptWindow(win) {
  try {
    if (!win || !win.document) return;
    const name = getBrandingName();
    const addrLine = getBrandingAddressLine();
    const logoSrc = getBrandingLogoSrc('assets/NEW_MiddletonsBW.PNG');
    try {
      const brandEl = win.document.querySelector('.brand-wrap .brand');
      if (brandEl) brandEl.textContent = name;
    } catch (_) { }
    try {
      const addrEl = win.document.querySelector('.brand-wrap .addr');
      if (addrEl) addrEl.textContent = addrLine || '';
    } catch (_) { }
    try {
      const imgs = win.document.querySelectorAll('img.bgmark, .brand-wrap img[alt="Logo"]');
      imgs.forEach(img => { try { img.src = logoSrc; } catch (_) { } });
    } catch (_) { }
  } catch (_) { }
}

// Basic DOM/query helpers shared across this module.
const $ = sel => document.querySelector(sel);
const norm = s => String(s || '').trim().toLowerCase();

// Format a number as money with two decimals.
function money(n) { return Number(n || 0).toFixed(2); }
function formatRatePct(rate) {
  const pct = Math.max(0, Number(rate || 0) * 100);
  return pct.toFixed(2).replace(/\.?0+$/, '');
}

// HTML-escape a string so it is safe to inject into templates.
function esc(s) { return String(s || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
// Lightweight toast notifier (mirrors main POS toasts) for bottom-right messages.
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
// Normalize any numeric-like input into a 2-decimal money number.
function toMoneyNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}
function getSplitTenderInfo(r) {
  if (!r || !r.splitTenderEnabled) return null;
  const total = toMoneyNumber(r.total || 0);
  const splitType = String(r.splitTenderType || '').trim();
  const payment = String(r.payment || '').trim();
  const splitReceived = toMoneyNumber(r.splitTenderAmount || 0);
  let splitAmount = splitReceived;
  let primaryAmount = Math.max(0, total - splitReceived);
  let cashReceived = 0;
  let changeDue = 0;
  if (splitType === 'Cash') {
    cashReceived = splitReceived;
    const applied = Math.min(splitReceived, total);
    if (payment === 'Gift Card') {
      const giftCardAmount = toMoneyNumber(r.giftCardAmount || 0);
      primaryAmount = Math.min(total, giftCardAmount);
      splitAmount = Math.max(0, total - primaryAmount);
      changeDue = Math.max(0, cashReceived - splitAmount);
    } else {
      splitAmount = Math.max(0, applied);
      primaryAmount = Math.max(0, total - splitAmount);
      changeDue = Math.max(0, cashReceived - splitAmount);
    }
  }
  return {
    payment,
    splitType,
    primaryAmount,
    splitAmount,
    total,
    cashReceived,
    changeDue,
    isCashSplit: splitType === 'Cash'
  };
}
function getGiftCardInfo(r) {
  if (!r) return null;
  const number = String(r.giftCardNumber || '').trim();
  const balance = toMoneyNumber(r.giftCardBalance || 0);
  if (!number && balance === 0) return null;
  return { number, balance };
}
function isGiftCardSaleItem(it) {
  const name = String(it?.name || '').toLowerCase();
  return name.includes('gift card') || name.includes('giftcard');
}
function getGiftCardSaleTotal(r) {
  return (Array.isArray(r?.items) ? r.items : []).reduce((sum, it) => {
    if (!isGiftCardSaleItem(it)) return sum;
    const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
    const unit = toMoneyNumber(it.price || 0);
    return sum + toMoneyNumber(unit * qty);
  }, 0);
}
function getReceiptItemsSubtotal(r) {
  return (Array.isArray(r?.items) ? r.items : []).reduce((sum, it) => {
    const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
    const unit = toMoneyNumber(it.price || 0);
    return sum + toMoneyNumber(unit * qty);
  }, 0);
}
function buildReturnQtyByKey(r) {
  const map = {};
  if (!r?.returned || !r.returnInfo || !Array.isArray(r.returnInfo.items)) return map;
  r.returnInfo.items.forEach(it => {
    const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
    const price = Number(it.price || 0).toFixed(2);
    const key = [
      String(it.name || '').trim().toLowerCase(),
      price,
      String(it.vendorCode || it.vendor || '').trim().toLowerCase()
    ].join('|');
    map[key] = (map[key] || 0) + qty;
  });
  return map;
}
function getReturnTotal(r) {
  if (!r?.returned || !r.returnInfo || !Array.isArray(r.returnInfo.items)) return 0;
  let returnSubtotal = 0;
  r.returnInfo.items.forEach(it => {
    const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
    const price = Number(it.price || 0);
    returnSubtotal += qty * price;
  });
  const taxRate = Number(r.taxRate || 0);
  const returnTax = r.taxExempt ? 0 : toMoneyNumber(returnSubtotal * taxRate);
  return toMoneyNumber(returnSubtotal + returnTax);
}
function isCardTenderSelected(payment, splitEnabled, splitType) {
  const main = String(payment || '');
  const split = String(splitType || '');
  return main === 'Card' || (splitEnabled && split === 'Card');
}
function getCardFeeFromReceipt(r) {
  if (!r) return 0;
  const splitEnabled = !!r.splitTenderEnabled;
  const splitType = String(r.splitTenderType || '');
  const giftCardSaleTotal = getGiftCardSaleTotal(r);
  const payment = String(r.payment || '');
  const cardTenderUsed = isCardTenderSelected(payment, splitEnabled, splitType);
  if (!cardTenderUsed || giftCardSaleTotal <= 0) return 0;
  if (splitEnabled && payment !== 'Card') {
    const splitAmount = toMoneyNumber(r.splitTenderAmount || 0);
    const subtotal = (r?.subtotal !== undefined && r?.subtotal !== null)
      ? toMoneyNumber(r.subtotal)
      : getReceiptItemsSubtotal(r);
    const tax = toMoneyNumber(r.tax || 0);
    const baseTotal = toMoneyNumber(subtotal + tax);
    const primaryAmount = Math.max(0, baseTotal - splitAmount);
    if (primaryAmount + 0.009 >= giftCardSaleTotal) return 0;
  }
  return toMoneyNumber(giftCardSaleTotal * GIFT_CARD_SURCHARGE_RATE);
}
// Derive the original (pre-discount) price for an item.
function deriveOriginalPrice(it) {
  if (typeof it?.originalPrice === 'number' && !Number.isNaN(it.originalPrice)) {
    return toMoneyNumber(it.originalPrice);
  }
  const price = toMoneyNumber(it?.price || 0);
  const discount = toMoneyNumber(it?.discountAmount || 0);
  return toMoneyNumber(price + discount);
}
// Compute final price, discount value, type, and reason for an item.
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
// Turn a numeric percent value into a compact string (e.g., "7.25").
function formatPercentText(value) {
  const pct = toMoneyNumber(value);
  if (pct <= 0) return '';
  const isWhole = Math.abs(pct - Math.round(pct)) < 0.01;
  const str = isWhole ? String(Math.round(pct)) : pct.toFixed(2).replace(/\.?0+$/, '');
  return `${str}%`;
}
// Build a human-readable label for a discount (percent or fixed amount).
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
// Combine discount reason + label into a suffix like "Damaged, 10% off".
function buildDiscountSuffix(type, value, amount, reason, escapeFn = s => s) {
  const parts = [];
  const trimmed = String(reason || '').trim();
  if (trimmed) parts.push(escapeFn(trimmed));
  const label = formatDiscountLabel(type, value, amount);
  if (label) parts.push(escapeFn(label));
  return parts.length ? ` (${parts.join(', ')})` : '';
}
// Convert a Date to yyyy-mm-dd for <input type="date">.
function toDateInputValue(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------- load & filters ----------
// Load all receipts from disk (via main process) and keep them sorted.
async function loadAll() {
  const list = await invoke('receipts:load');
  all = Array.isArray(list) ? list : [];
  all.sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}
// Build cashier filter options from the loaded receipts.
async function populateCashiersFilter() {
  const sel = $('#cashierFilter');
  sel.innerHTML = '<option value="">All</option>';
  const names = Array.from(new Set(all.map(r => r.cashier).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  names.forEach(n => { const opt = document.createElement('option'); opt.value = n; opt.textContent = n; sel.appendChild(opt); });
}

// Apply all active filters (search, date range, cashier, payment, vendor) and re-render.
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

    if (selectedVendorKey) {
      const keyNorm = selectedVendorKey.toLowerCase();
      const matchesVendor = (r.items || []).some(it => {
        const k = resolveVendorKeyFromItem(it);
        return k && k.toLowerCase() === keyNorm;
      });
      if (!matchesVendor) return false;
    }

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
  renderGiftCardSummary();
}

// ---------- vendor subtotals ----------
// Choose a stable vendor key for an item (prefer vendor code, fallback to name / input).
function resolveVendorKeyFromItem(it) {
  let key = String(it.vendorCode || '').trim();
  if (!key) {
    const input = String(it.vendor || '').trim();
    if (input) {
      const vendors = (window.__vendorsCache || []);
      const match = vendors.find(vv => (vv.code || '').trim().toLowerCase() === input.toLowerCase() || (vv.name || '').trim().toLowerCase() === input.toLowerCase())
        || vendors.find(vv => (vv.code || '').replace(/\s+/g, '').toLowerCase() === input.replace(/\s+/g, '').toLowerCase());
      key = String((match && match.code) || input).trim();
    }
  }
  return key;
}
// Aggregate current filtered receipts into vendor subtotal cards.
function renderVendorSubtotals() {
  const bucket = {}; // by resolved vendor (code preferred, fallback to name)
  filtered.forEach(r => {
    if (r.voided) return;
    (r.items || []).forEach(it => {
      const key = resolveVendorKeyFromItem(it);
      if (!key) return;
      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const unit = toMoneyNumber(it.price || 0);
      const amount = toMoneyNumber(unit * qty);
      bucket[key] = (bucket[key] || 0) + Number(amount || 0);
    });
  });
  const wrap = $('#vendorSubtotals');
  wrap.innerHTML = '';
  const codes = Object.keys(bucket).sort();
  // Always clear the running total before possibly early-returning
  const totalEl = document.getElementById('vendorSubtotalsTotal');
  if (totalEl) totalEl.textContent = '';
  if (!codes.length) { wrap.innerHTML = '<div class="text-muted">No vendor subtotals for current filter.</div>'; return; }
  codes.forEach(c => {
    const col = document.createElement('div');
    col.className = 'col-6 col-md-4 col-lg-3';
    const isSelected = selectedVendorKey && selectedVendorKey.toLowerCase() === String(c).trim().toLowerCase();
    col.innerHTML = `
      <button type="button" class="border rounded p-2 w-100 text-start ${isSelected ? 'bg-primary text-white' : ''}" data-vendor-key="${esc(c)}">
        <div class="text-muted small">Vendor</div>
        <div class="fw-semibold">${esc(c)}</div>
        <div class="text-end">$${money(bucket[c])}</div>
      </button>`;
    wrap.appendChild(col);
  });
  // Wire click handlers for vendor filter selection
  wrap.querySelectorAll('button[data-vendor-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = String(btn.getAttribute('data-vendor-key') || '').trim();
      if (!key) return;
      if (selectedVendorKey && selectedVendorKey.toLowerCase() === key.toLowerCase()) {
        selectedVendorKey = '';
      } else {
        selectedVendorKey = key;
      }
      applyFilters();
    });
  });
  // Total of all vendors in current filter
  const total = codes.reduce((sum, c) => sum + Number(bucket[c] || 0), 0);
  if (totalEl) totalEl.textContent = `Total (Current Filter): $${money(total)}`;
}
function renderGiftCardSummary() {
  const salesEl = document.getElementById('giftCardSalesTotal');
  const redeemEl = document.getElementById('giftCardRedemptionTotal');
  if (!salesEl || !redeemEl) return;
  let giftSales = 0;
  let giftRedeem = 0;
  filtered.forEach(r => {
    if (r.voided) return;
    const returnQtyByKey = buildReturnQtyByKey(r);
    (r.items || []).forEach(it => {
      if (!isGiftCardSaleItem(it)) return;
      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const unit = Number(it.price || 0);
      const key = [
        String(it.name || '').trim().toLowerCase(),
        unit.toFixed(2),
        String(it.vendorCode || it.vendor || '').trim().toLowerCase()
      ].join('|');
      const returnedQty = returnQtyByKey[key] || 0;
      const keepQty = Math.max(0, qty - returnedQty);
      if (keepQty <= 0) return;
      giftSales += toMoneyNumber(unit * keepQty);
    });

    if (String(r.payment || '').trim() === 'Gift Card') {
      const base = toMoneyNumber(r.giftCardAmount || 0) || toMoneyNumber(r.total || 0);
      const netTotal = toMoneyNumber((r.total || 0) - getReturnTotal(r));
      const applied = netTotal > 0 ? Math.min(base, netTotal) : 0;
      giftRedeem += applied;
    }
  });
  salesEl.textContent = `$${money(giftSales)}`;
  redeemEl.textContent = `$${money(giftRedeem)}`;
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
  // Reflect disabled state on Bootstrap pagination list items for styling
  try {
    const prevLi = prevBtn ? prevBtn.closest('li.page-item') : null;
    const nextLi = nextBtn ? nextBtn.closest('li.page-item') : null;
    if (prevLi && prevBtn) prevLi.classList.toggle('disabled', !!prevBtn.disabled);
    if (nextLi && nextBtn) nextLi.classList.toggle('disabled', !!nextBtn.disabled);
  } catch (_) { }

  let html = '';
  for (const r of pageRows) {
    const rawId = String(r.id || r.number || '').trim();
    const comments = (r.items || []).map(i => (i.comment || '').trim()).filter(Boolean);
    const commentPreview = comments.length
      ? (comments.length > 2 ? comments.slice(0, 2).join('; ') + '…' : comments.join('; '))
      : '';
    let netTotal = toMoneyNumber(r.total || 0);
    if (r.returned && r.returnInfo && Array.isArray(r.returnInfo.items)) {
      let returnSubtotal = 0;
      r.returnInfo.items.forEach(it => {
        const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
        const price = toMoneyNumber(it.price || 0);
        const amount = qty * price;
        returnSubtotal += amount;
      });
      const taxRate = Number(r.taxRate || 0);
      const returnTax = r.taxExempt ? 0 : toMoneyNumber(returnSubtotal * taxRate);
      const returnTotal = toMoneyNumber(returnSubtotal + returnTax);
      const originalTotal = toMoneyNumber(r.total || 0);
      netTotal = toMoneyNumber(originalTotal - returnTotal);
    }
    const returnBadge = r.returned
      ? `<div class="text-success small">RETURNED${r.returnInfo?.reason ? `: ${esc(r.returnInfo.reason)}` : ''}${r.returnInfo?.user ? ` by ${esc(r.returnInfo.user)}` : ''}${r.returnInfo?.when ? ` on ${new Date(r.returnInfo.when).toLocaleString()}` : ''}</div>`
      : '';
    const returnButton = !canEditReceipts
      ? ''
      : r.returned
        ? `<button type="button" class="btn btn-outline-success" onclick="window.__onReceiptAction(event,'return','${rawId}')">Edit Return</button>`
        : r.voided
          ? `<button type="button" class="btn btn-outline-secondary" disabled>Return</button>`
          : `<button type="button" class="btn btn-outline-success" onclick="window.__onReceiptAction(event,'return','${rawId}')">Return</button>`;
    const splitInfo = getSplitTenderInfo(r);
    const splitExtra = splitInfo?.isCashSplit
      ? ` · Cash Received $${money(splitInfo.cashReceived)}${splitInfo.changeDue > 0 ? ` · Change $${money(splitInfo.changeDue)}` : ''}`
      : '';
    const splitLine = splitInfo
      ? `<div class="text-muted small">Split: ${esc(splitInfo.payment || 'Tender 1')} $${money(splitInfo.primaryAmount)} · ${esc(splitInfo.splitType || 'Tender 2')} $${money(splitInfo.splitAmount)} (Total $${money(splitInfo.total)})${splitExtra}</div>`
      : '';
    const giftInfo = getGiftCardInfo(r);
    const giftLine = giftInfo
      ? `<div class="text-muted small">Gift Card: ${giftInfo.number ? esc(giftInfo.number) : '—'} · Remaining $${money(giftInfo.balance)}</div>`
      : '';
    html += `
      <tr>
        <td>${r.displayDate ? esc(r.displayDate) : (r.datetime ? new Date(r.datetime).toLocaleString() : '')}</td>
        <td>
          ${esc(r.number || r.id || '')}
          ${r.voided ? `<div class="text-danger small">VOIDED ${r.voidInfo?.when ? '(' + new Date(r.voidInfo.when).toLocaleString() + ')' : ''}</div>` : ''}
          ${returnBadge}
          ${commentPreview ? `<div class="text-muted small">Notes: ${esc(commentPreview)}</div>` : ''}
        </td>
        <td>${esc(r.cashier || '')}</td>
        <td>
          ${esc(r.payment || '')}
          ${splitLine}
          ${giftLine}
        </td>
        <td class="text-end">$${money(r.subtotal)}</td>
        <td class="text-end">$${money(r.tax)}</td>
        <td class="text-end fw-semibold">$${money(r.total)}</td>
        <td class="text-end fw-semibold">$${money(netTotal)}</td>
        <td>
          <div class="btn-group btn-group-sm">
            <button type="button" class="btn btn-outline-primary" onclick="window.__onReceiptAction(event,'view','${rawId}')">View</button>
            <button type="button" class="btn btn-outline-primary" onclick="window.__onReceiptAction(event,'print','${rawId}')">Print</button>
            ${returnButton}
              ${!canEditReceipts
          ? ''
          : r.voided
            ? `<button type="button" class="btn btn-outline-dark" disabled>Voided</button>`
            : `<button type="button" class="btn btn-outline-danger" onclick="window.__onReceiptAction(event,'void','${rawId}')">Void</button>`}
          </div>
        </td>
      </tr>`;
  }
  tbody.innerHTML = html;
}

// ---------- view/print window (shows VOID/RETURN banners in a compact receipt layout) ----------
// Compact receipt window used from the Receipts page (different from the full invoice below).
async function openReceiptWindowCompact(r, opts = {}) {
  const autoPrint = !!opts.autoPrint;
  const vendors = (Array.isArray(window.__vendorsCache) && window.__vendorsCache.length)
    ? window.__vendorsCache
    : await invoke('vendors:load');
  try { if (!window.__vendorsCache || !window.__vendorsCache.length) window.__vendorsCache = vendors; } catch (_) { }
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
    .rcpt{width:320px;margin:0 auto;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--bold);font-size:12px;line-height:1.35;position:relative;}
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
    .price-line{line-height:1.3;}
    .price-line.strike{text-decoration:line-through;color:var(--muted);}
    .void-watermark,.return-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .void-watermark span{transform:rotate(-25deg);font-size:82px;font-weight:900;color:rgba(220,53,69,.14);}
    .return-watermark span{transform:rotate(-25deg);font-size:82px;font-weight:900;color:rgba(16,185,129,.14);}
    @media print{
      .void-watermark,.return-watermark{
        position: fixed !important;
        inset: 0 !important;
        align-items: center;
        justify-content: center;
      }
    }
    ${getGreyscalePrintCss()}
  </style>`;


  const vendorTotals = {};
  const returnQtyByKey = {};
  let returnSubtotal = 0;
  if (r.returned && r.returnInfo && Array.isArray(r.returnInfo.items)) {
    r.returnInfo.items.forEach(it => {
      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const price = toMoneyNumber(it.price || 0);
      const amount = qty * price;
      returnSubtotal += amount;
      const key = [
        String(it.name || '').trim().toLowerCase(),
        price.toFixed(2),
        String(it.vendor || it.vendorCode || '').trim().toLowerCase()
      ].join('|');
      returnQtyByKey[key] = (returnQtyByKey[key] || 0) + qty;
    });
  }
  const taxRate = Number(r.taxRate || 0);
  const returnTax = r.taxExempt ? 0 : toMoneyNumber(returnSubtotal * taxRate);
  const returnTotal = toMoneyNumber(returnSubtotal + returnTax);
  const netTotal = toMoneyNumber((r.total || 0) - returnTotal);
    const splitInfo = getSplitTenderInfo(r);
    const splitRows = splitInfo ? `
          <div class="row"><div>${esc(splitInfo.payment || 'Tender 1')}</div><div>$${money(splitInfo.primaryAmount)}</div></div>
          <div class="row"><div>${esc(splitInfo.splitType || 'Tender 2')}</div><div>$${money(splitInfo.splitAmount)}</div></div>
          ${splitInfo.isCashSplit ? `<div class="row"><div>Cash Received</div><div>$${money(splitInfo.cashReceived)}</div></div>` : ''}
          ${splitInfo.isCashSplit && splitInfo.changeDue > 0 ? `<div class="row"><div>Change Due</div><div>$${money(splitInfo.changeDue)}</div></div>` : ''}
          <div class="row"><div>Split Total</div><div>$${money(splitInfo.total)}</div></div>` : '';
    const giftInfo = getGiftCardInfo(r);
    const giftRows = giftInfo ? `
          <div class="row"><div>Gift Card #</div><div>${esc(giftInfo.number || '-')}</div></div>
          <div class="row"><div>Gift Card Balance</div><div>$${money(giftInfo.balance)}</div></div>` : '';
    const cardFee = getCardFeeFromReceipt(r);
    const cardFeeRow = cardFee > 0
      ? `<div class="row"><div>Card Fee (${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}%)</div><div>$${money(cardFee)}</div></div>`
      : '';

  const rows = (() => {
    const out = [];
    (r.items || []).forEach(it => {
      const { finalPrice, original, discountAmount, reason, type, value } = deriveDiscount(it);
      const hasDiscount = discountAmount > 0;
      const discountSuffix = hasDiscount ? buildDiscountSuffix(type, value, discountAmount, reason, esc) : '';
      const code = resolveCode(it);
      const soldQty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const unitPrice = toMoneyNumber(it.price || 0);
      const key = [
        String(it.name || '').trim().toLowerCase(),
        unitPrice.toFixed(2),
        String(code || it.vendor || '').trim().toLowerCase()
      ].join('|');
      const returnedQty = returnQtyByKey[key] || 0;
      const remainingQty = Math.max(0, soldQty - returnedQty);
      const fullyReturned = returnedQty >= soldQty && returnedQty > 0;
      const partiallyReturned = returnedQty > 0 && returnedQty < soldQty;
      const vendorContribution = toMoneyNumber(finalPrice * soldQty);
      const vendorReturnDeduction = toMoneyNumber(finalPrice * returnedQty);
      if (code) vendorTotals[code] = toMoneyNumber((vendorTotals[code] || 0) + vendorContribution - vendorReturnDeduction);
      const returnedNote = (fullyReturned || partiallyReturned) && r.returnInfo
        ? `<div class="vendor" style="color:#16a34a;">Returned ${returnedQty}${soldQty > 1 ? ` of ${soldQty}` : ''}${r.returnInfo.when ? ` on ${new Date(r.returnInfo.when).toLocaleDateString()}` : ''}${r.returnInfo.user ? ` by ${esc(r.returnInfo.user)}` : ''}</div>`
        : '';
      const discountBlock = `
          ${code ? `<div class="vendor">Vendor: ${esc(code)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="text-decoration:line-through;">Original: $${money(original)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="color:#dc3545;">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}`;

      const returnedTotal = toMoneyNumber(finalPrice * returnedQty);
      const remainingTotal = toMoneyNumber(finalPrice * remainingQty);
      const priceLines = [];
      if (returnedQty > 0) priceLines.push(`<div class="price-line strike">${returnedQty} @ $${money(finalPrice)} = -$${money(returnedTotal)}</div>`);
      if (remainingQty > 0) priceLines.push(`<div class="price-line">${remainingQty} @ $${money(finalPrice)} = $${money(remainingTotal)}</div>`);
      if (!priceLines.length) priceLines.push(`<div class="price-line">${soldQty} @ $${money(finalPrice)} = $${money(toMoneyNumber(finalPrice * soldQty))}</div>`);

      out.push(`
      <tr>
        <td>
          <span${returnedQty > 0 && remainingQty === 0 ? ' style="text-decoration:line-through;"' : ''}>${esc(it.name)}</span>
          ${discountBlock}
          ${returnedNote}
        </td>
        <td class="price">${priceLines.join('')}</td>
      </tr>`);
    });
    return out.join('');
  })();

  const codes = Object.keys(vendorTotals).sort();
  const vendorBlock = codes.length
    ? `
      <tr><td colspan="2"><hr></td></tr>
      <tr><td colspan="2"><strong>Vendor Subtotals</strong></td></tr>
      ${codes.map(c => `<tr><td class="vendor">- ${esc(c)}</td><td class="price">$${money(vendorTotals[c])}</td></tr>`).join('')}
    `
    : '';

  const voidBanner = r.voided ? `<div class="void-banner">VOIDED</div>` : '';
  const voidWatermark = r.voided ? `<div class="void-watermark"><span>VOID</span></div>` : '';
  const returnWatermark = (r.returned && !r.voided) ? `<div class="return-watermark"><span>RETURN</span></div>` : '';
  const voidMeta = r.voided
    ? `
      <div class="void-meta">VOIDED</div>
      <div class="void-reason"><span>Reason:</span> <strong>${esc(r.voidInfo?.reason || '')}</strong>
        ${r.voidInfo?.user ? ` - <span class="muted">by ${esc(r.voidInfo.user)}</span>` : ''}
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
      ${voidWatermark}
      ${returnWatermark}
      ${voidBanner}
      <div class="hd">
        <img src="assets/NEW_MiddletonsBW.PNG" alt="Logo" style="height:40px; width:auto;">
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
          <div class="row"><div>${r.taxExempt ? 'Tax (Exempt)' : `Tax (${(Number(r.taxRate || 0) * 100).toFixed(2)}%)`}</div><div>$${money(r.tax)}</div></div>
          ${cardFeeRow}
          <div class="row total"><div>Total</div><div>$${money(r.total)}</div></div>
        ${splitRows}
        ${giftRows}
        ${r.returned && returnTotal > 0 ? `
        <div class="row"><div>Return Subtotal</div><div>-$${money(returnSubtotal)}</div></div>
        <div class="row"><div>Return Tax</div><div>-$${money(returnTax)}</div></div>
        <div class="row total"><div>Return Total</div><div>-$${money(returnTotal)}</div></div>
        <div class="row total"><div>Net Total</div><div>$${money(netTotal)}</div></div>` : ''}
      </div>

      ${r.taxExempt ? `<div class="foot"><div><span class="muted">Exempt:</span> <strong>${esc(r.taxExemptName || '')}</strong> — ID: <strong>${esc(r.taxExemptId || '')}</strong></div></div>` : ''}

      <div class="foot center">
        <hr>
        <div class="muted">Thank you for shopping small!</div>
      </div>
    </div>
    </body>
  </html>`;

  const w = window.open('', '', 'width=420,height=700');
  w.document.write(html);
  try { applyBrandingToReceiptWindow(w); } catch (_) { }
  w.document.close();
  return w;
}

// Test-friendly exports (pure helpers only)
try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      money,
      esc,
      toMoneyNumber,
      deriveOriginalPrice,
      deriveDiscount,
      formatPercentText,
      formatDiscountLabel,
      buildDiscountSuffix,
      toDateInputValue,
      loadReturnReceipt,
      renderReturnItemsList,
      askReturnInfo,
      loadAll,
      applyFilters,
      updateReturnButtonState,
    };
  }
} catch (_) { }

// ---------- CSV export ----------
// Convert an array of receipt objects into a CSV string for export.
function toCSV(rows) {
  const header = [
    'Number', 'DateTime', 'DisplayDate', 'Cashier', 'Payment',
    'Subtotal', 'Tax', 'Total', 'TaxExempt', 'TaxExemptName', 'TaxExemptId',
    'Voided', 'VoidReason', 'Returned', 'ReturnReason', 'ReturnUser', 'ReturnWhen',
    'Items', 'ItemComments'
  ];
  const lines = [header.join(',')];
  rows.forEach(r => {
    const itemsText = (r.items || []).map(i => `${i.name} ($${money(i.price)}${i.vendorCode ? `, ${i.vendorCode}` : i.vendor ? `, ${i.vendor}` : ''})`).join('; ');
    const commentsText = (r.items || []).map(i => (i.comment || '').trim()).filter(Boolean).join('; ');
    const line = [
      r.number || r.id || '',
      r.datetime || '',
      r.displayDate || '',
      r.cashier || '',
      r.payment || '',
      money(r.subtotal),
      money(r.tax),
      money(r.total),
      r.taxExempt ? 'YES' : 'NO',
      r.taxExemptName || '',
      r.taxExemptId || '',
      r.voided ? 'YES' : 'NO',
      r.voidInfo?.reason || '',
      r.returned ? 'YES' : 'NO',
      r.returnInfo?.reason || '',
      r.returnInfo?.user || '',
      r.returnInfo?.when || '',
      itemsText.replaceAll(',', ';'),
      commentsText.replaceAll(',', ';')
    ].map(v => `"${String(v).replaceAll('"', '""')}"`).join(',');
    lines.push(line);
  });
  return lines.join('\r\n');
}
// Trigger a CSV download of the currently filtered receipts.
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

// ---------- Void / Return modal helpers ----------
// Shared modal state for void + return flows.
let __voidModal, __resolveVoid;
let __returnModal, __resolveReturn, __returnReceiptData = null;
let __returnConfirmBtn = null;
let __returnEntireChk = null;

// Load the cashier list from disk (main process) with a safe fallback.
async function getCashiersList() {
  // Actual json objects from disk
  let list = await invoke('cashiers:load');
  if (!Array.isArray(list)) list = [];
  if (list.length === 0) list = [{ name: 'Manager' }];
  return list;
}

// Fill the void modal cashier <select> with current cashiers.
async function populateVoidCashiers() {
  const sel = document.getElementById('voidCashierSelect');
  if (!sel) return;
  sel.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select cashier';
  placeholder.selected = true;
  sel.appendChild(placeholder);

  const cashiers = await getCashiersList();
  cashiers.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    opt.dataset.cashier = JSON.stringify(c); // stash full object for confirm
    opt.dataset.index = String(idx);
    sel.appendChild(opt);
  });
}

// Wire up the Void modal (reason + cashier + confirm/cancel behavior).
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
    if (!reason) {
      if (typeof showToast === 'function') { showToast('Please add a void reason.', { type: 'error' }); }
      try { input.focus(); } catch (_) { }
      return;
    }
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) {
      if (typeof showToast === 'function') { showToast('Please add a cashier.', { type: 'error' }); }
      try { sel.focus(); } catch (_) { }
      return;
    }
    let cashierObj = null;
    try { cashierObj = opt?.dataset?.cashier ? JSON.parse(opt.dataset.cashier) : null; } catch (_) { }
    const user = (cashierObj?.name || sel.value || '').trim();
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

// Show the Void modal and resolve with the user's input (or null if canceled).
function askVoidInfo() {
  if (!__voidModal) setupVoidModal();
  return new Promise(res => {
    __resolveVoid = res;
    __voidModal.show();
  });
}

// Fill the Return modal cashier <select> with current cashiers.
async function populateReturnCashiers() {
  const sel = document.getElementById('returnCashierSelect');
  if (!sel) return;
  sel.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select cashier';
  placeholder.selected = true;
  sel.appendChild(placeholder);

  const cashiers = await getCashiersList();
  cashiers.forEach((c, idx) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    opt.dataset.cashier = JSON.stringify(c);
    opt.dataset.index = String(idx);
    sel.appendChild(opt);
  });
}

// Load a receipt into the Return modal (summary + items grid + existing return info).
async function loadReturnReceipt(receiptId) {
  const summary = document.getElementById('returnReceiptSummary');
  const list = document.getElementById('returnItemsList');
  const reasonInput = document.getElementById('returnReasonInput');
  const cashierSel = document.getElementById('returnCashierSelect');
  const hint = document.getElementById('returnModalHint');
  __returnReceiptData = null;
  if (summary) summary.textContent = receiptId ? 'Searching…' : '';
  if (list) list.innerHTML = receiptId ? '<div class="text-muted small">Loading receipt…</div>' : '';
  try {
    if (!receiptId) return null;
    const r = await invoke('receipts:get', receiptId);
    if (!r) {
      if (summary) summary.textContent = 'Receipt not found.';
      if (list) list.innerHTML = '<div class="text-muted small">Receipt not found.</div>';
      return null;
    }
    __returnReceiptData = r;
    const count = Array.isArray(r.items) ? r.items.length : 0;
    const hasReturn = !!r.returned;
    if (summary) {
      const base = `Found ${count} item${count === 1 ? '' : 's'} • Total $${money(r.total)}`;
      const returnInfo = hasReturn && r.returnInfo
        ? ` | Existing return: ${r.returnInfo.reason || ''}${r.returnInfo.user ? ` by ${r.returnInfo.user}` : ''}${r.returnInfo.when ? ` on ${new Date(r.returnInfo.when).toLocaleString()}` : ''}`
        : '';
      summary.textContent = base + returnInfo;
    }
    if (reasonInput && hasReturn) reasonInput.value = r.returnInfo?.reason || '';
    if (cashierSel && hasReturn) {
      const user = String(r.returnInfo?.user || '').trim();
      if (user) {
        Array.from(cashierSel.options || []).forEach(opt => {
          if (opt.value === user || opt.textContent === user) opt.selected = true;
        });
      }
    }
    if (hint && hasReturn) {
      hint.textContent = 'Editing existing return; adjust items/qty as needed.';
    }
    renderReturnItemsList(r);
    updateReturnButtonState();
    return r;
  } catch (err) {
    if (summary) summary.textContent = `Unable to load receipt: ${err?.message || String(err)}`;
    if (list) list.innerHTML = '';
    return null;
  }
}

// Enable/disable and relabel the Return button based on current selection + prior returns.
function updateReturnButtonState() {
  if (!__returnConfirmBtn) __returnConfirmBtn = document.getElementById('returnConfirmBtn');
  if (!__returnEntireChk) __returnEntireChk = document.getElementById('returnEntireCheckbox');
  const btn = __returnConfirmBtn;
  if (!btn) return;
  const hasExistingReturn = Array.isArray(__returnReceiptData?.returnInfo?.items) && __returnReceiptData.returnInfo.items.length > 0;
  btn.textContent = hasExistingReturn ? 'Update Return' : 'Return Items';
  const useEntire = __returnEntireChk && __returnEntireChk.checked;
  let hasSelection = false;
  if (useEntire) {
    hasSelection = Array.isArray(__returnReceiptData?.items) && __returnReceiptData.items.length > 0;
  } else {
    const wrap = document.getElementById('returnItemsList');
    if (wrap) {
      wrap.querySelectorAll('input[data-return-idx]').forEach(chk => {
        if (chk.checked) hasSelection = true;
      });
    }
  }
  btn.disabled = !hasSelection;
}

// Render the list of items inside the Return modal, including prior returned quantities.
function renderReturnItemsList(receipt) {
  const wrap = document.getElementById('returnItemsList');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!receipt || !Array.isArray(receipt.items) || !receipt.items.length) {
    wrap.innerHTML = '<div class="text-muted small">No items on this receipt.</div>';
    return;
  }
  const returnedByKey = {};
  if (receipt.returned && receipt.returnInfo && Array.isArray(receipt.returnInfo.items)) {
    receipt.returnInfo.items.forEach(it => {
      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const price = Number(it.price || 0).toFixed(2);
      const key = [
        String(it.name || '').trim().toLowerCase(),
        price,
        String(it.vendorCode || it.vendor || '').trim().toLowerCase()
      ].join('|');
      returnedByKey[key] = (returnedByKey[key] || 0) + qty;
    });
  }
  receipt.items.forEach((it, idx) => {
    const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
    const price = Number(it.price || 0);
    const key = [
      String(it.name || '').trim().toLowerCase(),
      price.toFixed(2),
      String(it.vendorCode || it.vendor || '').trim().toLowerCase()
    ].join('|');
    const previouslyReturned = returnedByKey[key] || 0;
    const remainingQty = Math.max(0, qty - previouslyReturned);
    const defaultQty = remainingQty;
    const returnedBadge = previouslyReturned > 0
      ? `<div class="text-success small">Returned ${previouslyReturned}${qty > 1 ? ` of ${qty}` : ''}</div>`
      : '';
    const label = esc(it.name || 'Item');
    const vendor = esc(it.vendorCode || it.vendor || '');
    const row = document.createElement('div');
    row.className = 'return-item-row d-flex flex-wrap align-items-start justify-content-between gap-2';
      row.innerHTML = `
        <div class="form-check flex-grow-1">
          <input class="form-check-input" type="checkbox" id="returnItemChk-${idx}" data-return-idx="${idx}" ${remainingQty <= 0 ? 'disabled' : ''} data-remaining="${remainingQty}">
          <label class="form-check-label" for="returnItemChk-${idx}">
            <div class="fw-semibold">${label}</div>
            <div class="text-muted small d-flex flex-wrap gap-2">
              ${vendor ? `<span>Vendor: ${vendor}</span>` : ''}
              <span class="return-price">$${money(price)}</span>
              ${qty > 1 ? `<span>Sold: ${qty}</span>` : ''}
            </div>
          </label>
          ${returnedBadge}
        </div>
        <div class="d-flex flex-column align-items-end gap-1">
          <div class="input-group input-group-sm" style="width:140px;">
            <span class="input-group-text">Qty</span>
            <input type="number" min="0" max="${remainingQty}" value="${defaultQty}" class="form-control" id="returnItemQty-${idx}" data-return-idx="${idx}" data-remaining="${remainingQty}" ${remainingQty <= 0 ? 'disabled' : ''}>
          </div>
        </div>
    `;
    wrap.appendChild(row);
  });
  updateReturnButtonState();
}

// Initialize the Return modal (fields, events, validation, and confirm payload building).
function setupReturnModal() {
  const el = document.getElementById('returnModal');
  if (!el || !window.bootstrap) return;
  __returnModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });

  const confirmBtn = document.getElementById('returnConfirmBtn');
  const cancelBtn = document.getElementById('returnCancelBtn');
  const closeX = document.getElementById('returnCloseX');
  const receiptInput = document.getElementById('returnReceiptId');
  const reasonInput = document.getElementById('returnReasonInput');
  const sel = document.getElementById('returnCashierSelect');
  const hint = document.getElementById('returnModalHint');
  const entireChk = document.getElementById('returnEntireCheckbox');
  __returnConfirmBtn = confirmBtn;
  __returnEntireChk = entireChk;

  const finish = (val) => {
    if (__resolveReturn) __resolveReturn(val);
    __resolveReturn = null;
    __returnReceiptData = null;
    try { if (receiptInput) receiptInput.readOnly = false; } catch (_) { }
    try { __returnModal.hide(); } catch (_) { }
  };

  const gatherReturnItems = () => {
    if (!__returnReceiptData || !Array.isArray(__returnReceiptData.items)) return [];
    const allItems = __returnReceiptData.items;
    const useEntire = entireChk && entireChk.checked;
    if (useEntire) {
      return allItems.map(it => ({
        name: it.name,
        quantity: Math.max(1, parseInt(it.quantity || it.qty || 1, 10)),
        price: Number(it.price || 0),
        vendor: it.vendor || it.vendorCode || '',
        comment: it.comment || ''
      }));
    }
    const wrap = document.getElementById('returnItemsList');
    if (!wrap) return [];
    const out = [];
    wrap.querySelectorAll('input[data-return-idx]').forEach(chk => {
      if (!chk.checked) return;
      const idx = Number(chk.dataset.returnIdx);
      const src = allItems[idx];
      if (!src) return;
      const qtyInput = document.getElementById(`returnItemQty-${idx}`);
      const remaining = Math.max(0, Number(qtyInput?.dataset?.remaining || src.quantity || src.qty || 0));
      let qty = Math.max(0, Number(qtyInput?.value || remaining || 0));
      const maxQty = Math.max(0, remaining || 0);
      if (qty > maxQty) qty = maxQty;
      if (qty <= 0) return;
      out.push({
        name: src.name,
        quantity: qty,
        price: Number(src.price || 0),
        vendor: src.vendor || src.vendorCode || '',
        comment: src.comment || ''
      });
    });
    return out;
  };

  if (confirmBtn) {
    confirmBtn.textContent = 'Return Items';
    confirmBtn.onclick = () => {
      const receiptId = (receiptInput?.value || '').trim();
      if (!receiptId) {
        showToast('Enter a receipt number or ID.', { type: 'error' });
        receiptInput?.focus();
        return;
      }
      const reason = (reasonInput?.value || '').trim();
      if (!reason) {
        showToast('Please provide a reason for the return.', { type: 'error' });
        reasonInput?.focus();
        return;
      }
      const opt = sel?.options[sel.selectedIndex];
      if (!opt || !opt.value) {
        showToast('Please add a cashier.', { type: 'error' });
        try { sel?.focus(); } catch (_) { }
        return;
      }
      const useEntire = !!(entireChk && entireChk.checked);
      const existingItems = (!useEntire && Array.isArray(__returnReceiptData?.returnInfo?.items))
        ? __returnReceiptData.returnInfo.items.map(it => ({
          name: String(it?.name || '').trim(),
          quantity: Math.max(1, parseInt(it?.quantity || 1, 10)),
          price: Number(it?.price || 0),
          vendor: String(it?.vendor || '').trim(),
          comment: String(it?.comment || '').trim()
        }))
        : [];
      let cashierObj = null;
      try { cashierObj = opt?.dataset?.cashier ? JSON.parse(opt.dataset.cashier) : null; } catch (_) { }
      const user = (cashierObj?.name || sel?.value || '').trim();
      const items = gatherReturnItems();
      const mergedItems = useEntire ? items : [...existingItems, ...items];
      if (!mergedItems.length) {
        showToast('Select at least one item to return or choose entire receipt.', { type: 'error' });
        return;
      }
      finish({ receiptId, reason, user, cashier: cashierObj, items: mergedItems });
    };
  }
  if (cancelBtn) cancelBtn.onclick = () => finish(null);
  if (closeX) closeX.onclick = () => finish(null);

  el.addEventListener('shown.bs.modal', async () => {
    await populateReturnCashiers();
    if (reasonInput) reasonInput.value = '';
    const summary = document.getElementById('returnReceiptSummary');
    const list = document.getElementById('returnItemsList');
    if (summary) summary.textContent = '';
    if (list) list.innerHTML = '';
    if (entireChk) entireChk.checked = false;
    setTimeout(() => {
      try {
        if (receiptInput && !receiptInput.readOnly) {
          receiptInput.focus();
          receiptInput.select();
        } else if (reasonInput) {
          reasonInput.focus();
        }
      } catch (_) { }
    }, 80);
    if (hint) {
      hint.textContent = hint.dataset.default || 'Enter the receipt number or ID to log a return.';
    }
    const idVal = (receiptInput?.value || '').trim();
    if (idVal) {
      try { await loadReturnReceipt(idVal); } catch (_) { }
    }
    updateReturnButtonState();
  });

  if (entireChk) entireChk.addEventListener('change', updateReturnButtonState);
  const list = document.getElementById('returnItemsList');
  if (list) {
    list.addEventListener('change', e => {
      const t = e.target;
      if (t && t.matches && (t.matches('input[data-return-idx]') || t.id.startsWith('returnItemQty-'))) {
        updateReturnButtonState();
      }
    });
    list.addEventListener('input', e => {
      const t = e.target;
      if (t && t.matches && (t.matches('input[data-return-idx]') || t.id.startsWith('returnItemQty-'))) {
        updateReturnButtonState();
      }
    });
  }
}

// High-level helper used by button flows to open the Return modal and collect input.
async function askReturnInfo(opts = {}) {
  if (!__returnModal) setupReturnModal();
  if (!__returnModal) return Promise.resolve(null);

  const receiptInput = document.getElementById('returnReceiptId');
  const hint = document.getElementById('returnModalHint');
  const summary = document.getElementById('returnReceiptSummary');
  const list = document.getElementById('returnItemsList');
  const entireChk = document.getElementById('returnEntireCheckbox');
  if (receiptInput) {
    receiptInput.value = opts.receiptId || '';
    receiptInput.readOnly = !!opts.readOnly;
  }
  if (hint) {
    hint.dataset.default = hint.dataset.default || (hint.textContent || '');
    hint.textContent = opts.hint || hint.dataset.default || 'Enter the receipt number or ID to log a return.';
  }
  if (summary) summary.textContent = '';
  if (list) list.innerHTML = '';
  if (entireChk) entireChk.checked = false;
  updateReturnButtonState();

  if (opts.receiptId) {
    try { await loadReturnReceipt(opts.receiptId); } catch (_) { }
  }

  return new Promise(res => {
    __resolveReturn = res;
    __returnModal.show();
  });
}

// ---------- Inline button action handler ----------
// Central handler for receipt row actions: view, print, void, return.
window.__onReceiptAction = async function __onReceiptAction(e, action, id) {
  try {
    if (!id) return;

    if (action === 'view') {
      const r = await invoke('receipts:get', id);
      if (!r) { showToast(`Receipt not found for id: ${id}`, { type: 'error' }); return; }
      await openReceiptWindow(r, { autoPrint: false });
      return;
    }

    if (action === 'print') {
      const r = await invoke('receipts:get', id);
      if (!r) { showToast(`Receipt not found for id: ${id}`, { type: 'error' }); return; }
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
            const resp = await invoke('receipts:void', { id, reason, user, userObj: cashier });
            if (!resp) {
              showToast(`Unable to void receipt. ID sent: ${id}.`, { type: 'error', duration: 4000 });
              btn.disabled = false; btn.textContent = prev;
              return;
            }
            await loadAll();
            applyFilters();
            showToast('Receipt voided.', { type: 'success' });
          } catch (err) {
            showToast('Error voiding receipt: ' + (err?.message || err), { type: 'error' });
            btn.disabled = false; btn.textContent = prev;
          }
        } else {
          const resp = await invoke('receipts:void', { id, reason, user, userObj: cashier });
          if (!resp) { showToast(`Unable to void receipt. ID sent: ${id}.`, { type: 'error' }); return; }
          await loadAll(); applyFilters();
          showToast('Receipt voided.', { type: 'success' });
        }
        return;
      }

    if (action === 'return') {
      const btn = e.currentTarget || e.target;
      const infoGetter = (typeof window.__askReturnInfoOverride === 'function') ? window.__askReturnInfoOverride : askReturnInfo;
      const info = await infoGetter({ receiptId: id, readOnly: true, hint: `Returning ${id}` });
      if (info === null) return;
      const { receiptId, reason, user, cashier, items } = info;
      const resolvedId = String(receiptId || id || '').trim();
      if (!resolvedId) {
        showToast('Receipt id missing for return.', { type: 'error' });
        return;
      }

      const makeCall = async () => {
        const payload = { id: resolvedId, reason, user, userObj: cashier };
        if (Array.isArray(items) && items.length) payload.items = items;
        if (typeof window.__onReturnTestHook === 'function') {
          try { window.__onReturnTestHook(payload); } catch (_) { }
        }
        const resp = await invoke('receipts:return', payload);
          if (!resp) {
            showToast(`Unable to return receipt. ID sent: ${receiptId}`, { type: 'error' });
            return false;
          }
          await loadAll();
          applyFilters();
          showToast('Return recorded.', { type: 'success' });
          return true;
        };

      if (btn && btn.tagName === 'BUTTON') {
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = 'Returning…';
        try {
          await makeCall();
        } catch (err) {
          showToast('Error returning receipt: ' + (err?.message || err), { type: 'error' });
        } finally {
          btn.disabled = false;
          btn.textContent = prev;
        }
      } else {
        try {
          await makeCall();
        } catch (err) {
          showToast('Error returning receipt: ' + (err?.message || err), { type: 'error' });
        }
      }
      return;
    }

  } catch (err) {
    console.error('Action error:', err);
    showToast('Unexpected error: ' + (err?.message || err), { type: 'error' });
  }
};

// ---------- init ----------
// When the Receipts page loads, hydrate data, hook filters, and react to settings.
window.addEventListener('load', async () => {
  try { window.__vendorsCache = await invoke('vendors:load'); } catch (_) { window.__vendorsCache = []; }
  await loadAll();
  await populateCashiersFilter();
  // Lightweight debounce to coalesce rapid UI changes into one render
  const scheduleApplyFilters = (() => {
    let raf = 0;
    return () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { raf = 0; try { applyFilters(); } catch (_) { } });
    };
  })();
  applyFilters();

  const receiptParam = (() => {
    try { return new URLSearchParams(window.location.search).get('receipt') || ''; } catch (_) { return ''; }
  })();
  if (receiptParam) {
    try {
      const q = document.getElementById('q');
      if (q) q.value = receiptParam;
      applyFilters();
      const r = await invoke('receipts:get', receiptParam);
      if (r) {
        await openReceiptWindow(r, { autoPrint: false });
      } else {
        showToast('Receipt not found.', { type: 'error' });
      }
    } catch (err) {
      showToast('Unable to open receipt: ' + (err?.message || err), { type: 'error' });
    }
  }

  $('#applyBtn').addEventListener('click', applyFilters);
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') applyFilters(); });
  $('#exportBtn').addEventListener('click', exportCSV);
  $('#voidFilter').addEventListener('change', scheduleApplyFilters);
  // Smooth updates for common filter controls
  document.getElementById('cashierFilter')?.addEventListener('change', scheduleApplyFilters);
  document.getElementById('paymentFilter')?.addEventListener('change', scheduleApplyFilters);
  document.getElementById('fromDate')?.addEventListener('change', scheduleApplyFilters);
  document.getElementById('toDate')?.addEventListener('change', scheduleApplyFilters);
  try {
    const s = await invoke('settings:load');
    const rate = Number(s?.giftCardSurchargeRate);
    if (!isNaN(rate) && rate >= 0 && rate <= 1) GIFT_CARD_SURCHARGE_RATE = rate;
    branding = {
      bizName: String(s?.bizName || branding.bizName),
      bizAddress: String(s?.bizAddress || branding.bizAddress),
      bizPhone: String(s?.bizPhone || branding.bizPhone),
      logoPath: String(s?.logoPath || '')
    };
    __greyscalePrint = !!s?.greyscalePrint;
    applyBrandingToReceiptsPage();
  } catch (_) { }

  try {
    api?.on?.('settings:changed', (_evt, payload) => {
      const rate = Number(payload?.giftCardSurchargeRate);
      if (!isNaN(rate) && rate >= 0 && rate <= 1) GIFT_CARD_SURCHARGE_RATE = rate;
      try {
        branding = {
          bizName: String(payload?.bizName || branding.bizName),
          bizAddress: String(payload?.bizAddress || branding.bizAddress),
          bizPhone: String(payload?.bizPhone || branding.bizPhone),
          logoPath: String(payload?.logoPath || branding.logoPath || '')
        };
        applyBrandingToReceiptsPage();
      } catch (_) { }
      if (typeof payload?.greyscalePrint === 'boolean') {
        __greyscalePrint = !!payload.greyscalePrint;
      }
    });
  } catch (_) { }

  // Quick filters: Today / Yesterday
  const setDateRangeAndApply = (fromStr, toStr) => {
    const from = document.getElementById('fromDate');
    const to = document.getElementById('toDate');
    if (from) from.value = fromStr;
    if (to) to.value = toStr;
    applyFilters();
  };
  const todayBtn = document.getElementById('todayBtn');
  if (todayBtn) todayBtn.addEventListener('click', () => {
    const now = new Date();
    const ymd = toDateInputValue(now);
    setDateRangeAndApply(ymd, ymd);
  });
  const yesterdayBtn = document.getElementById('yesterdayBtn');
  if (yesterdayBtn) yesterdayBtn.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const ymd = toDateInputValue(d);
    setDateRangeAndApply(ymd, ymd);
  });
  const thisMonthBtn = document.getElementById('thisMonthBtn');
  if (thisMonthBtn) thisMonthBtn.addEventListener('click', () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    setDateRangeAndApply(toDateInputValue(start), toDateInputValue(end));
  });
  const lastMonthBtn = document.getElementById('lastMonthBtn');
  if (lastMonthBtn) lastMonthBtn.addEventListener('click', () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    setDateRangeAndApply(toDateInputValue(start), toDateInputValue(end));
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
    selectedVendorKey = '';
    applyFilters();
  });

  // Debug button if present
  // Initialize the modal-based void prompt
  setupVoidModal();
  setupReturnModal();
});

// --- Override: view/print window as full-page Sales Invoice ---
// Rich, printable invoice layout used when viewing/printing a single receipt.
async function openReceiptWindow(r, opts = {}) {
  const autoPrint = !!opts.autoPrint;
  const vendors = (Array.isArray(window.__vendorsCache) && window.__vendorsCache.length)
    ? window.__vendorsCache
    : await invoke('vendors:load');
  try { if (!window.__vendorsCache || !window.__vendorsCache.length) window.__vendorsCache = vendors; } catch (_) { }
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
    .sheet{position:relative; background:var(--sheet); margin:20px; padding:28px 32px 180px 32px; box-shadow:0 2px 10px rgba(0,0,0,.08);} 
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
    .brand{font-weight:800;font-size:18px;letter-spacing:.1px}
    .addr{color:var(--muted);font-size:11px;margin-top:2px}
    .title{font-size:18px;font-weight:800;letter-spacing:.3px;color:var(--emph);text-transform:uppercase}
    .meta{display:grid;grid-template-columns: repeat(2,minmax(180px,1fr)); gap:6px 12px; margin-top:10px; font-size:12px;}
    .meta .label{color:var(--muted); font-size:11px;}
    .void-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .void-watermark span{transform:rotate(-25deg);font-size:120px;font-weight:900;color:rgba(220,53,69,.14);}
    .return-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
    .return-watermark span{transform:rotate(-25deg);font-size:120px;font-weight:900;color:rgba(16,185,129,.14);}

    table{width:100%;border-collapse:collapse;margin-top:14px}
    thead th{font-size:11px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:8px 6px;text-align:left}
    tbody td{padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top;font-size:12px}
    th.num, td.num{ text-align:right }
    .desc{font-weight:600;font-size:12px}
    .cell-line{line-height:1.2}
    .cell-line.strike{text-decoration:line-through;color:var(--muted);}
    .vendor{color:var(--muted);font-size:11px}
    .totals{margin-top:12px;display:grid;grid-template-columns: 1fr auto;row-gap:6px}
    .totals .label{color:var(--muted); font-size:12px}
    .totals .val{min-width:110px;text-align:right; font-size:12px}
    .totals .grand{font-weight:800;font-size:14px;color:var(--emph)}
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
       .bgmark{position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:70%; height:auto; opacity:.10; pointer-events:none; display:none;
      filter: blur(0.8px);
      -webkit-mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
              mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
      -webkit-mask-size: 100% 100%;
              mask-size: 100% 100%; }
      .void-watermark,
      .return-watermark{
        position: fixed !important;
        inset: 0 !important;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
      }
    }
    ${getGreyscalePrintCss()}
  </style>`;

  const vendorTotals = {};
  const returnQtyByKey = {};
  let returnSubtotal = 0;
  if (r.returned && r.returnInfo && Array.isArray(r.returnInfo.items)) {
    r.returnInfo.items.forEach(it => {
      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const price = toMoneyNumber(it.price || 0);
      const amount = qty * price;
      returnSubtotal += amount;
      const key = [
        String(it.name || '').trim().toLowerCase(),
        price.toFixed(2),
        String(it.vendor || it.vendorCode || '').trim().toLowerCase()
      ].join('|');
      returnQtyByKey[key] = (returnQtyByKey[key] || 0) + qty;
    });
  }
  const taxRate = Number(r.taxRate || 0);
  const returnTax = r.taxExempt ? 0 : toMoneyNumber(returnSubtotal * taxRate);
  const returnTotal = toMoneyNumber(returnSubtotal + returnTax);
  const netTotal = toMoneyNumber((r.total || 0) - returnTotal);
  const splitInfo = getSplitTenderInfo(r);
  const splitRows = splitInfo ? `
            <div class="label">${esc(splitInfo.payment || 'Tender 1')}</div><div class="val">$${money(splitInfo.primaryAmount)}</div>
            <div class="label">${esc(splitInfo.splitType || 'Tender 2')}</div><div class="val">$${money(splitInfo.splitAmount)}</div>
            ${splitInfo.isCashSplit ? `<div class="label">Cash Received</div><div class="val">$${money(splitInfo.cashReceived)}</div>` : ''}
            ${splitInfo.isCashSplit && splitInfo.changeDue > 0 ? `<div class="label">Change Due</div><div class="val">$${money(splitInfo.changeDue)}</div>` : ''}
            <div class="label">Split Total</div><div class="val">$${money(splitInfo.total)}</div>` : '';
    const giftInfo = getGiftCardInfo(r);
    const giftRows = giftInfo ? `
            <div class="label">Gift Card #</div><div class="val">${esc(giftInfo.number || '-')}</div>
            <div class="label">Gift Card Balance</div><div class="val">$${money(giftInfo.balance)}</div>` : '';
    const cardFee = getCardFeeFromReceipt(r);
    const cardFeeRow = cardFee > 0
      ? `<div class="label">Card Fee (${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}%)</div><div class="val">$${money(cardFee)}</div>`
      : '';

  const rows = (() => {
    const out = [];
    (r.items || []).forEach((it, idx) => {
      const { finalPrice, original, discountAmount, reason, type, value } = deriveDiscount(it);
      const hasDiscount = discountAmount > 0;
      const discountSuffix = hasDiscount ? buildDiscountSuffix(type, value, discountAmount, reason, esc) : '';
      const code = resolveCode(it);
      const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
      const unit = finalPrice;
      const key = [
        String(it.name || '').trim().toLowerCase(),
        unit.toFixed(2),
        String(code || it.vendor || '').trim().toLowerCase()
      ].join('|');
      const returnedQty = returnQtyByKey[key] || 0;
      const remainingQty = Math.max(0, qty - returnedQty);
      const returnedTotal = toMoneyNumber(unit * returnedQty);
      const remainingTotal = toMoneyNumber(unit * remainingQty);
      const vendorContribution = toMoneyNumber(unit * qty);
      const vendorReturnDeduction = toMoneyNumber(unit * returnedQty);
      if (code) vendorTotals[code] = toMoneyNumber((vendorTotals[code] || 0) + vendorContribution - vendorReturnDeduction);
      const fullyReturned = returnedQty >= qty && returnedQty > 0;
      const partiallyReturned = returnedQty > 0 && returnedQty < qty;
      const returnedNote = (fullyReturned || partiallyReturned) && r.returnInfo
        ? `<div class="vendor" style="color:#16a34a;">Returned ${returnedQty}${qty > 1 ? ` of ${qty}` : ''}${r.returnInfo.when ? ` on ${new Date(r.returnInfo.when).toLocaleDateString()}` : ''}${r.returnInfo.user ? ` by ${esc(r.returnInfo.user)}` : ''}</div>`
        : '';
      const discountBlock = `
          ${it.comment ? `<div class="vendor">${esc(it.comment)}</div>` : ''}
          ${code ? `<div class="vendor">Vendor: ${esc(code)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="text-decoration:line-through;">Original: $${money(original)}</div>` : ''}
          ${hasDiscount ? `<div class="vendor" style="color:#dc3545;">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}`;

      const qtyLines = [];
      const unitLines = [];
      const amtLines = [];
      if (returnedQty > 0) {
        qtyLines.push(`<div class="cell-line strike">${returnedQty}</div>`);
        unitLines.push(`<div class="cell-line strike">$${money(unit)}</div>`);
        amtLines.push(`<div class="cell-line strike">-$${money(returnedTotal)}</div>`);
      }
      if (remainingQty > 0) {
        qtyLines.push(`<div class="cell-line">${remainingQty}</div>`);
        unitLines.push(`<div class="cell-line">$${money(unit)}</div>`);
        amtLines.push(`<div class="cell-line">$${money(remainingTotal)}</div>`);
      }
      if (!qtyLines.length) {
        const amount = qty * unit;
        qtyLines.push(`<div class="cell-line">${qty}</div>`);
        unitLines.push(`<div class="cell-line">$${money(unit)}</div>`);
        amtLines.push(`<div class="cell-line">$${money(amount)}</div>`);
      }

      out.push(`
      <tr>
        <td class="num">${idx + 1}</td>
        <td>
          <div class="desc">${esc(it.name)}</div>
          ${discountBlock}
          ${returnedNote}
        </td>
        <td class="num">${qtyLines.join('')}</td>
        <td class="num">${unitLines.join('')}</td>
        <td class="num">${amtLines.join('')}</td>
      </tr>`);
    });
    return out.join('');
  })();

  const codes = Object.keys(vendorTotals).sort();
  const vendorBlock = codes.length
    ? `
      <div class="vendor-sub">
        <h4>Vendor Subtotals</h4>
        <table>
          <tbody>
            ${codes.map(c => `<tr><td class="vendor">- ${esc(c)}</td><td class="num">$${money(vendorTotals[c])}</td></tr>`).join('')}
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

  const returnWatermark = (r.returned && !r.voided) ? `<div class="return-watermark"><span>RETURN</span></div>` : '';
  const returnInline = r.returned
    ? `
        <div class="label">Returned</div>
        <div><strong>${esc(r.returnInfo?.reason || 'Return recorded')}</strong>
        ${r.returnInfo?.user ? ` - <span class="label">by ${esc(r.returnInfo.user)}</span>` : ''}
        ${r.returnInfo?.when ? ` <span class="label">on ${new Date(r.returnInfo.when).toLocaleString()}</span>` : ''}
        </div>`
    : '';


  const displayDate = r.displayDate || (r.datetime ? new Date(r.datetime).toLocaleString() : '');
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
        <img class="bgmark" src="assets/NEW_MiddletonsBW.PNG" alt="">
        ${voidWatermark}
        ${returnWatermark}
        <div class="header">
          <div class="brand-wrap">
            <img src="assets/NEW_MiddletonsBW.PNG" alt="Logo" style="height:96px; width:auto; border-radius:12px" />
            <div>
              <div class="brand">Middleton's Antiques &amp; Uniques</div>
              <div class="addr">123 Antique Row, Lincoln, NE · (402) 555-1212</div>
            </div>
          </div>
          <div class="title">Sales Invoice</div>
        </div>

        <div class="meta">
          <div><div class="label">Invoice #</div><div><strong>${esc(r.number || r.id)}</strong></div></div>
          <div><div class="label">Date</div><div><strong>${esc(displayDate)}</strong></div></div>
          <div><div class="label">Cashier</div><div><strong>${esc(r.cashier || '-')}</strong></div></div>
          <div><div class="label">Payment</div><div><strong>${esc(r.payment || '-')}</strong></div></div>
          ${voidInline}
          ${returnInline}
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
          <div class="label">${r.taxExempt ? 'Tax (Exempt)' : `Tax (${(Number(r.taxRate || 0) * 100).toFixed(2)}%)`}</div><div class="val">$${money(r.tax)}</div>
          ${cardFeeRow}
          <div class="label grand">Total</div><div class="val grand">$${money(r.total)}</div>
          ${splitRows}
          ${giftRows}
          ${r.returned && returnTotal > 0 ? `
          <div class="label">Return Subtotal</div><div class="val">-$${money(returnSubtotal)}</div>
          <div class="label">Return Tax</div><div class="val">-$${money(returnTax)}</div>
          <div class="label grand">Return Total</div><div class="val grand">-$${money(returnTotal)}</div>
          <div class="label grand">Net Total</div><div class="val grand">$${money(netTotal)}</div>` : ''}
        </div>
            ${r.taxExempt ? `<div class="notes"><strong>Tax Exempt</strong>: ${esc(r.taxExemptName || '')} — ID: ${esc(r.taxExemptId || '')}</div>` : ''}

        <div class="notes">
          Thank you for shopping small!
        </div>

        <div class="socialQR">
          <img src="assets/QR.png" alt="Facebook QR code">
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
    applyBrandingToReceiptWindow(w);
  } catch (_) { }
  w.document.close();
  return w;
}

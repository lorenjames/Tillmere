// reports.js
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
let __suppressUnloadTimer = null;
function suppressUnloadPromptTemporarily() {
  try {
    __suppressUnloadPrompt = true;
    if (__suppressUnloadTimer) clearTimeout(__suppressUnloadTimer);
    __suppressUnloadTimer = setTimeout(() => { __suppressUnloadPrompt = false; }, 2000);
  } catch (_) { }
}
function isSameOriginNavHref(href) {
  try {
    if (!href || href.startsWith('#')) return false;
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin;
  } catch (_) { return false; }
}
function markInternalNavigation(event) {
  try {
    const anchor = event?.target?.closest ? event.target.closest('a[href]') : null;
    if (anchor && isSameOriginNavHref(anchor.getAttribute('href'))) {
      suppressUnloadPromptTemporarily();
      return;
    }
    const navEl = event?.target?.closest ? event.target.closest('[data-allow-nav],[data-nav]') : null;
    if (navEl) suppressUnloadPromptTemporarily();
  } catch (_) { }
}
function markFormNavigation(event) {
  try {
    const form = event?.target;
    if (form && form.tagName === 'FORM') suppressUnloadPromptTemporarily();
  } catch (_) { }
}
function markKeyNavigation(event) {
  try {
    const key = event?.key;
    if (key !== 'Enter' && key !== ' ') return;
    const anchor = event?.target?.closest ? event.target.closest('a[href]') : null;
    if (anchor && isSameOriginNavHref(anchor.getAttribute('href'))) {
      suppressUnloadPromptTemporarily();
    }
  } catch (_) { }
}
function shouldConfirmClose() {
  return !__suppressUnloadPrompt;
}
try {
  document.addEventListener('click', suppressUnloadPromptTemporarily, true);
  document.addEventListener('pointerdown', suppressUnloadPromptTemporarily, true);
  document.addEventListener('click', markInternalNavigation, true);
  document.addEventListener('pointerdown', markInternalNavigation, true);
  document.addEventListener('submit', markFormNavigation, true);
  document.addEventListener('keydown', markKeyNavigation, true);
  window.addEventListener('pageshow', () => { __suppressUnloadPrompt = false; });
} catch (_) { }

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

const hasIpc = !!api?.hasIpc;
console.log('[reports] script loaded');
window.addEventListener('error', e => console.error('[reports] error:', e.message));

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

function wireCloseAppLink() {
    const closeAppLink = document.getElementById('closeAppLink');
    if (!hasIpc) {
        try { if (closeAppLink) closeAppLink.style.display = 'none'; } catch (_) { }
    }
    if (closeAppLink) {
        closeAppLink.addEventListener('click', () => {
            if (!hasIpc) return;
            try { invoke('app:quit'); } catch (_) { }
        });
    }
    const userGuideLink = document.getElementById('userGuideLink');
    if (!hasIpc) {
        try { if (userGuideLink) userGuideLink.style.display = 'none'; } catch (_) { }
    }
    if (userGuideLink) {
        userGuideLink.addEventListener('click', (event) => {
            event.preventDefault();
            if (!hasIpc) return;
            try { invoke('app:openUserGuide'); } catch (_) { }
        });
    }
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireCloseAppLink);
} else {
    wireCloseAppLink();
}

const money = n => Number(n || 0).toFixed(2);
const esc = s => String(s || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
const formatRatePct = rate => {
    const pct = Math.max(0, Number(rate || 0) * 100);
    return pct.toFixed(2).replace(/\.?0+$/, '');
};

let receipts = [];
let vendors = [];
let vendorByCode = new Map();
function populateVendorFilter() {
    const sel = document.getElementById('vendorFilter');
    if (!sel) return;
    sel.innerHTML = '<option value="">All vendors</option>';
    const seen = new Set();
    vendors
        .map(v => ({
            code: String(v.code || '').trim(),
            name: String(v.name || '').trim()
        }))
        .sort((a, b) => (a.code || a.name || '').localeCompare(b.code || b.name || ''))
        .forEach(v => {
            const key = (v.code || v.name).toLowerCase();
            if (!key || seen.has(key)) return;
            seen.add(key);
            const opt = document.createElement('option');
            opt.value = key;
            const label = v.code ? (v.name ? `${v.code} — ${v.name}` : v.code) : (v.name || '(Unnamed vendor)');
            opt.textContent = label;
            sel.appendChild(opt);
        });
    const hasUnassigned = receipts.some(r => (r.items || []).some(it => !String(it.vendorCode || it.vendor || '').trim()));
    if (hasUnassigned) {
        const opt = document.createElement('option');
        opt.value = '__unassigned';
        opt.textContent = 'Unassigned / none';
        sel.appendChild(opt);
    }
}

// Branding shared with POS/settings: business name, address, phone, logo
let branding = {
    bizName: "Middleton's Antiques & Uniques",
    bizAddress: '1615 S 17th St, Lincoln, NE 68502',
    bizPhone: '531-500-0135',
    logoPath: ''
};
let __greyscalePrint = false;
let GIFT_CARD_SURCHARGE_RATE = 0.03;
const getGreyscalePrintCss = () =>
    __greyscalePrint ? '@media print { html{ filter: grayscale(100%); } }' : '';
const getBrandingName = () =>
    String(branding?.bizName || "Middleton's Antiques & Uniques");
const getBrandingAddressLine = () => {
    const addr = String(branding?.bizAddress || '').trim();
    const phone = String(branding?.bizPhone || '').trim();
    if (addr && phone) return `${addr} · ${phone}`;
    return addr || phone || '';
};
const getBrandingLogoSrc = (fallback) => {
    const src = String(branding?.logoPath || '').trim();
    return src || fallback;
};
function applyBrandingToReportWindow(win) {
    if (!win || !win.document) return;
    const name = getBrandingName();
    const addrLine = getBrandingAddressLine();
    const logoSrc = getBrandingLogoSrc('assets/MiddletonsStoreFrontLogoBW.png');
    try {
        const brandEl = win.document.querySelector('.brand-wrap .brand');
        if (brandEl) brandEl.textContent = name;
    } catch (_) { }
    try {
        const headerAddr = win.document.querySelector('.brand-wrap .addr');
        if (headerAddr) headerAddr.textContent = addrLine || '';
        const muted = win.document.querySelectorAll('.addr.muted, #rcpt-address');
        muted.forEach(n => { try { n.textContent = addrLine || ''; } catch (_) { } });
    } catch (_) { }
    try {
        const imgs = win.document.querySelectorAll('img.logo, .brand-wrap img[alt="Logo"], img.bgmark');
        imgs.forEach(img => { try { img.src = logoSrc; } catch (_) { } });
    } catch (_) { }
}

const TENDERS = ['Cash', 'Card', 'Check', 'Gift Card'];
const normalizeTender = (t) => {
    t = String(t || '').trim();
    return TENDERS.includes(t) ? t : 'Other';
};
const isGiftCardSaleItem = it => {
    const name = String(it?.name || '').toLowerCase();
    return name.includes('gift card') || name.includes('giftcard');
};
const isCardTenderSelected = (payment, splitEnabled, splitType) => {
    const main = String(payment || '');
    const split = String(splitType || '');
    return main === 'Card' || (splitEnabled && split === 'Card');
};
const getReceiptItemsSubtotal = r => {
    return (Array.isArray(r?.items) ? r.items : []).reduce((sum, it) => {
        const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
        const unit = toMoneyNumber(it.price || 0);
        return sum + toMoneyNumber(unit * qty);
    }, 0);
};
const getGiftCardFeeForReceipt = (r, giftCardSaleTotal) => {
    const giftTotal = toMoneyNumber(giftCardSaleTotal || 0);
    if (giftTotal <= 0) return 0;
    const splitEnabled = !!r?.splitTenderEnabled;
    const splitType = String(r?.splitTenderType || '');
    const payment = String(r?.payment || '');
    const cardTenderUsed = payment === 'Card' || (splitEnabled && splitType === 'Card');
    if (!cardTenderUsed) return 0;
    if (splitEnabled && payment !== 'Card') {
        const splitAmount = toMoneyNumber(r?.splitTenderAmount || 0);
        const subtotal = (r?.subtotal !== undefined && r?.subtotal !== null)
            ? toMoneyNumber(r.subtotal)
            : getReceiptItemsSubtotal(r);
        const tax = toMoneyNumber(r?.tax || 0);
        const baseTotal = toMoneyNumber(subtotal + tax);
        const primaryAmount = Math.max(0, baseTotal - splitAmount);
        if (primaryAmount + 0.009 >= giftTotal) return 0;
    }
    return toMoneyNumber(giftTotal * GIFT_CARD_SURCHARGE_RATE);
};

let __managerMode = false;
let taxExemptRows = [];
const ROLE_ORDER = { cashier: 1, manager: 2, admin: 3 };
let __authRole = 'cashier';
const toMoneyNumber = n => {
    const num = Number(n);
    return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
};
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

function normalizeRole(role) {
    const key = String(role || '').trim().toLowerCase();
    return ROLE_ORDER[key] ? key : 'cashier';
}
function roleRank(role) {
    return ROLE_ORDER[normalizeRole(role)];
}
async function loadAuthRole() {
    try {
        const user = await invoke('auth:me');
        __authRole = normalizeRole(user?.role);
        __managerMode = roleRank(__authRole) >= roleRank('manager');
    } catch (_) {
        __authRole = 'cashier';
        __managerMode = false;
    }
}

function syncManagerModeUI() {
    __managerMode = roleRank(__authRole) >= roleRank('manager');
    const card = document.getElementById('taxExemptCard');
    const locked = document.getElementById('taxExemptLockedCard');
    if (card) card.style.display = __managerMode ? '' : 'none';
    if (locked) locked.style.display = __managerMode ? 'none' : '';
    if (!__managerMode) {
        clearTaxExemptReport();
    } else {
        runTaxExemptReport();
    }
}

function setDateRangeToCurrentMonth(fromId, toId) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const fromEl = document.getElementById(fromId);
    const toEl = document.getElementById(toId);
    if (fromEl) fromEl.value = fmtLocal(from);
    if (toEl) toEl.value = fmtLocal(to);
}

function getReceiptEffectiveDate(r) {
    const display = String(r?.displayDate || '').trim();
    if (display) {
        const base = display.split(' - ')[0].trim();
        const parsed = new Date(base);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    if (r?.datetime) {
        const dt = new Date(r.datetime);
        if (!Number.isNaN(dt.getTime())) return dt;
    }
    return null;
}


/** RENAMED: avoid conflict with Bootstrap's global `window.bootstrap` */
async function initReports() {
    await loadAuthRole();
    const [v, r] = await Promise.all([
        invoke('vendors:load'),
        invoke('receipts:load')
    ]);

    vendors = Array.isArray(v) ? v : [];
    receipts = Array.isArray(r) ? r : [];

    vendorByCode = new Map(
        vendors
            .filter(v => v.code)
            .map(v => [String(v.code).trim().toLowerCase(), v])
    );

    // default dates: full current calendar month
    setDateRangeToCurrentMonth('fromDate', 'toDate');
    setDateRangeToCurrentMonth('taxExemptFromDate', 'taxExemptToDate');

    populateVendorFilter();

    runReport();
    syncManagerModeUI();
}

function runReport() {
    const fromVal = document.getElementById('fromDate').value;
    const toVal = document.getElementById('toDate').value;
    const vendorFilterVal = (document.getElementById('vendorFilter')?.value || '').trim().toLowerCase();
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    const bucket = new Map(); // key -> { code,name, cash,card,cardFeeBase,check,gift,other,gross,count }

    receipts.forEach(r => {
        if (r.voided) return;
        const when = r.datetime ? new Date(r.datetime) : null;
        if (from && when && when < from) return;
        if (to && when && when > to) return;

        // map of item key -> returned qty for this receipt
            const returnQtyByKey = buildReturnQtyByKey(r);

        const tender = normalizeTender(r.payment);
        (r.items || []).forEach(it => {
            const vendorKey = String(it.vendorCode || it.vendor || '').trim().toLowerCase();
            if (vendorFilterVal) {
                if (vendorFilterVal === '__unassigned') {
                    if (vendorKey) return;
                } else if (vendorKey !== vendorFilterVal) {
                    return;
                }
            }
            const code = String(it.vendorCode || '').trim();
            let key = code;
            let name = '';

            if (code) {
                const v = vendorByCode.get(code.toLowerCase());
                name = v?.name || '';
            } else {
                name = String(it.vendor || '').trim();
                key = name || '(Unassigned)';
            }

            let rec = bucket.get(key);
            if (!rec) {
                rec = {
                    code: code || '', name,
                    cash: 0, card: 0, cardFeeBase: 0, check: 0, gift: 0, other: 0,
                    gross: 0, count: 0
                };
            }

            const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
            const unit = Number(it.price || 0);
            const itemKey = [
                String(it.name || '').trim().toLowerCase(),
                unit.toFixed(2),
                String(it.vendorCode || it.vendor || '').trim().toLowerCase()
            ].join('|');
            const returnedQty = returnQtyByKey[itemKey] || 0;
            const keepQty = Math.max(0, qty - returnedQty);
            if (keepQty <= 0) return;

            const amount = unit * keepQty;
            const isGiftSale = isGiftCardSaleItem(it);
            rec.gross += amount;
            rec.count += keepQty;
            if (tender === 'Cash') rec.cash += amount;
            else if (tender === 'Card') {
                rec.card += amount;
                if (!isGiftSale) rec.cardFeeBase += amount;
            }
            else if (tender === 'Check') rec.check += amount;
            else if (tender === 'Gift Card') rec.gift += amount;
            else rec.other += amount;

            // prefer known vendor name
            if (!rec.name && name) rec.name = name;

            bucket.set(key, rec);
        });
    });

    const rows = Array.from(bucket.values())
        .sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || ''));

    const tbody = document.getElementById('reportBody');
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();

    let totCash = 0, totCard = 0, totCardFeeBase = 0, totCheck = 0, totGift = 0, totOther = 0, grandGross = 0, grandCount = 0;

    rows.forEach(r => {
        totCash += r.cash;
        totCard += r.card;
        totCardFeeBase += r.cardFeeBase || 0;
        totCheck += r.check;
        totGift += r.gift;
        totOther += r.other;
        grandGross += r.gross;
        grandCount += r.count;

        const tr = document.createElement('tr');
        tr.dataset.cardFeeBase = String(r.cardFeeBase || 0);
        tr.innerHTML = `
      <td>${esc(r.code || '')}</td>
      <td>${esc(r.name || '')}</td>
      <td class="text-end">$${money(r.cash)}</td>
      <td class="text-end">$${money(r.card)}</td>
      <td class="text-end">$${money(r.check)}</td>
      <td class="text-end">$${money(r.gift)}</td>
      <td class="text-end">$${money(r.other)}</td>
      <td class="text-end">$${money(r.gross)}</td>
      <td class="text-end">${r.count}</td>
    `;
        frag.appendChild(tr);
    });

    tbody.appendChild(frag);
    document.getElementById('totCash').textContent = `$${money(totCash)}`;
    document.getElementById('totCard').textContent = `$${money(totCard)}`;
    document.getElementById('totCheck').textContent = `$${money(totCheck)}`;
    document.getElementById('totGift').textContent = `$${money(totGift)}`;
    document.getElementById('totOther').textContent = `$${money(totOther)}`;
    document.getElementById('grandTotal').textContent = `$${money(grandGross)}`;
    document.getElementById('grandCount').textContent = String(grandCount);

    // --- Build Credit Card Fee section (5% of gross card sales per vendor) ---
    const feeTbody = document.getElementById('cardFeeBody');
    if (feeTbody) {
        feeTbody.innerHTML = '';
        const feeFrag = document.createDocumentFragment();
        let feeTot = 0;
        // show only vendors with card > 0 for a tidy report
        rows.filter(r => r.cardFeeBase > 0).forEach(r => {
            const fee = Number(r.cardFeeBase) * 0.05;
            feeTot += fee;
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${esc(r.code || '')}</td>
              <td>${esc(r.name || '')}</td>
              <td class="text-end">$${money(r.cardFeeBase)}</td>
              <td class="text-end">$${money(fee)}</td>
            `;
            feeFrag.appendChild(tr);
        });
        feeTbody.appendChild(feeFrag);
        const feeTotCardEl = document.getElementById('feeTotCard');
        const feeTotAmountEl = document.getElementById('feeTotAmount');
        if (feeTotCardEl) feeTotCardEl.textContent = `$${money(totCardFeeBase)}`;
        if (feeTotAmountEl) feeTotAmountEl.textContent = `$${money(feeTot)}`;
    }

    renderGiftCardSummary({ from, to });

    // Build the detailed per-vendor section
    try { runDetailedReport(); } catch (e) { console.error('[reports] detailed failed:', e); }
}

function renderGiftCardSummary({ from, to }) {
    const salesEl = document.getElementById('giftCardSalesTotal');
    const feesEl = document.getElementById('giftCardFeesTotal');
    const feesNoteEl = document.getElementById('giftCardFeesNote');
    const redemptionsEl = document.getElementById('giftCardRedemptionsTotal');
    const countEl = document.getElementById('giftCardRedemptionsCount');
    const body = document.getElementById('giftCardRedemptionsBody');
    if (!salesEl || !feesEl || !redemptionsEl || !countEl || !body) return;

    let salesTotal = 0;
    let feesTotal = 0;
    let redeemedTotal = 0;
    const rows = [];

    receipts.forEach(r => {
        if (r.voided) return;
        const when = r.datetime ? new Date(r.datetime) : null;
        if (from && when && when < from) return;
        if (to && when && when > to) return;

        const returnQtyByKey = buildReturnQtyByKey(r);
        let giftSaleTotal = 0;
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
            giftSaleTotal += toMoneyNumber(unit * keepQty);
        });
        if (giftSaleTotal > 0) {
            salesTotal += giftSaleTotal;
            feesTotal += getGiftCardFeeForReceipt(r, giftSaleTotal);
        }

        if (String(r.payment || '').trim() === 'Gift Card') {
            const base = toMoneyNumber(r.giftCardAmount || 0) || toMoneyNumber(r.total || 0);
            const netTotal = toMoneyNumber((r.total || 0) - getReturnTotal(r));
            const applied = netTotal > 0 ? Math.min(base, netTotal) : 0;
            if (applied > 0) {
                redeemedTotal += applied;
                rows.push({
                    when: r.displayDate || (r.datetime ? new Date(r.datetime).toLocaleString() : ''),
                    number: r.number || r.id || '',
                    cashier: r.cashier || '',
                    cardNumber: r.giftCardNumber || '',
                    amount: applied,
                    balance: toMoneyNumber(r.giftCardBalance || 0)
                });
            }
        }
    });

    salesEl.textContent = `$${money(salesTotal)}`;
    feesEl.textContent = `$${money(feesTotal)}`;
    if (feesNoteEl) feesNoteEl.textContent = `Card fee: ${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}% on gift card sales`;
    redemptionsEl.textContent = `$${money(redeemedTotal)}`;
    countEl.textContent = `${rows.length} redemption${rows.length === 1 ? '' : 's'}`;

    body.innerHTML = '';
    const frag = document.createDocumentFragment();
    rows.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${esc(r.when)}</td>
          <td>${esc(r.number)}</td>
          <td>${esc(r.cashier)}</td>
          <td>${esc(r.cardNumber)}</td>
          <td class="text-end">$${money(r.amount)}</td>
          <td class="text-end">$${money(r.balance)}</td>
        `;
        frag.appendChild(tr);
    });
    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6" class="text-muted">No gift card redemptions for the selected period.</td>';
        frag.appendChild(tr);
    }
    body.appendChild(frag);
}


// Detailed Sales by Vendor (respects same date filters)
function runDetailedReport() {
    const fromVal = document.getElementById('fromDate')?.value;
    const toVal = document.getElementById('toDate')?.value;
    const vendorFilterVal = (document.getElementById('vendorFilter')?.value || '').trim().toLowerCase();
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    const container = document.getElementById('detailedReport');
    if (!container) return;
    container.innerHTML = '';

    const groups = new Map();

    receipts.forEach(r => {
        if (r.voided) return;
        const when = r.datetime ? new Date(r.datetime) : null;
        if (from && when && when < from) return;
        if (to && when && when > to) return;
        const tender = normalizeTender(r.payment);

        (r.items || []).forEach(it => {
            const vendorKey = String(it.vendorCode || it.vendor || '').trim().toLowerCase();
            if (vendorFilterVal) {
                if (vendorFilterVal === '__unassigned') {
                    if (vendorKey) return;
                } else if (vendorKey !== vendorFilterVal) {
                    return;
                }
            }
            const code = String(it.vendorCode || '').trim();
            let key = code;
            let name = '';
            if (code) {
                const v = vendorByCode.get(code.toLowerCase());
                name = v?.name || '';
            } else {
                name = String(it.vendor || '').trim();
                key = name || '(Unassigned)';
            }

            let g = groups.get(key);
            if (!g) {
                g = { code: code || '', name, cash: 0, card: 0, cardFeeBase: 0, check: 0, gift: 0, other: 0, gross: 0, count: 0, items: [] };
            }

            const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
            const unit = Number(it.price || 0);
            const itemKey = [
                String(it.name || '').trim().toLowerCase(),
                unit.toFixed(2),
                String(it.vendorCode || it.vendor || '').trim().toLowerCase()
            ].join('|');
            const returnQtyByKey = {};
            if (r.returned && r.returnInfo && Array.isArray(r.returnInfo.items)) {
                r.returnInfo.items.forEach(rit => {
                    const rqty = Math.max(1, parseInt(rit.quantity || rit.qty || 1, 10));
                    const rprice = Number(rit.price || 0).toFixed(2);
                    const rkey = [
                        String(rit.name || '').trim().toLowerCase(),
                        rprice,
                        String(rit.vendorCode || rit.vendor || '').trim().toLowerCase()
                    ].join('|');
                    returnQtyByKey[rkey] = (returnQtyByKey[rkey] || 0) + rqty;
                });
            }
            const returnedQty = returnQtyByKey[itemKey] || 0;
            const keepQty = Math.max(0, qty - returnedQty);
            if (keepQty <= 0) return;
            const amount = unit * keepQty;
            const isGiftSale = isGiftCardSaleItem(it);
            g.gross += amount;
            g.count += keepQty;
            if (tender === 'Cash') g.cash += amount;
            else if (tender === 'Card') {
                g.card += amount;
                if (!isGiftSale) g.cardFeeBase += amount;
            }
            else if (tender === 'Check') g.check += amount;
            else if (tender === 'Gift Card') g.gift += amount;
            else g.other += amount;
            if (!g.name && name) g.name = name;

            g.items.push({ datetime: when, number: r.number || '', item: it.name || '', qty: keepQty, unit, amount, tender });
            groups.set(key, g);
        });
    });

    const list = Array.from(groups.values()).sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || ''));

    if (!list.length) {
        container.innerHTML = '<div class="text-muted">No sales for the selected period.</div>';
        return;
    }

    const moneyStr = n => `$${money(n)}`;
    const frag = document.createDocumentFragment();

    list.forEach(g => {
        const fee = Number(g.cardFeeBase || 0) * 0.05;
        const rowsHtml = g.items
            .slice()
            .sort((a, b) => (a.datetime?.getTime?.() || 0) - (b.datetime?.getTime?.() || 0))
            .map(it => `
              <tr>
                <td>${it.datetime ? esc(new Date(it.datetime).toLocaleString()) : ''}</td>
                <td><a href="#" class="detail-receipt-link" data-id="${esc(String(it.number || ''))}">${esc(String(it.number || ''))}</a></td>
                <td>${esc(String(it.item || ''))}${it.qty > 1 ? `<div class="text-muted small">Qty: ${it.qty} @ $${money(it.unit)}</div>` : ''}</td>
                <td class="text-end">${esc(String(it.tender || ''))}</td>
                <td class="text-end">${moneyStr(it.amount)}</td>
              </tr>
            `).join('');

        const wrap = document.createElement('div');
        wrap.innerHTML = `
          <div class="border rounded p-3">
            <div class="d-flex justify-content-between align-items-baseline mb-2">
              <div><strong>${esc(g.code || '')}</strong> - ${esc(g.name || '')}</div>
              <div class="text-muted small">Items: ${g.count} | Gross: ${moneyStr(g.gross)}</div>
            </div>
            <div class="table-responsive">
              <table class="table table-sm table-striped mb-2">
                <thead class="table-light">
                  <tr>
                    <th>Date/Time</th>
                    <th>Receipt #</th>
                    <th>Item</th>
                    <th class="text-end">Tender</th>
                    <th class="text-end">Amount ($)</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml || '<tr><td colspan="5" class="text-muted">No items.</td></tr>'}</tbody>
              </table>
            </div>
            <div class="small">
              <strong>Totals:</strong>
              Cash ${moneyStr(g.cash)} |
              Card ${moneyStr(g.card)} |
              Check ${moneyStr(g.check)} |
              Gift ${moneyStr(g.gift)} |
              Other ${moneyStr(g.other)} |
              Gross ${moneyStr(g.gross)} |
              Items ${g.count} |
              Credit Fee (5% of Card) ${moneyStr(fee)}
            </div>
          </div>`;
        frag.appendChild(wrap.firstElementChild);
    });

    container.appendChild(frag);

    // click handlers for receipt links
    container.querySelectorAll('.detail-receipt-link').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.preventDefault();
            const id = el.getAttribute('data-id');
            if (!id) return;
            try {
                const r = await invoke('receipts:get', id);
                if (!r) { alert(`Receipt not found for id: ${id}`); return; }
                openReceiptWindowFromReports(r);
            } catch (err) {
                console.error('[reports] open receipt failed', err);
                alert('Open failed: ' + (err?.message || err));
            }
        });
    });
}

// lightweight receipt view window used by reports page
  function openReceiptWindowFromReports(r) {
      try {
          const toMoneyNumber = n => {
              const num = Number(n);
              return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
          };
          const isGiftCardSaleItem = it => {
              const name = String(it?.name || '').toLowerCase();
              return name.includes('gift card') || name.includes('giftcard');
          };
          const getGiftCardSaleTotal = receipt => {
              return (Array.isArray(receipt?.items) ? receipt.items : []).reduce((sum, it) => {
                  if (!isGiftCardSaleItem(it)) return sum;
                  const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
                  const unit = toMoneyNumber(it.price || 0);
                  return sum + toMoneyNumber(unit * qty);
              }, 0);
          };
          const isCardTenderSelected = (payment, splitEnabled, splitType) => {
              const main = String(payment || '');
              const split = String(splitType || '');
              return main === 'Card' || (splitEnabled && split === 'Card');
          };
          const deriveOriginalPrice = it => {
              if (typeof it?.originalPrice === 'number' && !Number.isNaN(it.originalPrice)) return toMoneyNumber(it.originalPrice);
              const price = toMoneyNumber(it?.price || 0);
              const discount = toMoneyNumber(it?.discountAmount || 0);
              return toMoneyNumber(price + discount);
          };
        const formatPercentText = value => {
            const pct = toMoneyNumber(value);
            if (pct <= 0) return '';
            const isWhole = Math.abs(pct - Math.round(pct)) < 0.01;
            return isWhole ? String(Math.round(pct)) : pct.toFixed(2).replace(/\.?0+$/, '');
        };
        const formatDiscountLabel = (type, value, amount) => {
            if (type === 'percent') {
                const pct = formatPercentText(value);
                return pct ? `${pct}% off` : '';
            }
            if (type === 'amount') {
                const amt = toMoneyNumber(amount || value);
                if (amt <= 0) return '';
                return `$${money(amt)} off`;
            }
            return '';
        };
        const buildDiscountSuffix = (type, value, amount, reason, escapeFn = s => s) => {
            const parts = [];
            const trimmed = String(reason || '').trim();
            if (trimmed) parts.push(escapeFn(trimmed));
            const label = formatDiscountLabel(type, value, amount);
            if (label) parts.push(escapeFn(label));
            return parts.length ? ` (${parts.join(', ')})` : '';
        };

        const returnQtyByKey = {};
        let returnSubtotal = 0;
        if (r.returned && r.returnInfo && Array.isArray(r.returnInfo.items)) {
            r.returnInfo.items.forEach(it => {
                const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
                const price = Number(it.price || 0);
                const key = [
                    String(it.name || '').trim().toLowerCase(),
                    price.toFixed(2),
                    String(it.vendorCode || it.vendor || '').trim().toLowerCase()
                ].join('|');
                returnQtyByKey[key] = (returnQtyByKey[key] || 0) + qty;
                returnSubtotal += qty * price;
            });
        }
          const taxRate = Number(r.taxRate || 0);
          const returnTax = r.taxExempt ? 0 : toMoneyNumber(returnSubtotal * taxRate);
          const returnTotal = toMoneyNumber(returnSubtotal + returnTax);
          const netTotal = toMoneyNumber((r.total || 0) - returnTotal);
          const cardFee = getGiftCardFeeForReceipt(r, getGiftCardSaleTotal(r));
          const cardFeeLine = cardFee > 0
              ? `<div style="display:flex; justify-content:space-between;"><div class="label">Card Fee (${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}%)</div><div><strong>$${money(cardFee)}</strong></div></div>`
              : '';

        const style = `
  <style>
    @page { size: Letter portrait; margin: 0.5in; }
    :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
    html,body{height:100%}
    body{margin:0;background:#fff;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
    .invoice{max-width:8.5in;margin:0 auto}
    .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:28px 34px}
    .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
    .brand-wrap{display:flex;gap:12px;align-items:center}
    .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
    .addr{color:var(--muted);font-size:12px;margin-top:2px}
    .title{font-size:18px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
    .meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 16px;margin-top:12px}
    .label{color:var(--muted)}
    table{width:100%;border-collapse:collapse;margin-top:16px}
    thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
    tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
    th.num, td.num{text-align:right}
    .actions{display:flex;justify-content:flex-end;margin:8px}
    .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
    @media print{ .actions{display:none} }
    ${getGreyscalePrintCss()}
  </style>`;

        const rowsHtml = (r.items || []).map((it, idx) => {
            const code = String(it.vendorCode || '').trim();
            const original = deriveOriginalPrice(it);
            const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
            const finalPrice = toMoneyNumber(it?.price || 0); // unit final
            const discountAmount = Math.max(0, toMoneyNumber(it?.discountAmount ?? (original - finalPrice)));
            const hasDiscount = discountAmount > 0;
            const type = hasDiscount ? (it?.discountType === 'percent' ? 'percent' : 'amount') : 'none';
            const value = hasDiscount ? (type === 'percent' ? toMoneyNumber(it?.discountValue || 0) : discountAmount) : 0;
            const reason = hasDiscount ? String(it?.discountReason || '').trim() : '';
            const discountSuffix = hasDiscount ? buildDiscountSuffix(type, value, discountAmount, reason, esc) : '';
            const itemKey = [
                String(it.name || '').trim().toLowerCase(),
                Number(it.price || 0).toFixed(2),
                String(it.vendorCode || it.vendor || '').trim().toLowerCase()
            ].join('|');
            const returnedQty = returnQtyByKey[itemKey] || 0;
            const keepQty = Math.max(0, qty - returnedQty);
            if (keepQty <= 0) return '';
            const amount = toMoneyNumber(finalPrice * keepQty);
            const strike = returnedQty >= qty && returnedQty > 0 ? ' style="text-decoration:line-through;"' : '';
            const returnedNote = returnedQty > 0 && r.returnInfo
                ? `<div class="addr" style="color:#16a34a;">Returned ${returnedQty}${qty > 1 ? ` of ${qty}` : ''}${r.returnInfo.when ? ` on ${new Date(r.returnInfo.when).toLocaleDateString()}` : ''}${r.returnInfo.user ? ` by ${esc(r.returnInfo.user)}` : ''}</div>`
                : '';
            return `
            <tr>
              <td>
                <div class="title"${strike}>${esc(it.name || '')}</div>
                ${it.comment ? `<div class="addr">${esc(it.comment)}</div>` : ''}
                ${code ? `<div class="addr">Vendor: ${esc(code)}</div>` : ''}
                ${keepQty > 1 ? `<div class="addr">Qty: ${keepQty} @ $${money(finalPrice)}</div>` : ''}
                ${hasDiscount ? `<div class="addr" style="text-decoration:line-through;">Original: $${money(original)}</div>` : ''}
                ${hasDiscount ? `<div class="addr" style="color:#dc3545;">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
                ${returnedNote}
              </td>
              <td class="num"${strike}>$${money(amount)}</td>
            </tr>`;
        }).filter(Boolean).join('');

        const returnMeta = r.returned
            ? `<div class="label">Returned</div>
               <div><strong>${esc(r.returnInfo?.reason || 'Return recorded')}</strong>
               ${r.returnInfo?.user ? ` - <span class="label">by ${esc(r.returnInfo.user)}</span>` : ''}
               ${r.returnInfo?.when ? ` <span class="label">on ${new Date(r.returnInfo.when).toLocaleString()}</span>` : ''}
               </div>`
            : '';

        const html = `
  <html>
    <head><meta charset="utf-8" /><title>${esc(r.number || r.id || 'Receipt')}</title>${style}</head>
    <body>
      <div class="invoice">
        <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
        <div class="sheet">
          <div class="hdr">
            <div class="brand-wrap">
              <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="44" height="44" style="border-radius:8px" />
              <div>
                <div class="brand">Middleton's Antiques &amp; Uniques</div>
                <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
              </div>
            </div>
            <div class="title">Sales Receipt</div>
          </div>
          <div class="meta">
            <div><div class="label">Receipt #</div><div><strong>${esc(r.number || r.id || '')}</strong></div></div>
            <div><div class="label">Date</div><div><strong>${esc(r.displayDate || (r.datetime ? new Date(r.datetime).toLocaleString() : ''))}</strong></div></div>
            <div><div class="label">Cashier</div><div><strong>${esc(r.cashier || '-')}</strong></div></div>
            <div><div class="label">Payment</div><div><strong>${esc(r.payment || '-')}</strong></div></div>
            ${returnMeta}
          </div>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Amount</th>
              </tr>
            </thead>
            <tbody>${rowsHtml || '<tr><td colspan="2" class="label">No items</td></tr>'}</tbody>
          </table>
          <div class="meta" style="grid-template-columns: 1fr 1fr; margin-top:12px">
            <div></div>
            <div>
              <div style="display:flex; justify-content:space-between;"><div class="label">Subtotal</div><div><strong>$${money(r.subtotal || 0)}</strong></div></div>
              <div style="display:flex; justify-content:space-between;"><div class="label">Tax</div><div><strong>$${money(r.tax || 0)}</strong></div></div>
              ${cardFeeLine}
              <div style="display:flex; justify-content:space-between;"><div class="label" style="font-weight:800">Total</div><div><strong>$${money(r.total || 0)}</strong></div></div>
              ${r.returned && returnTotal > 0 ? `
              <div style="display:flex; justify-content:space-between;"><div class="label">Return Subtotal</div><div><strong>-$${money(returnSubtotal)}</strong></div></div>
              <div style="display:flex; justify-content:space-between;"><div class="label">Return Tax</div><div><strong>-$${money(returnTax)}</strong></div></div>
              <div style="display:flex; justify-content:space-between;"><div class="label">Return Total</div><div><strong>-$${money(returnTotal)}</strong></div></div>
              <div style="display:flex; justify-content:space-between;"><div class="label" style="font-weight:800">Net Total</div><div><strong>$${money(netTotal)}</strong></div></div>` : ''}
            </div>
          </div>
        </div>
      </div>
    </body>
  </html>`;

        const w = window.open('', '', 'width=1024,height=1100');
        w.document.write(html);
        try { applyBrandingToReportWindow(w); } catch (_) { }
        w.document.close();
        try { applyBrandingToReportWindow(w); } catch (_) { }
    } catch (e) {
        console.error('[reports] render receipt view failed', e);
        alert('Open failed: ' + (e?.message || e));
    }
}


// Print Detailed: cover page + vendors, each on its own page
function printDetailedReport() {
    try {
        const fromVal = document.getElementById('fromDate')?.value;
        const toVal = document.getElementById('toDate')?.value;
        const vendorFilterVal = (document.getElementById('vendorFilter')?.value || '').trim().toLowerCase();
        const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
        const to = toVal ? new Date(toVal + 'T23:59:59') : null;

        // Group by vendor (code if present; otherwise vendor name)
        const groups = new Map();
        receipts.forEach(r => {
            if (r.voided) return;
            const when = r.datetime ? new Date(r.datetime) : null;
            if (from && when && when < from) return;
            if (to && when && when > to) return;
            const tender = normalizeTender(r.payment);
            (r.items || []).forEach(it => {
                const vendorKey = String(it.vendorCode || it.vendor || '').trim().toLowerCase();
                if (vendorFilterVal) {
                    if (vendorFilterVal === '__unassigned') {
                        if (vendorKey) return;
                    } else if (vendorKey !== vendorFilterVal) {
                        return;
                    }
                }
                const code = String(it.vendorCode || '').trim();
                let key = code, name = '';
                if (code) {
                    const v = vendorByCode.get(code.toLowerCase());
                    name = v?.name || '';
                } else {
                    name = String(it.vendor || '').trim();
                    key = name || '(Unassigned)';
                }
                let g = groups.get(key);
                if (!g) g = { code: code || '', name, cash: 0, card: 0, cardFeeBase: 0, check: 0, gift: 0, other: 0, gross: 0, count: 0, items: [] };
                const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
                const unit = Number(it.price || 0);
                const amount = unit * qty;
                g.gross += amount; g.count += qty;
                const isGiftSale = isGiftCardSaleItem(it);
                if (tender === 'Cash') g.cash += amount;
                else if (tender === 'Card') {
                    g.card += amount;
                    if (!isGiftSale) g.cardFeeBase += amount;
                }
                else if (tender === 'Check') g.check += amount;
                else if (tender === 'Gift Card') g.gift += amount;
                else g.other += amount;
                if (!g.name && name) g.name = name;
                g.items.push({ datetime: when, number: r.number || '', item: it.name || '', qty, unit, amount, tender });
                groups.set(key, g);
            });
        });

        const list = Array.from(groups.values()).sort((a, b) => (a.name || a.code || '').localeCompare(b.name || b.code || ''));

        const style = `
      <style>
        @page { size: Letter portrait; margin: 0.5in; }
        :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
        html,body{height:100%}
        body{margin:0;background:#f3f4f6;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .doc{max-width:8.5in;margin:0 auto}
        .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:24px 28px; page-break-after: always;}
        .sheet:last-child{ page-break-after: auto; }
        .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
        .brand-wrap{display:flex;gap:12px;align-items:center}
        .logo{width:44px;height:44px;border-radius:8px}
        .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
        .addr{color:var(--muted);font-size:12px;margin-top:2px}
        .title{font-size:22px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
        .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-top:12px}
        .label{color:var(--muted)}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
        tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
        th.num, td.num{text-align:right}
        .actions{display:flex;justify-content:flex-end;margin:8px}
        .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
        @media print{ .actions{display:none} }
      </style>`;

        const moneyStr = n => `$${money(n)}`;

        // Cover page with period and totals
        const agg = list.reduce((a, b) => ({
            cash: a.cash + b.cash,
            card: a.card + b.card,
            cardFeeBase: a.cardFeeBase + b.cardFeeBase,
            check: a.check + b.check,
            gift: a.gift + b.gift,
            other: a.other + b.other,
            gross: a.gross + b.gross,
            count: a.count + b.count
        }), { cash: 0, card: 0, cardFeeBase: 0, check: 0, gift: 0, other: 0, gross: 0, count: 0 });
        const period = (fromVal || toVal) ? `${fromVal || '-'} to ${toVal || '-'}` : 'All Dates';
        const aggFee = Number(agg.cardFeeBase) * 0.05;
        const cover = `
        <div class="sheet">
          <div class="hdr">
            <div class="brand-wrap">
              <img src="assets/MiddletonsStoreFrontLogoBW.png" class="logo" alt="Logo" />
              <div>
                <div class="brand">Middleton's Antiques &amp; Uniques</div>
                <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
              </div>
            </div>
            <div class="title">Detailed Sales by Vendor</div>
          </div>
          <div class="meta">
            <div><div class="label">Period</div><div><strong>${esc(period)}</strong></div></div>
            <div><div class="label">Generated</div><div><strong>${new Date().toLocaleString()}</strong></div></div>
            <div><div class="label">Vendors</div><div><strong>${list.length}</strong></div></div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Total Cash</th>
                <th>Total Card</th>
                <th>Total Check</th>
                <th>Total Gift</th>
                <th>Total Other</th>
                <th>Total Gross</th>
                <th>Total Items</th>
                <th>Total Credit Fee (5% of Card)</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td class="num">${moneyStr(agg.cash)}</td>
                <td class="num">${moneyStr(agg.card)}</td>
                <td class="num">${moneyStr(agg.check)}</td>
                <td class="num">${moneyStr(agg.gift)}</td>
                <td class="num">${moneyStr(agg.other)}</td>
                <td class="num">${moneyStr(agg.gross)}</td>
                <td class="num">${agg.count}</td>
                <td class="num">${moneyStr(aggFee)}</td>
              </tr>
            </tbody>
          </table>
        </div>`;

        // Vendor pages
        const vendorSheets = list.map(g => {
            const fee = Number(g.cardFeeBase || 0) * 0.05;
            const rowsHtml = g.items.length ? g.items.map(it => `
              <tr>
                <td>${it.datetime ? esc(new Date(it.datetime).toLocaleString()) : ''}</td>
                <td>${esc(String(it.number || ''))}</td>
                <td>${esc(String(it.item || ''))}${it.qty > 1 ? `<div class="muted">Qty: ${it.qty} @ $${money(it.unit)}</div>` : ''}</td>
                <td class="num">${esc(String(it.tender || ''))}</td>
                <td class="num">${moneyStr(it.amount)}</td>
              </tr>`).join('') : `<tr><td colspan="5" class="label">No items.</td></tr>`;

            return `
            <div class="sheet">
              <div class="hdr">
                <div class="brand-wrap">
                  <img src="assets/MiddletonsStoreFrontLogoBW.png" class="logo" alt="Logo"/>
                  <div>
                    <div class="brand">Middleton's Antiques &amp; Uniques</div>
                    <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
                  </div>
                </div>
                <div class="title">${esc(g.code || '')} — ${esc(g.name || '')}</div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Date/Time</th>
                    <th>Receipt #</th>
                    <th>Item</th>
                    <th class="num">Tender</th>
                    <th class="num">Amount ($)</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
              <div class="meta" style="grid-template-columns: repeat(4,1fr)">
                <div><div class="label">Cash</div><div><strong>${moneyStr(g.cash)}</strong></div></div>
                <div><div class="label">Card</div><div><strong>${moneyStr(g.card)}</strong></div></div>
                <div><div class="label">Check</div><div><strong>${moneyStr(g.check)}</strong></div></div>
                <div><div class="label">Gift</div><div><strong>${moneyStr(g.gift)}</strong></div></div>
                <div><div class="label">Other</div><div><strong>${moneyStr(g.other)}</strong></div></div>
                <div><div class="label">Gross</div><div><strong>${moneyStr(g.gross)}</strong></div></div>
                <div><div class="label">Items</div><div><strong>${g.count}</strong></div></div>
                <div><div class="label">Credit Fee (5% of Card)</div><div><strong>${moneyStr(fee)}</strong></div></div>
              </div>
            </div>`;
        }).join('');

        const html = `
        <html>
          <head><meta charset="utf-8" /><title>Detailed Sales by Vendor</title>${style}</head>
          <body>
            <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
            <div class="doc">${cover}${vendorSheets}</div>
          </body>
        </html>`;

        const w = window.open('', '', 'width=960,height=900');
        w.document.write(html);
        try { applyBrandingToReportWindow(w); } catch (_) { }
        w.document.close();
        try { w.focus(); } catch (_) { }
    } catch (err) {
        console.error('[reports] detailed print failed', err);
        alert('Print failed: ' + (err?.message || err));
    }
}

function exportCSV() {
    const tbody = document.getElementById('reportBody');
    const rows = [['Vendor Code', 'Vendor Name', 'Cash ($)', 'Card ($)', 'Check ($)', 'Gift Card ($)', 'Other ($)', 'Gross ($)', 'Items']];
    for (const tr of tbody.querySelectorAll('tr')) {
        const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/^\$/, ''));
        rows.push(tds);
    }
    rows.push(['', 'Totals',
        document.getElementById('totCash').textContent.replace('$', ''),
        document.getElementById('totCard').textContent.replace('$', ''),
        document.getElementById('totCheck').textContent.replace('$', ''),
        document.getElementById('totGift').textContent.replace('$', ''),
        document.getElementById('totOther').textContent.replace('$', ''),
        document.getElementById('grandTotal').textContent.replace('$', ''),
        document.getElementById('grandCount').textContent
    ]);

    const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `sales_per_vendor_by_tender_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); URL.revokeObjectURL(url); a.remove();
}

function clearTaxExemptReport() {
    taxExemptRows = [];
    const tbody = document.getElementById('taxExemptBody');
    if (tbody) tbody.innerHTML = '';
    const subtotalEl = document.getElementById('taxExemptSubtotalTotal');
    const taxEl = document.getElementById('taxExemptTaxTotal');
    const totalEl = document.getElementById('taxExemptGrandTotal');
    if (subtotalEl) subtotalEl.textContent = '$0.00';
    if (taxEl) taxEl.textContent = '$0.00';
    if (totalEl) totalEl.textContent = '$0.00';
    const countEl = document.getElementById('taxExemptCount');
    if (countEl) countEl.textContent = 'Receipts: 0';
}

function runTaxExemptReport() {
    if (!__managerMode) {
        clearTaxExemptReport();
        return;
    }
    const fromVal = document.getElementById('taxExemptFromDate')?.value;
    const toVal = document.getElementById('taxExemptToDate')?.value;
    const from = fromVal ? new Date(fromVal + 'T00:00:00') : null;
    const to = toVal ? new Date(toVal + 'T23:59:59') : null;

    const rows = [];

    receipts.forEach(r => {
        if (r.voided) return;
        if (!r.taxExempt) return;
        const when = getReceiptEffectiveDate(r);
        if (from && when && when < from) return;
        if (to && when && when > to) return;

        let returnSubtotal = 0;
        if (r.returned && r.returnInfo && Array.isArray(r.returnInfo.items)) {
            r.returnInfo.items.forEach(it => {
                const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
                const price = Number(it.price || 0);
                returnSubtotal += qty * price;
            });
        }
        const taxRate = Number(r.taxRate || 0);
        const returnTax = r.taxExempt ? 0 : toMoneyNumber(returnSubtotal * taxRate);
        const returnTotal = toMoneyNumber(returnSubtotal + returnTax);
        const netSubtotal = toMoneyNumber((r.subtotal || 0) - returnSubtotal);
        const netTax = toMoneyNumber((r.tax || 0) - returnTax);
        const netTotal = toMoneyNumber((r.total || 0) - returnTotal);

        rows.push({
            when,
            displayDate: r.displayDate || (r.datetime ? new Date(r.datetime).toLocaleString() : ''),
            number: r.number || r.id || '',
            name: r.taxExemptName || '',
            id: r.taxExemptId || '',
            cashier: r.cashier || '',
            payment: r.payment || '',
            subtotal: netSubtotal,
            tax: netTax,
            total: netTotal,
            taxRate
        });
    });

    rows.sort((a, b) => (a.when?.getTime?.() || 0) - (b.when?.getTime?.() || 0));
    taxExemptRows = rows;

    const tbody = document.getElementById('taxExemptBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const frag = document.createDocumentFragment();

    let subtotalTotal = 0;
    let taxTotal = 0;
    let grandTotal = 0;

    rows.forEach(r => {
        subtotalTotal += r.subtotal;
        taxTotal += r.tax;
        grandTotal += r.total;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${esc(r.displayDate || '')}</td>
          <td>${esc(r.number || '')}</td>
          <td>${esc(r.name || '')}</td>
          <td>${esc(r.id || '')}</td>
          <td>${esc(r.cashier || '')}</td>
          <td>${esc(r.payment || '')}</td>
          <td class="text-end">$${money(r.subtotal)}</td>
          <td class="text-end">$${money(r.tax)}</td>
          <td class="text-end">$${money(r.total)}</td>
          <td class="text-end">${(r.taxRate * 100).toFixed(2)}</td>
        `;
        frag.appendChild(tr);
    });

    if (!rows.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="10" class="text-muted">No tax exempt sales for the selected period.</td>';
        frag.appendChild(tr);
    }

    tbody.appendChild(frag);
    const subtotalEl = document.getElementById('taxExemptSubtotalTotal');
    const taxEl = document.getElementById('taxExemptTaxTotal');
    const totalEl = document.getElementById('taxExemptGrandTotal');
    if (subtotalEl) subtotalEl.textContent = `$${money(subtotalTotal)}`;
    if (taxEl) taxEl.textContent = `$${money(taxTotal)}`;
    if (totalEl) totalEl.textContent = `$${money(grandTotal)}`;
    const countEl = document.getElementById('taxExemptCount');
    if (countEl) countEl.textContent = `Receipts: ${rows.length}`;
}

function exportTaxExemptCSV() {
    if (!__managerMode) return;
    const rows = [['Date/Time', 'Receipt #', 'Purchaser/Organization', 'Tax Exempt ID', 'Cashier', 'Payment', 'Subtotal', 'Tax', 'Total', 'Tax Rate (%)']];
    taxExemptRows.forEach(r => {
        rows.push([
            r.displayDate || '',
            r.number || '',
            r.name || '',
            r.id || '',
            r.cashier || '',
            r.payment || '',
            money(r.subtotal),
            money(r.tax),
            money(r.total),
            (r.taxRate * 100).toFixed(2)
        ]);
    });
    rows.push([
        '',
        '',
        '',
        '',
        '',
        'Totals',
        money(taxExemptRows.reduce((sum, r) => sum + r.subtotal, 0)),
        money(taxExemptRows.reduce((sum, r) => sum + r.tax, 0)),
        money(taxExemptRows.reduce((sum, r) => sum + r.total, 0)),
        ''
    ]);

    const csv = rows.map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tax_exempt_sales_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(url);
    a.remove();
}

function printTaxExemptReport() {
    if (!__managerMode) return;
    try {
        const fromVal = document.getElementById('taxExemptFromDate')?.value;
        const toVal = document.getElementById('taxExemptToDate')?.value;
        const period = (fromVal || toVal) ? `${fromVal || ''} to ${toVal || ''}` : 'All Dates';

        const style = `
      <style>
        @page { size: Letter portrait; margin: 0.5in; }
        :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
        html,body{height:100%}
        body{margin:0;background:#f3f4f6;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .doc{max-width:8.5in;margin:0 auto}
        .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:28px 34px}
        .actions{display:flex;justify-content:flex-end;margin-bottom:8px}
        .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
        .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
        .brand-wrap{display:flex;gap:12px;align-items:center}
        .logo{width:44px;height:44px;border-radius:8px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
        .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
        .addr{color:var(--muted);font-size:12px;margin-top:2px}
        .title{font-size:22px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
        .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-top:12px}
        .label{color:var(--muted)}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
        tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
        th.num, td.num{text-align:right}
        tfoot th, tfoot td{padding:10px 8px;border-top:2px solid var(--border)}
        .totrow th{font-weight:800}
        @media print{ body{background:#fff} .sheet{margin:0;box-shadow:none} .actions{display:none} }
      </style>`;

        const tableRows = taxExemptRows.length
            ? taxExemptRows.map(r => `
                <tr>
                  <td>${esc(r.displayDate || '')}</td>
                  <td>${esc(r.number || '')}</td>
                  <td>${esc(r.name || '')}</td>
                  <td>${esc(r.id || '')}</td>
                  <td>${esc(r.cashier || '')}</td>
                  <td>${esc(r.payment || '')}</td>
                  <td class="num">$${money(r.subtotal)}</td>
                  <td class="num">$${money(r.tax)}</td>
                  <td class="num">$${money(r.total)}</td>
                  <td class="num">${(r.taxRate * 100).toFixed(2)}</td>
                </tr>`).join('')
            : `<tr><td colspan="10" class="label">No tax exempt sales for the selected period.</td></tr>`;

        const subtotalTotal = taxExemptRows.reduce((sum, r) => sum + r.subtotal, 0);
        const taxTotal = taxExemptRows.reduce((sum, r) => sum + r.tax, 0);
        const grandTotal = taxExemptRows.reduce((sum, r) => sum + r.total, 0);

        const html = `
        <html>
          <head><meta charset="utf-8" /><title>Tax Exempt Sales</title>${style}</head>
          <body>
            <div class="doc">
              <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
              <div class="sheet">
                <div class="hdr">
                  <div class="brand-wrap">
                    <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="44" height="44" style="border-radius:8px" />
                    <div>
                      <div class="brand">Middleton's Antiques &amp; Uniques</div>
                      <div class="addr">1615 S 17th St, Lincoln, NE 68502 - 531-500-0135</div>
                    </div>
                  </div>
                  <div class="title">Tax Exempt Sales</div>
                </div>
                <div class="meta">
                  <div><div class="label">Period</div><div><strong>${esc(period)}</strong></div></div>
                  <div><div class="label">Generated</div><div><strong>${new Date().toLocaleString()}</strong></div></div>
                  <div><div class="label">Receipts</div><div><strong>${taxExemptRows.length}</strong></div></div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Date/Time</th>
                      <th>Receipt #</th>
                      <th>Purchaser / Organization</th>
                      <th>Tax Exempt ID</th>
                      <th>Cashier</th>
                      <th>Payment</th>
                      <th class="num">Subtotal ($)</th>
                      <th class="num">Tax ($)</th>
                      <th class="num">Total ($)</th>
                      <th class="num">Tax Rate (%)</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows}</tbody>
                  <tfoot>
                    <tr class="totrow">
                      <th colspan="6" class="num">Totals</th>
                      <td class="num">$${money(subtotalTotal)}</td>
                      <td class="num">$${money(taxTotal)}</td>
                      <td class="num">$${money(grandTotal)}</td>
                      <td class="num">-</td>
                    </tr>
                  </tfoot>
                </table>
                <div class="label" style="margin-top:12px">Nebraska tax exempt sales report.</div>
              </div>
            </div>
          </body>
        </html>`;

        const w = window.open('', '', 'width=960,height=900');
        w.document.write(html);
        try { applyBrandingToReportWindow(w); } catch (_) { }
        w.document.close();
    } catch (err) {
        console.error('[reports] tax exempt print failed', err);
        alert('Print failed: ' + (err?.message || err));
    }
}



// Expose for inline use/debug
window.runReport = runReport;
window.exportCSV = exportCSV;
function printReport() {
    try {
        const tbody = document.getElementById('reportBody');
        const rows = [...tbody.querySelectorAll('tr')].map(tr => {
            const t = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
            return {
                code: t[0] || '',
                name: t[1] || '',
                cash: t[2] || '',
                card: t[3] || '',
                check: t[4] || '',
                gift: t[5] || '',
                other: t[6] || '',
                gross: t[7] || '',
                count: t[8] || '',
                cardFeeBase: Number(tr.dataset.cardFeeBase || 0)
            };
        });

        const fromVal = document.getElementById('fromDate').value;
        const toVal = document.getElementById('toDate').value;
        const period = (fromVal || toVal) ? `${fromVal || '—'} to ${toVal || '—'}` : 'All Dates';

        const totCash = document.getElementById('totCash').textContent;
        const totCard = document.getElementById('totCard').textContent;
        const totCheck = document.getElementById('totCheck').textContent;
        const totGift = document.getElementById('totGift').textContent;
        const totOther = document.getElementById('totOther').textContent;
        const grandTotal = document.getElementById('grandTotal').textContent;
        const grandCount = document.getElementById('grandCount').textContent;

        const style = `
      <style>
        @page { size: Letter portrait; margin: 0.5in; }
        :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
        html,body{height:100%}
        body{margin:0;background:#f3f4f6;color:var(--ink);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;}
        .doc{max-width:8.5in;margin:0 auto}
        .sheet{background:#fff;margin:20px;box-shadow:0 2px 10px rgba(0,0,0,.08);padding:28px 34px}
        .actions{display:flex;justify-content:flex-end;margin-bottom:8px}
        .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 12px;font-size:12px;cursor:pointer}
        .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
        .brand-wrap{display:flex;gap:12px;align-items:center}
        .logo{width:44px;height:44px;border-radius:8px;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800}
        .brand{font-weight:800;font-size:20px;letter-spacing:.2px}
        .addr{color:var(--muted);font-size:12px;margin-top:2px}
        .title{font-size:22px;font-weight:800;letter-spacing:.3px;color:var(--emph)}
        .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin-top:12px}
        .label{color:var(--muted)}
        table{width:100%;border-collapse:collapse;margin-top:16px}
        thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
        tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
        th.num, td.num{text-align:right}
        tfoot th, tfoot td{padding:10px 8px;border-top:2px solid var(--border)}
        .totrow th{font-weight:800}
        @media print{ body{background:#fff} .sheet{margin:0;box-shadow:none} .actions{display:none} }
      </style>`;

        const tableRows = rows.length
            ? rows.map(r => `
                <tr>
                  <td>${esc(r.code)}</td>
                  <td>${esc(r.name)}</td>
                  <td class="num">${esc(r.cash)}</td>
                  <td class="num">${esc(r.card)}</td>
                  <td class="num">${esc(r.check)}</td>
                  <td class="num">${esc(r.gift)}</td>
                  <td class="num">${esc(r.other)}</td>
                  <td class="num">${esc(r.gross)}</td>
                  <td class="num">${esc(r.count)}</td>
                </tr>`).join('')
            : `<tr><td colspan="9" class="label">No sales for the selected period.</td></tr>`;

        // Build card fee rows (5% of card). Parse numbers from strings that may include $ and commas.
        const num = (s) => Number(String(s || '').replace(/[^\d.\-]/g, '')) || 0;
        const feeRows = rows
            .map(r => ({ code: r.code, name: r.name, card: r.cardFeeBase || num(r.card) }))
            .filter(r => r.card > 0)
            .map(r => ({ ...r, fee: r.card * 0.05 }));
        const feeTotCard = feeRows.reduce((a, b) => a + b.card, 0);
        const feeTotAmt = feeRows.reduce((a, b) => a + b.fee, 0);
        const feeTableRows = feeRows.length
            ? feeRows.map(r => `
                <tr>
                  <td>${esc(r.code || '')}</td>
                  <td>${esc(r.name || '')}</td>
                  <td class="num">$${money(r.card)}</td>
                  <td class="num">$${money(r.fee)}</td>
                </tr>`).join('')
            : `<tr><td colspan="4" class="label">No credit card sales for the selected period.</td></tr>`;

        const html = `
        <html>
          <head><meta charset="utf-8" /><title>Vendor Payout Summary</title>${style}</head>
          <body>
            <div class="doc">
              <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
              <div class="sheet">
                <div class="hdr">
                  <div class="brand-wrap">
                    <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="44" height="44" style="border-radius:8px" />
                    <div>
                      <div class="brand">Middleton's Antiques &amp; Uniques</div>
                      <div class="addr">1615 S 17th St, Lincoln, NE 68502 · 531-500-0135</div>
                    </div>
                  </div>
                  <div class="title">Vendor Payout Summary</div>
                </div>
                <div class="meta">
                  <div><div class="label">Period</div><div><strong>${esc(period)}</strong></div></div>
                  <div><div class="label">Generated</div><div><strong>${new Date().toLocaleString()}</strong></div></div>
                  <div><div class="label">Vendors</div><div><strong>${rows.length}</strong></div></div>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Vendor Code</th>
                      <th>Vendor Name</th>
                      <th class="num">Cash ($)</th>
                      <th class="num">Card ($)</th>
                      <th class="num">Check ($)</th>
                      <th class="num">Gift Card ($)</th>
                      <th class="num">Other ($)</th>
                      <th class="num">Gross ($)</th>
                      <th class="num"># Items</th>
                    </tr>
                  </thead>
                  <tbody>${tableRows}</tbody>
                  <tfoot>
                    <tr class="totrow">
                      <th colspan="2" class="num">Totals</th>
                      <td class="num">${esc(totCash)}</td>
                      <td class="num">${esc(totCard)}</td>
                      <td class="num">${esc(totCheck)}</td>
                      <td class="num">${esc(totGift)}</td>
                      <td class="num">${esc(totOther)}</td>
                      <td class="num">${esc(grandTotal)}</td>
                      <td class="num">${esc(grandCount)}</td>
                    </tr>
                  </tfoot>
                </table>
                <div style="height:10px"></div>
                <div class="title" style="font-size:16px; margin-top:12px">Credit Card Processing Fee (5% of Gross Card Sales)</div>
                <table>
                  <thead>
                    <tr>
                      <th>Vendor Code</th>
                      <th>Vendor Name</th>
                      <th class="num">Card ($)</th>
                      <th class="num">5% Fee ($)</th>
                    </tr>
                  </thead>
                  <tbody>${feeTableRows}</tbody>
                  <tfoot>
                    <tr class="totrow">
                      <th colspan="2" class="num">Totals</th>
                      <td class="num">$${money(feeTotCard)}</td>
                      <td class="num">$${money(feeTotAmt)}</td>
                    </tr>
                  </tfoot>
                </table>
                <div class="label" style="margin-top:12px">Payouts are based on gross sales by vendor for the selected period.</div>
              </div>
            </div>
          </body>
        </html>`;

        const w = window.open('', '', 'width=960,height=900');
        w.document.write(html);
        try {
            const txt = '1615 S 17th St, Lincoln, NE 68502 · 531-500-0135';
            const nodes = w.document.querySelectorAll('.addr, .addr.muted, #rcpt-address');
            nodes.forEach(n => n.textContent = txt);
        } catch (_) { }
        w.document.close();
    } catch (err) {
        console.error('[reports] print failed', err);
        alert('Print failed: ' + (err?.message || err));
    }
}

// Attach handlers ASAP; then init (so clicks always work even if init fails)
window.addEventListener('DOMContentLoaded', () => {
    const runBtn = document.getElementById('runBtn');
    const expBtn = document.getElementById('exportBtn');
    const prnBtn = document.getElementById('printBtn');
    const prnDetBtn = document.getElementById('printDetailBtn');
    const clearBtn = document.getElementById('clearFiltersBtn');
    const bkpBtn = document.getElementById('backupBtn');
    const rstBtn = document.getElementById('restoreBtn');
    const todayBtn = document.getElementById('todayBtn');
    const yesterdayBtn = document.getElementById('yesterdayBtn');
    const monthBtn = document.getElementById('currentMonthBtn');
    const taxRunBtn = document.getElementById('taxExemptRunBtn');
    const taxClearBtn = document.getElementById('taxExemptClearBtn');
    const taxExportBtn = document.getElementById('taxExemptExportBtn');
    const taxPrintBtn = document.getElementById('taxExemptPrintBtn');

    // Developer-mode visibility toggle for backup/restore buttons
    const setDevVisibility = (isDev) => {
        const on = !!isDev;
        try {
            if (bkpBtn) bkpBtn.classList.toggle('d-none', !on);
        } catch (_) { }
        try {
            if (rstBtn) rstBtn.classList.toggle('d-none', !on);
        } catch (_) { }
    };
    // Initial settings fetch
    try {
        invoke('settings:load').then(s => {
            try { setDevVisibility(!!s?.developerMode); } catch (_) { }
            try {
                branding = {
                    bizName: String(s?.bizName || branding.bizName),
                    bizAddress: String(s?.bizAddress || branding.bizAddress),
                    bizPhone: String(s?.bizPhone || branding.bizPhone),
                    logoPath: String(s?.logoPath || '')
                };
            } catch (_) { }
            __greyscalePrint = !!s?.greyscalePrint;
            const rate = Number(s?.giftCardSurchargeRate);
            if (!isNaN(rate) && rate >= 0 && rate <= 1) GIFT_CARD_SURCHARGE_RATE = rate;
        }).catch(() => {});
    } catch (_) { }
    // Live updates
    try {
        api?.on?.('settings:changed', (_evt, payload) => {
            try { setDevVisibility(!!payload?.developerMode); } catch (_) { }
            try {
                if (payload) {
                    branding = {
                        bizName: String(payload.bizName || branding.bizName),
                        bizAddress: String(payload.bizAddress || branding.bizAddress),
                        bizPhone: String(payload.bizPhone || branding.bizPhone),
                        logoPath: String(payload.logoPath || branding.logoPath || '')
                    };
                }
            } catch (_) { }
            if (typeof payload?.greyscalePrint === 'boolean') {
                __greyscalePrint = !!payload.greyscalePrint;
            }
            const rate = Number(payload?.giftCardSurchargeRate);
            if (!isNaN(rate) && rate >= 0 && rate <= 1) GIFT_CARD_SURCHARGE_RATE = rate;
        });
    } catch (_) { }

    if (runBtn) {
        const onClickRun = () => { console.log('[reports] Run button clicked'); try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); } };
        runBtn.addEventListener('click', onClickRun);
    }
    if (expBtn) {
        const onClickExport = () => { console.log('[reports] Export button clicked'); try { exportCSV(); } catch (e) { console.error(e); alert('Export failed: ' + (e?.message || e)); } };
        expBtn.addEventListener('click', onClickExport);
    }
    if (prnBtn) {
        const onClickPrint = () => { console.log('[reports] Print button clicked'); try { printReport(); } catch (e) { console.error(e); alert('Print failed: ' + (e?.message || e)); } };
        prnBtn.addEventListener('click', onClickPrint);
    }
    if (prnDetBtn) {
        const onClickPrintDet = () => { console.log('[reports] Print detailed clicked'); try { printDetailedReport(); } catch (e) { console.error(e); alert('Print failed: ' + (e?.message || e)); } };
        prnDetBtn.addEventListener('click', onClickPrintDet);
    }
    if (clearBtn) {
        const onClickClear = () => {
            console.log('[reports] Clear filters clicked');
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), 1);
            const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const fromEl = document.getElementById('fromDate');
            const toEl = document.getElementById('toDate');
            const vendorEl = document.getElementById('vendorFilter');
            if (fromEl) fromEl.value = fmtLocal(from);
            if (toEl) toEl.value = fmtLocal(to);
            if (vendorEl) vendorEl.value = '';
            try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        };
        clearBtn.addEventListener('click', onClickClear);
    }
    if (bkpBtn) {
        const onClickBackup = async () => {
            try {
                if (hasIpc) {
                    const res = await invoke('data:export');
                    if (res?.ok) alert(`Backup saved.\n\nPath: ${res.path}\nVendors: ${res.counts.vendors}\nCashiers: ${res.counts.cashiers}\nReceipts: ${res.counts.receipts}`);
                    else if (!res?.canceled) alert('Backup failed: ' + (res?.error || 'Unknown error'));
                    return;
                }
                const data = await invoke('data:export');
                const stamp = new Date().toISOString().slice(0, 10);
                const filename = `middletons-backup-${stamp}.json`;
                const blob = new Blob([JSON.stringify(data || {}, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename;
                document.body.appendChild(link);
                link.click();
                link.remove();
                URL.revokeObjectURL(url);
                showToast('Backup downloaded.', { type: 'success' });
            } catch (e) {
                console.error(e); alert('Backup failed: ' + (e?.message || e));
            }
        };
        bkpBtn.addEventListener('click', onClickBackup);
    }
    if (rstBtn) {
        const onClickRestore = async () => {
            if (!confirm('Importing a backup will overwrite current data. Continue?')) return;
            try {
                if (hasIpc) {
                    const res = await invoke('data:import');
                    if (res?.ok) {
                        alert(`Import complete.\nVendors: ${res.counts.vendors}\nCashiers: ${res.counts.cashiers}\nReceipts: ${res.counts.receipts}`);
                        await initReports();
                    } else if (!res?.canceled) {
                        alert('Import failed: ' + (res?.error || 'Unknown error'));
                    }
                    return;
                }
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,application/json';
                input.addEventListener('change', async () => {
                    const file = input.files && input.files[0];
                    if (!file) return;
                    const text = await file.text();
                    const payload = JSON.parse(text);
                    const res = await invoke('data:import', payload);
                    if (res?.ok) {
                        showToast('Import complete.', { type: 'success' });
                        await initReports();
                    } else {
                        alert('Import failed: ' + (res?.error || 'Unknown error'));
                    }
                }, { once: true });
                input.click();
            } catch (e) {
                console.error(e); alert('Import failed: ' + (e?.message || e));
            }
        };
        rstBtn.addEventListener('click', onClickRestore);
    }

    // Quick Filters
    const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const setRange = (from, to) => {
        const fromEl = document.getElementById('fromDate');
        const toEl = document.getElementById('toDate');
        if (fromEl) fromEl.value = fmtLocal(from);
        if (toEl) toEl.value = fmtLocal(to);
    };
    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            const now = new Date();
            const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            setRange(start, start);
            try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }
    if (yesterdayBtn) {
        yesterdayBtn.addEventListener('click', () => {
            const now = new Date();
            const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
            setRange(yesterday, yesterday);
            try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }
    if (monthBtn) {
        monthBtn.addEventListener('click', () => {
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), 1);
            const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            setRange(from, to);
            try { runReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }

    if (taxRunBtn) {
        taxRunBtn.addEventListener('click', () => {
            try { runTaxExemptReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }
    if (taxClearBtn) {
        taxClearBtn.addEventListener('click', () => {
            setDateRangeToCurrentMonth('taxExemptFromDate', 'taxExemptToDate');
            try { runTaxExemptReport(); } catch (e) { console.error(e); alert('Run failed: ' + (e?.message || e)); }
        });
    }
    if (taxExportBtn) {
        taxExportBtn.addEventListener('click', () => {
            try { exportTaxExemptCSV(); } catch (e) { console.error(e); alert('Export failed: ' + (e?.message || e)); }
        });
    }
    if (taxPrintBtn) {
        taxPrintBtn.addEventListener('click', () => {
            try { printTaxExemptReport(); } catch (e) { console.error(e); alert('Print failed: ' + (e?.message || e)); }
        });
    }

    syncManagerModeUI();
});

// Initialize data after full load; do NOT call something named `bootstrap` here
window.addEventListener('load', async () => {
    try {
        await initReports();
        console.log('[reports] init complete');
    } catch (err) {
        console.error('[reports] init failed:', err);
        alert('Reports init failed: ' + (err?.message || err));
        // Continue with empty arrays so the UI still works
    }
});

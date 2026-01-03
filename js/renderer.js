// renderer.js
const api = (typeof window !== 'undefined' && window.MiddletonsApiClient)
  ? window.MiddletonsApiClient
  : null;
const invoke = (...args) => {
  if (!api || typeof api.invoke !== 'function') {
    return Promise.reject(new Error('API client unavailable.'));
  }
  return api.invoke(...args);
};
const send = (...args) => {
  try { if (api && typeof api.send === 'function') api.send(...args); } catch (_) { }
};

async function ensureAuthenticatedOrRedirect() {
  try {
    await invoke('auth:me');
  } catch (_) {
    try { window.location.replace('login.html'); } catch (_) { window.location.href = 'login.html'; }
  }
}
ensureAuthenticatedOrRedirect();


function suppressLeavePrompt() {
  try {
    window.addEventListener('beforeunload', (event) => {
      try { event.returnValue = undefined; } catch (_) { }
      try { event.stopImmediatePropagation(); } catch (_) { }
    }, true);
  } catch (_) { }
}
suppressLeavePrompt();



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

const CUSTOMER_CART_WINDOW_NAME = 'middletonsCustomerCart';
function openCustomerCartWindow() {
  if (api?.hasIpc) return null;
  const url = 'customer-cart.html';
  const features = 'popup=yes,width=1280,height=720,menubar=no,toolbar=no,location=no,status=no';
  const existing = window.__customerCartWindow;
  if (existing && !existing.closed) {
    try { existing.focus(); } catch (_) { }
    return existing;
  }
  const opened = window.open(url, CUSTOMER_CART_WINDOW_NAME, features);
  if (opened) {
    window.__customerCartWindow = opened;
    try { opened.focus(); } catch (_) { }
  }
  return opened || null;
}
function closeCustomerCartWindow() {
  try {
    const existing = window.__customerCartWindow;
    if (existing && !existing.closed) existing.close();
  } catch (_) { }
  try {
    const named = window.open('', CUSTOMER_CART_WINDOW_NAME);
    if (named && named !== window && !named.closed) named.close();
  } catch (_) { }
}

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
function handleDomReady() {
  wireCloseAppLink();
  openCustomerCartWindow();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', handleDomReady);
} else {
  handleDomReady();
}

// ---------- Globals ----------
let TAX_RATE = 0.0725;
let GIFT_CARD_SURCHARGE_RATE = 0.03;
let __taxExempt = false;
let __taxExemptInfo = { id: '', name: '' };
let __taxExemptOrgs = [];
let __noTaxModal = null;
let __cancelConfirmModal = null;
let __silentPrint = true;
let __greyscalePrint = false;
let items = []; // { name, price, vendorName, comment }
let __vendorsCache = [];
let __editModal = null;
let __returnModal = null;
let __cashAudio = null;
let __lastTotal = 0;
let __lastCustomerCartState = null;
let __giftCardBalance = null;
let __giftCardReminderModal = null;
let __giftCardActivateModal = null;
let __giftCardSaleModal = null;
let __pendingGiftCardReminder = null;
let __suppressRefocusUntil = 0;
let __qtyPickerOpen = false;
const GIFT_CARD_ITEM_NAME = 'Gift Card Sale';
const GIFT_CARD_VENDOR_CODE = 'STORE-GC';
const GIFT_CARD_VENDOR_NAME = 'Store Gift Cards';
let __discountReasons = [
  'Store Promo',
  'Vendor Promo',
  'Dolly Purrton Promo',
  'Vendor Approved',
  'Store Approved'
];
let __vendorPromotions = [];
// Branding (business name/address/phone/logo) applied across POS and receipts
let __branding = {
  bizName: "Middleton's Antiques & Uniques",
  bizAddress: '1615 S 17th St, Lincoln, NE 68502',
  bizPhone: '531-500-0135',
  logoPath: ''
};
function __getBrandingName() {
  return String(__branding?.bizName || "Middleton's Antiques & Uniques");
}
function __getBrandingAddressLine() {
  const addr = String(__branding?.bizAddress || '').trim();
  const phone = String(__branding?.bizPhone || '').trim();
  if (addr && phone) return `${addr} · ${phone}`;
  return addr || phone || '';
}
function __getBrandingLogoSrc(defaultPath) {
  const src = String(__branding?.logoPath || '').trim();
  return src || defaultPath;
}
function __applyBrandingToDocument() {
  try {
    const name = __getBrandingName();
    const addrLine = __getBrandingAddressLine();
    const navBrand = document.querySelector('.navbar-brand');
    if (navBrand) navBrand.textContent = name;
    const rcptBrand = document.querySelector('#print-root .brand');
    if (rcptBrand) rcptBrand.textContent = name;
    const addrEl = document.getElementById('rcpt-address');
    if (addrEl) addrEl.textContent = addrLine || '';
  } catch (_) { }
}

// Multi-sale tabs: per-cart state manager
let __carts = new Map(); // id -> state
let __activeCartId = '';
let __cartCounter = 0;
const __TABS_STORAGE_KEY = 'posTabsV1';
const __SESSION_KEY = 'posSessionIdV1';
let __sessionId = '';
let __isQuitting = false;
const __WINDOW_SESSION_PREFIX = `${__SESSION_KEY}=`;

function __readWindowSessionId() {
  try {
    const name = String(window.name || '');
    if (!name) return '';
    const parts = name.split(';');
    const hit = parts.find(part => part.startsWith(__WINDOW_SESSION_PREFIX));
    return hit ? hit.slice(__WINDOW_SESSION_PREFIX.length) : '';
  } catch (_) { return ''; }
}
function __writeWindowSessionId(id) {
  try {
    const name = String(window.name || '');
    const parts = name ? name.split(';').filter(Boolean) : [];
    let updated = false;
    const next = parts.map(part => {
      if (part.startsWith(__WINDOW_SESSION_PREFIX)) {
        updated = true;
        return `${__WINDOW_SESSION_PREFIX}${id}`;
      }
      return part;
    });
    if (!updated) next.push(`${__WINDOW_SESSION_PREFIX}${id}`);
    window.name = next.join(';');
  } catch (_) { }
}

function __todayYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function __backdateMaxDate() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  return d;
}
function __backdateMaxYmd() {
  const d = __backdateMaxDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function __isBackdateBeforeToday(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return false;
  const parsed = Date.parse(`${candidate}T00:00:00`);
  if (!Number.isFinite(parsed)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed < today.getTime();
}
function __sanitizeBackdateValue(value) {
  const candidate = String(value || '').trim();
  return __isBackdateBeforeToday(candidate) ? candidate : __backdateMaxYmd();
}
function __newCartState(title = '') {
  return {
    title,
    items: [],
    cashier: '',
    payment: '',
    backdateEnabled: false,
    backdateDate: __backdateMaxYmd(),
    taxExempt: false,
    taxExemptInfo: { id: '', name: '' },
    cashReceived: '',
    receiptWanted: true,
    giftCardNumber: '',
    giftCardAmount: '',
    splitTenderEnabled: false,
    splitTenderType: '',
    splitTenderAmount: '',
    // Entry form draft (per-tab)
    entryName: '',
    entryPrice: '',
    entryQty: '1',
    entryVendor: '',
    entryComment: '',
    entryDiscountType: 'none',
    entryDiscountValue: '',
    entryDiscountReason: ''
  };
}
function __snapshotFromUI() {
  try {
    const cashier = document.getElementById('cashierSelect')?.value || '';
    const payment = document.getElementById('paymentSelect')?.value || '';
    const backdateEnabled = !!document.getElementById('backdateToggle')?.checked;
    const backdateInputValue = document.getElementById('backdateDate')?.value || '';
    const backdateDate = __sanitizeBackdateValue(backdateInputValue);
    const cashReceived = document.getElementById('cashReceived')?.value || '';
    const giftCardNumber = document.getElementById('giftCardNumber')?.value || '';
    const giftCardAmount = document.getElementById('giftCardAmount')?.value || '';
    const splitTenderEnabled = !!document.getElementById('splitTenderToggle')?.checked;
    const splitTenderType = document.getElementById('splitTenderType')?.value || '';
    const splitTenderAmount = document.getElementById('splitTenderAmount')?.value || '';
    const receiptWanted = document.getElementById('receiptWanted')
      ? !!document.getElementById('receiptWanted')?.checked
      : true;
    // Entry form fields
    const entryName = document.getElementById('itemName')?.value || '';
    const entryPrice = document.getElementById('itemPrice')?.value || '';
    const entryQty = document.getElementById('itemQty')?.value || '1';
    const entryVendor = document.getElementById('itemVendor')?.value || '';
    const entryComment = document.getElementById('itemComment')?.value || '';
    const entryDiscountType = document.getElementById('discountType')?.value || 'none';
    const entryDiscountValue = document.getElementById('discountValue')?.value || '';
    const entryDiscountReason = document.getElementById('discountReason')?.value || '';
    return {
      title: __carts.get(__activeCartId)?.title || '',
      items: (Array.isArray(items) ? items.map(it => ({ ...it })) : []),
      cashier,
      payment,
      backdateEnabled,
      backdateDate,
      taxExempt: !!__taxExempt,
      taxExemptInfo: { id: String(__taxExemptInfo?.id || ''), name: String(__taxExemptInfo?.name || '') },
      cashReceived,
      receiptWanted,
      giftCardNumber,
      giftCardAmount,
      splitTenderEnabled,
      splitTenderType,
      splitTenderAmount,
      entryName,
      entryPrice,
      entryQty,
      entryVendor,
      entryComment,
      entryDiscountType,
      entryDiscountValue,
      entryDiscountReason
    };
  } catch (_) {
    return __newCartState(__carts.get(__activeCartId)?.title || '');
  }
}
function __applyStateToUI(state) {
  try {
    items = (Array.isArray(state?.items) ? state.items.map(it => ({ ...it })) : []);
  } catch (_) { items = []; }
  try { const el = document.getElementById('cashierSelect'); if (el) el.value = state?.cashier || ''; } catch (_) { }
  try { const el = document.getElementById('paymentSelect'); if (el) el.value = state?.payment || ''; } catch (_) { }
  try { toggleCashFields(); } catch (_) { }
  try { toggleGiftCardFields(); } catch (_) { }
  try { const el = document.getElementById('cashReceived'); if (el) el.value = state?.cashReceived || ''; updateCashChange(); } catch (_) { }
  try { const el = document.getElementById('giftCardNumber'); if (el) el.value = state?.giftCardNumber || ''; } catch (_) { }
  try { const el = document.getElementById('giftCardAmount'); if (el) el.value = state?.giftCardAmount || ''; } catch (_) { }
  try { const el = document.getElementById('splitTenderToggle'); if (el) el.checked = !!state?.splitTenderEnabled; } catch (_) { }
  try { const el = document.getElementById('splitTenderType'); if (el) el.value = state?.splitTenderType || ''; } catch (_) { }
  try { const el = document.getElementById('splitTenderAmount'); if (el) el.value = state?.splitTenderAmount || ''; } catch (_) { }
  try { toggleSplitTenderFields(); } catch (_) { }
  try { const el = document.getElementById('receiptWanted'); if (el) el.checked = state?.receiptWanted !== false; updatePrintButtonLabel(); } catch (_) { }
  try {
    const bdToggle = document.getElementById('backdateToggle');
    const bdWrap = document.getElementById('backdateWrap');
    const bdDate = document.getElementById('backdateDate');
    if (bdToggle) bdToggle.checked = !!state?.backdateEnabled;
    if (bdWrap) bdWrap.classList.toggle('d-none', !state?.backdateEnabled);
    if (bdDate) bdDate.value = __sanitizeBackdateValue(state?.backdateDate || __backdateMaxYmd());
  } catch (_) { }
  try {
    const nt = document.getElementById('noTaxToggle');
    if (nt) nt.checked = !!state?.taxExempt;
    __taxExempt = !!state?.taxExempt;
    __taxExemptInfo = { id: String(state?.taxExemptInfo?.id || ''), name: String(state?.taxExemptInfo?.name || '') };
    updateTaxRateLabel();
  } catch (_) { }
  // Restore per-tab entry form draft
  try {
    const nameEl = document.getElementById('itemName'); if (nameEl) nameEl.value = state?.entryName || '';
    const priceEl = document.getElementById('itemPrice'); if (priceEl) priceEl.value = state?.entryPrice || '';
    const qtyEl = document.getElementById('itemQty'); if (qtyEl) qtyEl.value = state?.entryQty || '1';
    const vendorEl = document.getElementById('itemVendor'); if (vendorEl) vendorEl.value = state?.entryVendor || '';
    const commentEl = document.getElementById('itemComment'); if (commentEl) commentEl.value = state?.entryComment || '';
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');
    if (typeEl) typeEl.value = state?.entryDiscountType || 'none';
    if (valueEl) valueEl.value = state?.entryDiscountValue || '';
    if (reasonEl) setDiscountReasonOptions(reasonEl, __discountReasons, state?.entryDiscountReason || '');
    if (typeEl && valueEl) applyDiscountTypeState(typeEl, valueEl, { preserveValue: true });
    if (typeEl && reasonEl) syncDiscountReasonDisabledState(typeEl, reasonEl);
    try { applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
  } catch (_) { }
  try { renderTable(); } catch (_) { }
}
function __renderTabs() {
  try {
    const bar = document.getElementById('saleTabs');
    if (!bar) return;
    const entries = Array.from(__carts.entries());
    bar.innerHTML = entries.map(([id, st], idx) => {
      const active = id === __activeCartId ? 'active' : '';
      const label = st?.title || `Sale ${idx + 1}`;
      return `<li class="nav-item"><button class="nav-link ${active}" data-cartid="${id}">${label}</button></li>`;
    }).join('');
    bar.querySelectorAll('button[data-cartid]')?.forEach(btn => {
      btn.addEventListener('click', () => { __switchToCart(btn.getAttribute('data-cartid')); });
    });
    try { __updateCancelSaleButtonEnabled(); } catch (_) { }
    try { __updateDirtyCartBanner(); } catch (_) { }
  } catch (_) { }
}
function __switchToCart(id) {
  try {
    if (!id || id === __activeCartId) return;
    if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI());
    __activeCartId = id;
    const st = __carts.get(id) || __newCartState();
    __applyStateToUI(st);
    __renderTabs();
    __persistTabs();
  } catch (_) { }
}
function __createNewCartTab() {
  try {
    if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI());
    const id = `T-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const title = `Sale ${++__cartCounter}`;
    __carts.set(id, __newCartState(title));
    __activeCartId = id;
    __applyStateToUI(__carts.get(id));
    __renderTabs();
    __persistTabs();
    try { __updateCancelSaleButtonEnabled(); } catch (_) { }
  } catch (_) { }
}

function __renumberTabs() {
  try {
    // Deliberately avoid renumbering existing tabs to preserve their titles.
    // Keep counter in sync with total count for future tab creation.
    __cartCounter = (__carts && typeof __carts.size === 'number') ? __carts.size : __cartCounter;
  } catch (_) { }
}

function __confirmCancelActiveCart() {
  return new Promise((resolve) => {
    try {
      const modalEl = document.getElementById('cancelSaleModal');
      if (!modalEl || !window.bootstrap) {
        resolve(window.confirm('Cancel this sale and clear all its fields? This cannot be undone.'));
        return;
      }
      if (!__cancelConfirmModal) {
        __cancelConfirmModal = new bootstrap.Modal(modalEl, { backdrop: 'static', keyboard: false });
      }
      const okBtn = modalEl.querySelector('#cancelSaleConfirmBtn');
      const cancelBtns = modalEl.querySelectorAll('[data-role="cancel"]');
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        resolve(!!val);
        try { __cancelConfirmModal.hide(); } catch (_) { }
      };
      cancelBtns.forEach(btn => btn.addEventListener('click', () => finish(false), { once: true }));
      if (okBtn) okBtn.addEventListener('click', () => finish(true), { once: true });
      modalEl.addEventListener('hidden.bs.modal', () => finish(false), { once: true });
      __cancelConfirmModal.show();
      setTimeout(() => { try { (okBtn || modalEl.querySelector('button'))?.focus(); } catch (_) { } }, 80);
    } catch (_) { resolve(false); }
  });
}

async function __cancelActiveCart() {
  try {
    if (!__activeCartId) return;
    // Check if cart has data to avoid accidental loss
    const st = __snapshotFromUI();
    const hasItems = Array.isArray(st.items) && st.items.length > 0;
    const hasMeta = (st.cashier || st.payment || st.taxExempt || st.backdateEnabled || (st.cashReceived || '')).toString() !== ''.toString();
    if (hasItems || hasMeta) {
      const ok = await __confirmCancelActiveCart();
      if (!ok) return;
    }
    clearPosErrors();
    const tabCount = (__carts && typeof __carts.size === 'number') ? __carts.size : 0;
    // If only one tab, refresh it in-place and keep label as Sale 1
    if (tabCount <= 1) {
      const fresh = __newCartState('Sale 1');
      __carts = new Map([[__activeCartId, fresh]]);
      __cartCounter = 1;
      __applyStateToUI(fresh);
      __renderTabs();
      __persistTabs();
      try { __updateCancelSaleButtonEnabled(); } catch (_) { }
      return;
    }

    // Multiple tabs: close the active one and switch
    const idToClose = __activeCartId;
    const entries = Array.from(__carts.keys());
    const idx = Math.max(0, entries.indexOf(idToClose));
    __carts.delete(idToClose);
    let nextId = '';
    for (let i = idx; i < entries.length; i++) {
      const cand = entries[i];
      if (cand !== idToClose && __carts.has(cand)) { nextId = cand; break; }
    }
    if (!nextId) {
      const first = __carts.keys().next();
      nextId = first && !first.done ? first.value : '';
    }
    if (!nextId) {
      __activeCartId = '';
      __createNewCartTab();
      __renumberTabs();
      __persistTabs();
      return;
    }
    __activeCartId = nextId;
    __applyStateToUI(__carts.get(nextId));
    __renderTabs();
    __renumberTabs();
    __persistTabs();
    try { __updateCancelSaleButtonEnabled(); } catch (_) { }
  } catch (_) { }
}

function __completeSaleAndCloseTab() {
  try {
    if (!__activeCartId) { __persistTabs(); return; }
    const closingId = __activeCartId;
    // Remove the completed tab
    __carts.delete(closingId);
    // Find remaining tabs with pending items
    const pending = Array.from(__carts.entries()).filter(([_, st]) => Array.isArray(st?.items) && st.items.length > 0);
    if (pending.length > 0) {
      // Keep only the first pending tab to simplify post-sale state
      const next = pending[0];
      __carts = new Map([[next[0], next[1]]]);
      __activeCartId = next[0];
      __renumberTabs();
      __applyStateToUI(next[1]);
      __renderTabs();
      __persistTabs();
      try { __updateCancelSaleButtonEnabled(); } catch (_) { }
      return;
    }
    // If no pending items remain, create a fresh empty tab
    __carts = new Map();
    __activeCartId = '';
    __cartCounter = 0;
    __createNewCartTab();
    __renumberTabs();
    __renderTabs();
    __persistTabs();
    try { __updateCancelSaleButtonEnabled(); } catch (_) { }
  } catch (_) { }
}

function __persistTabs() {
  try {
    if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI());
    const payload = {
      active: __activeCartId,
      counter: __cartCounter,
      carts: Array.from(__carts.entries()),
      session: __sessionId || ''
    };
    localStorage.setItem(__TABS_STORAGE_KEY, JSON.stringify(payload));
    try { __updateDirtyCartBanner(); } catch (_) { }
  } catch (_) { }
}
function __restoreTabs() {
  try {
    const raw = localStorage.getItem(__TABS_STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.carts)) return false;
    // Only restore within the same app session (e.g., reload/navigation), never across app launches
    if (!data.session || !__sessionId || data.session !== __sessionId) {
      try { localStorage.removeItem(__TABS_STORAGE_KEY); } catch (_) { }
      return false;
    }
    __carts = new Map(data.carts);
    __cartCounter = Number(data.counter) || __carts.size || 0;
    __activeCartId = data.active || (data.carts[0] ? data.carts[0][0] : '');
    if (__activeCartId) {
      const st = __carts.get(__activeCartId) || __newCartState();
      __applyStateToUI(st);
      __renderTabs();
      try { __updateCancelSaleButtonEnabled(); } catch (_) { }
      return true;
    }
    return false;
  } catch (_) { return false; }
}

function __updateCancelSaleButtonEnabled() {
  try {
    const btn = document.getElementById('cancelSaleBtn');
    if (!btn) return;
    // Keep enabled even when only one tab remains to allow cancelling the lone sale.
    btn.disabled = false;
    try { btn.classList.remove('disabled'); } catch (_) { }
  } catch (_) { }
}

function __getDirtyCartTitles() {
  try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
  const titles = [];
  try {
    for (const [, st] of __carts.entries()) {
      if (Array.isArray(st?.items) && st.items.length > 0) {
        titles.push(st.title || 'Sale');
      }
    }
  } catch (_) { }
  return titles;
}

function __hasDirtyCarts() {
  return __getDirtyCartTitles().length > 0;
}

function __updateDirtyCartBanner() {
  const banner = document.getElementById('dirtyCartBanner');
  if (!banner) return;
  const countEl = document.getElementById('dirtyCartCount');
  const listEl = document.getElementById('dirtyCartList');
  const titles = __getDirtyCartTitles();
  if (!titles.length) {
    banner.classList.add('d-none');
    return;
  }
  banner.classList.remove('d-none');
  if (countEl) countEl.textContent = String(titles.length);
  if (listEl) {
    const shown = titles.slice(0, 3);
    const more = titles.length > shown.length ? ` (+${titles.length - shown.length} more)` : '';
    listEl.textContent = `${shown.join(', ')}${more}`;
  }
}

function __normalizeTaxExemptOrgs(list) {
  const incoming = Array.isArray(list) ? list : [];
  const cleaned = [];
  const seen = new Set();
  incoming.forEach((org) => {
    const name = String(org?.name || '').trim();
    const id = String(org?.id || org?.taxId || '').trim();
    if (!name || !id) return;
    const key = `${name.toLowerCase()}|${id.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    cleaned.push({ name, id });
  });
  return cleaned.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function __renderTaxExemptOrgOptions() {
  const listEl = document.getElementById('taxExemptOrgList');
  if (!listEl) return;
  listEl.innerHTML = '';
  (__taxExemptOrgs || []).forEach((org) => {
    const opt = document.createElement('option');
    opt.value = org.name;
    opt.setAttribute('data-tax-id', org.id);
    listEl.appendChild(opt);
  });
}

function __setTaxExemptOrgs(list) {
  __taxExemptOrgs = __normalizeTaxExemptOrgs(list);
  __renderTaxExemptOrgOptions();
}

function __syncTaxExemptIdFromName(nameEl, idEl) {
  try {
    if (!nameEl || !idEl) return;
    const nameVal = String(nameEl.value || '').trim().toLowerCase();
    if (!nameVal) return;
    const match = (__taxExemptOrgs || []).find(org => String(org?.name || '').trim().toLowerCase() === nameVal);
    if (match && match.id) idEl.value = match.id;
  } catch (_) { }
}

// ---------- Utils ----------
function money(n) { return toMoneyNumber(n).toFixed(2); }
function formatPriceInput(el) {
  try {
    if (!el) return;
    const raw = String(el.value || '').trim();
    if (!raw) return; // keep empty as-is
    const num = toMoneyNumber(raw);
    el.value = money(num);
  } catch (_) { }
}
// Lightweight status bar shown during async operations (e.g., silent print)
function showStatusBar(message) {
  try {
    const id = 'pos-status-bar';
    let bar = document.getElementById(id);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = id;
      bar.style.position = 'fixed';
      bar.style.left = '0';
      bar.style.right = '0';
      bar.style.bottom = '0';
      bar.style.zIndex = '5000';
      bar.style.background = 'rgba(255,255,255,.98)';
      bar.style.color = '#212529';
      bar.style.padding = '8px 14px 12px 14px';
      bar.style.boxShadow = '0 -6px 18px rgba(0,0,0,.18)';
      bar.style.borderTop = '1px solid rgba(0,0,0,.08)';
      bar.style.display = 'none';

      const content = document.createElement('div');
      content.style.margin = '0 auto';
      content.style.maxWidth = '720px';

      const label = document.createElement('div');
      label.id = 'pos-status-text';
      label.className = 'text-center fw-semibold';
      label.style.marginBottom = '6px';

      const progress = document.createElement('div');
      progress.className = 'progress';
      progress.style.height = '6px';

      const progBar = document.createElement('div');
      progBar.className = 'progress-bar progress-bar-striped progress-bar-animated';
      progBar.id = 'pos-status-progress';
      progBar.setAttribute('role', 'progressbar');
      progBar.setAttribute('aria-valuenow', '0');
      progBar.setAttribute('aria-valuemin', '0');
      progBar.setAttribute('aria-valuemax', '100');
      // Start empty; we animate to 100% on show
      progBar.style.width = '0%';
      progBar.style.transition = 'width 2s linear';

      progress.appendChild(progBar);
      content.appendChild(label);
      content.appendChild(progress);
      bar.appendChild(content);
      document.body.appendChild(bar);
    }
    const txt = bar.querySelector('#pos-status-text');
    if (txt) txt.textContent = String(message || '');
    bar.style.display = 'block';
    // Animate progress from 0% to 100% over 2 seconds
    try {
      const p = bar.querySelector('#pos-status-progress');
      if (p) {
        // reset to 0% without animation, then animate
        p.style.transition = 'none';
        p.style.width = '0%';
        p.setAttribute('aria-valuenow', '0');
        // force reflow to apply the width reset before animating
        void p.offsetWidth;
        p.style.transition = 'width 2s linear';
        requestAnimationFrame(() => {
          p.style.width = '100%';
          p.setAttribute('aria-valuenow', '100');
        });
      }
    } catch (_) { }
  } catch (_) { }
}
function hideStatusBar() {
  try { const el = document.getElementById('pos-status-bar'); if (el) el.style.display = 'none'; } catch (_) { }
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
    setTimeout(() => { try { el.remove(); } catch (_) { } }, ms);
  } catch (_) { }
}
function hasGiftCardSaleItems(list) {
  return (Array.isArray(list) ? list : []).some((it) => {
    const name = String(it?.name || '').toLowerCase();
    return name.includes('gift card') || name.includes('giftcard');
  });
}
function extractGiftCardSaleDetails(list) {
  const itemsIn = Array.isArray(list) ? list : [];
  const saleItem = itemsIn.find((it) => {
    const name = String(it?.name || '').toLowerCase();
    return name.includes('gift card') || name.includes('giftcard');
  });
  if (!saleItem) return null;
  const comment = String(saleItem.comment || '');
  const match = comment.match(/card\s*#\s*([^\s]+)/i);
  const cardNumber = match ? match[1].trim() : '';
  const amount = toMoneyNumber(saleItem.price || saleItem.originalPrice || 0);
  return { cardNumber, amount };
}
function queueGiftCardActivationReminder(payload) {
  __pendingGiftCardReminder = payload || null;
}
function showGiftCardActivationReminder() {
  const payload = __pendingGiftCardReminder;
  if (!payload) return;
  const modalEl = document.getElementById('giftCardActivateReminderModal');
  if (!modalEl || !window.bootstrap) {
    __pendingGiftCardReminder = null;
    return;
  }
  const receipt = String(payload.receiptNumber || '').trim();
  const cardNumber = String(payload.cardNumber || '').trim();
  const amount = Number(payload.amount || 0);
  const receiptWrap = document.getElementById('giftCardReminderReceiptWrap');
  const receiptEl = document.getElementById('giftCardReminderReceipt');
  if (receiptEl) receiptEl.textContent = receipt || '-';
  if (receiptWrap) receiptWrap.classList.toggle('d-none', !receipt);
  try {
    const activateBtn = document.getElementById('giftCardReminderActivateBtn');
    if (activateBtn) {
      activateBtn.dataset.cardNumber = cardNumber;
      activateBtn.dataset.amount = Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '';
      activateBtn.dataset.receipt = receipt;
    }
  } catch (_) { }
  if (!__giftCardReminderModal) {
    __giftCardReminderModal = new bootstrap.Modal(modalEl);
  }
  __pendingGiftCardReminder = null;
  try { __giftCardReminderModal.show(); } catch (_) { }
}
function setupGiftCardActivateModal() {
  const modalEl = document.getElementById('activateGiftCardModal');
  if (!modalEl || !window.bootstrap) return null;
  if (!__giftCardActivateModal) __giftCardActivateModal = new bootstrap.Modal(modalEl);
  return __giftCardActivateModal;
}
async function openGiftCardActivateModal(payload = {}) {
  const number = String(payload.cardNumber || '').trim();
  const amount = Number(payload.amount || 0);
  const receipt = String(payload.receiptNumber || payload.receipt || '').trim();
  const numberInput = document.getElementById('activateNumber');
  const amountInput = document.getElementById('activateAmount');
  const cashierSelect = document.getElementById('activateCashier');
  const receiptInput = document.getElementById('activateReceipt');
  const noteInput = document.getElementById('activateNote');
  if (numberInput) numberInput.value = number || '';
  if (amountInput) amountInput.value = Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : '';
  if (receiptInput) receiptInput.value = receipt || '';
  if (noteInput) noteInput.value = '';
  try { await loadCashiersIntoSelect('activateCashier'); } catch (_) { }
  const currentCashier = String(document.getElementById('cashierSelect')?.value || '').trim();
  if (cashierSelect && currentCashier) cashierSelect.value = currentCashier;
  const modal = setupGiftCardActivateModal();
  try { modal?.show(); } catch (_) { }
  try { (cashierSelect || amountInput)?.focus(); } catch (_) { }
}
async function activateGiftCardFromPos() {
  const number = String(document.getElementById('activateNumber')?.value || '').trim();
  const amount = String(document.getElementById('activateAmount')?.value || '').trim();
  const cashier = String(document.getElementById('activateCashier')?.value || '').trim();
  const receiptNumber = String(document.getElementById('activateReceipt')?.value || '').trim();
  const note = String(document.getElementById('activateNote')?.value || '').trim();
  if (!number) { showToast('Gift card number is required.', { type: 'error' }); return; }
  if (!amount) { showToast('Gift card amount is required.', { type: 'error' }); return; }
  if (!cashier) { showToast('Select a cashier.', { type: 'error' }); return; }
  try {
    const resp = await invoke('giftcards:sell', { number, amount, cashier, receiptNumber, note });
    if (!resp || !resp.ok) {
      showToast('Failed to activate gift card.', { type: 'error' });
      return;
    }
    showToast('Gift card activated.', { type: 'success' });
    try { __giftCardActivateModal?.hide(); } catch (_) { }
    document.getElementById('activateNumber').value = '';
    document.getElementById('activateAmount').value = '';
    document.getElementById('activateReceipt').value = '';
    document.getElementById('activateNote').value = '';
  } catch (err) {
    showToast(err?.message || 'Failed to activate gift card.', { type: 'error' });
  }
}
async function handleGiftCardReminderActivate() {
  const btn = document.getElementById('giftCardReminderActivateBtn');
  if (!btn) return;
  const payload = {
    cardNumber: String(btn.dataset.cardNumber || '').trim(),
    amount: toMoneyNumber(btn.dataset.amount || 0),
    receiptNumber: String(btn.dataset.receipt || '').trim()
  };
  try { __giftCardReminderModal?.hide(); } catch (_) { }
  await openGiftCardActivateModal(payload);
}
function giftCardBookLabel(bookId, books) {
  const list = Array.isArray(books) ? books : [];
  const book = list.find(b => b.id === bookId);
  if (!book) return '';
  return book.label || book.prefix || book.id || '';
}
async function fetchGiftCardsData() {
  try {
    const data = await invoke('giftcards:load');
    if (data && typeof data === 'object') return data;
  } catch (_) { }
  return { books: [], cards: [], transactions: [] };
}
function isGiftCardSaleItem(item) {
  const name = String(item?.name || '').toLowerCase();
  return name.includes('gift card') || name.includes('giftcard');
}
function getGiftCardSaleTotal(list) {
  return (Array.isArray(list) ? list : []).reduce((sum, it) => {
    if (!isGiftCardSaleItem(it)) return sum;
    const qty = Math.max(1, parseInt(it.quantity || 1, 10));
    const unit = toMoneyNumber(it.price || 0);
    return sum + toMoneyNumber(unit * qty);
  }, 0);
}
function isCardTenderSelected(payment, splitEnabled, splitType) {
  const main = String(payment || '');
  const split = String(splitType || '');
  return main === 'Card' || (splitEnabled && split === 'Card');
}
function getGiftCardFee(giftCardSubtotal, subtotal, tax, payment, splitEnabled, splitType, splitAmount) {
  const giftTotal = toMoneyNumber(giftCardSubtotal || 0);
  if (giftTotal <= 0) return 0;
  const main = String(payment || '');
  const split = String(splitType || '');
  const cardTenderUsed = main === 'Card' || (splitEnabled && split === 'Card');
  if (!cardTenderUsed) return 0;
  if (splitEnabled && main !== 'Card') {
    const baseTotal = toMoneyNumber(toMoneyNumber(subtotal || 0) + toMoneyNumber(tax || 0));
    const splitAmt = toMoneyNumber(splitAmount || 0);
    const primaryAmount = Math.max(0, baseTotal - splitAmt);
    if (primaryAmount + 0.009 >= giftTotal) return 0;
  }
  return toMoneyNumber(giftTotal * GIFT_CARD_SURCHARGE_RATE);
}
function clearFieldError(el) {
  try { el?.classList?.remove('is-invalid'); } catch (_) { }
}
function markFieldError(el, validator) {
  try {
    if (!el) return;
    clearFieldError(el);
    const handler = () => {
      try {
        const ok = validator ? validator(el) : Boolean(String(el.value || '').trim());
        if (ok) {
          clearFieldError(el);
          el.removeEventListener('input', handler);
          el.removeEventListener('change', handler);
        }
      } catch (_) { }
    };
    el.classList.add('is-invalid');
    el.addEventListener('input', handler);
    el.addEventListener('change', handler);
  } catch (_) { }
}
function clearPosErrors() {
  try {
    document.querySelectorAll('.is-invalid').forEach(el => clearFieldError(el));
  } catch (_) { }
}
function cleanupStrayBackdrops() {
  try {
    const anyOpenModal = !!document.querySelector('.modal.show');
    if (anyOpenModal) return;
    document.querySelectorAll('.modal-backdrop, .offcanvas-backdrop').forEach(el => {
      try { el.remove(); } catch (_) { }
    });
    // Also ensure body is not stuck in modal-open state
    try { document.body.classList.remove('modal-open'); } catch (_) { }
    // Close lingering offcanvas/nav collapse
    try { document.querySelectorAll('.offcanvas.show').forEach(el => { el.classList.remove('show'); el.style.display = 'none'; el.setAttribute('aria-hidden', 'true'); }); } catch (_) { }
    try { document.querySelectorAll('.navbar-collapse.show').forEach(el => { el.classList.remove('show'); el.style.display = ''; }); } catch (_) { }
    // Ensure pointer events are enabled on body
    try { document.body.style.pointerEvents = 'auto'; } catch (_) { }
  } catch (_) { }
}

// Ensure inputs can regain focus after UI interactions
function forceFocusOnInputs() {
  try {
    document.addEventListener('mousedown', (e) => {
      const el = e.target instanceof Element ? e.target.closest('input, textarea, select') : null;
      if (!el) return;
      setTimeout(() => { try { el.focus(); } catch (_) { } }, 0);
    }, true);
  } catch (_) { }
}

// Aggressively remove any full-screen overlay elements that might capture input
function nukeBlockingOverlays() {
  try {
    // Never remove overlays while a Bootstrap modal is open
    if (document.querySelector('.modal.show')) return;
    const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
    const bigEnough = (el) => {
      const r = el.getBoundingClientRect();
      const w = r.width, h = r.height;
      return (w >= vw * 0.8) && (h >= vh * 0.8);
    };
    const isOverlay = (el) => {
      const st = window.getComputedStyle(el);
      if (!st) return false;
      if (!(st.position === 'fixed' || st.position === 'absolute')) return false;
      const z = parseInt(st.zIndex || '0', 10);
      if (!(z >= 1000)) return false;
      // ignore Bootstrap navbars
      if (el.closest('nav.navbar')) return false;
      // ignore Bootstrap modals and their backdrops/contents
      if (el.classList.contains('modal') || el.classList.contains('modal-backdrop') || el.closest('.modal')) return false;
      // ignore Bootstrap offcanvas and dropdown menus
      if (el.classList.contains('offcanvas') || el.closest('.offcanvas')) return false;
      if (el.classList.contains('dropdown-menu') || el.closest('.dropdown-menu')) return false;
      return bigEnough(el);
    };
    document.querySelectorAll('body *').forEach(el => {
      try { if (isOverlay(el)) el.remove(); } catch (_) { }
    });
  } catch (_) { }
}
function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function norm(s) { return String(s || '').trim().toLowerCase(); }
function toMoneyNumber(n) {
  if (typeof n === 'number') {
    return isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }
  let s = String(n ?? '').trim();
  if (!s) return 0;
  // Treat parentheses as negative, e.g., (12.34)
  if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
  // Normalize common currency formatting: remove currency symbols, spaces, thousands separators
  s = s.replace(/[\$€£¥₩₽₹]/g, '');
  // If there is no dot but there is a single comma, interpret comma as decimal (basic EU-style support)
  if (!s.includes('.') && (s.match(/,/g) || []).length === 1) {
    s = s.replace(',', '.');
  }
  s = s.replace(/,/g, ''); // strip any remaining commas
  s = s.replace(/\s+/g, '');
  // Keep digits, first dot and minus
  const cleaned = s.replace(/[^0-9+\-.]/g, '');
  const num = parseFloat(cleaned);
  if (!isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}
// Override with safer currency parsing to avoid stripping digits (keeps latest definition)
function toMoneyNumberLegacy(n) {
  if (typeof n === 'number') {
    return isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }
  let s = String(n ?? '').trim();
  if (!s) return 0;
  if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
  s = s.replace(/[\$£€¥₩₱₹]/g, '');
  s = s.replace(/\s+/g, '');
  const commaCount = (s.match(/,/g) || []).length;
  if (!s.includes('.') && commaCount === 1) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  const cleaned = s.replace(/[^0-9.+-]/g, '');
  const num = parseFloat(cleaned);
  if (!isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}
function formatPercent(value) {
  const pct = toMoneyNumber(value);
  if (pct <= 0) return '';
  const isWhole = Math.abs(pct - Math.round(pct)) < 0.01;
  const str = isWhole ? String(Math.round(pct)) : pct.toFixed(2).replace(/\.?0+$/, '');
  return `${str}%`;
}
function formatRatePct(rate) {
  const pct = Math.max(0, Number(rate || 0) * 100);
  return pct.toFixed(2).replace(/\.?0+$/, '');
}
function formatDiscountLabel(type, value, amount) {
  if (type === 'percent') {
    const pct = formatPercent(value);
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
  const trimmedReason = String(reason || '').trim();
  if (trimmedReason) parts.push(escapeFn(trimmedReason));
  const label = formatDiscountLabel(type, value, amount);
  if (label) parts.push(escapeFn(label));
  return parts.length ? ` (${parts.join(', ')})` : '';
}
function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}
function computeDiscount(originalPriceRaw, typeRaw, valueRaw, reasonRaw) {
  const originalPrice = Math.max(0, toMoneyNumber(originalPriceRaw));
  let type = typeRaw === 'percent' ? 'percent' : typeRaw === 'amount' ? 'amount' : 'none';
  if (originalPrice <= 0 || !type) type = 'none';

  if (type === 'none') {
    return { type: 'none', value: 0, amount: 0, reason: '' };
  }

  if (type === 'percent') {
    const pct = clamp(Number(valueRaw) || 0, 0, 100);
    const amount = toMoneyNumber(originalPrice * (pct / 100));
    if (amount <= 0) return { type: 'none', value: 0, amount: 0, reason: '' };
    return {
      type: 'percent',
      value: toMoneyNumber(pct),
      amount,
      reason: String(reasonRaw || '').trim()
    };
  }

  if (type === 'amount') {
    const amt = Math.max(0, toMoneyNumber(valueRaw));
    const capped = toMoneyNumber(Math.min(amt, originalPrice));
    if (capped <= 0) return { type: 'none', value: 0, amount: 0, reason: '' };
    return {
      type: 'amount',
      value: capped,
      amount: capped,
      reason: String(reasonRaw || '').trim()
    };
  }

  return { type: 'none', value: 0, amount: 0, reason: '' };
}
function finalPriceFrom(original, discountAmount) {
  return toMoneyNumber(Math.max(0, toMoneyNumber(original) - toMoneyNumber(discountAmount)));
}
function deriveOriginalPrice(it) {
  if (typeof it?.originalPrice === 'number' && !Number.isNaN(it.originalPrice)) {
    return toMoneyNumber(it.originalPrice);
  }
  const price = toMoneyNumber(it?.price || 0);
  const discount = toMoneyNumber(it?.discountAmount || 0);
  return toMoneyNumber(price + discount);
}
function itemHasDiscount(it) {
  return toMoneyNumber(it?.discountAmount || 0) > 0;
}
function cartHasItems() { return Array.isArray(items) && items.length > 0; }
function updateTaxRateLabel() {
  const el = document.getElementById('taxRatePct');
  const note = document.getElementById('taxExemptNote');
  const effRate = __taxExempt ? 0 : Number(TAX_RATE);
  if (el) el.textContent = (effRate * 100).toFixed(2);
  try { if (note) note.classList.toggle('d-none', !__taxExempt); } catch (_) { }
}
function updateGiftCardFeeLabel() {
  const el = document.getElementById('giftCardFeeLabel');
  if (!el) return;
  el.textContent = `Card Fee (${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}% on gift card sales)`;
}
function selectHasRealOptions(selectEl) {
  try {
    if (!selectEl) return false;
    return [...selectEl.options].some(o => String(o.value || '').trim() !== '');
  } catch (_) { return false; }
}
function ensurePlaceholder(selectEl) {
  if (!selectEl) return;
  if ([...selectEl.options].some(o => o.value === '')) {
    selectEl.value = '';
    return;
  }
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = 'Select...';
  opt.disabled = true;
  opt.selected = true;
  selectEl.insertBefore(opt, selectEl.firstChild);
  selectEl.value = '';
}
function resetSelectToPlaceholder(selectEl) { ensurePlaceholder(selectEl); selectEl.value = ''; }
function setDiscountReasonOptions(selectEl, reasons, selectedValue = '') {
  if (!selectEl) return;
  const list = Array.isArray(reasons) && reasons.length ? reasons : __discountReasons || [];
  selectEl.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Select reason';
  placeholder.disabled = true;
  placeholder.selected = true;
  selectEl.appendChild(placeholder);
  list.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    selectEl.appendChild(opt);
  });
  const val = String(selectedValue || '');
  if (val) {
    const exists = [...selectEl.options].some(o => String(o.value || '') === val);
    if (!exists) {
      const extra = document.createElement('option');
      extra.value = val;
      extra.textContent = val;
      selectEl.appendChild(extra);
    }
    selectEl.value = val;
  }
}
function syncDiscountReasonDisabledState(typeEl, reasonEl) {
  try {
    if (!reasonEl || !typeEl) return;
    const isNone = typeEl.value === 'none';
    reasonEl.disabled = isNone;
    if (isNone) resetSelectToPlaceholder(reasonEl);
  } catch (_) { }
}
function applyDiscountTypeState(typeEl, valueEl, opts = {}) {
  if (!typeEl || !valueEl) return;
  const type = typeEl.value;
  if (type === 'percent') {
    valueEl.disabled = false;
    valueEl.placeholder = 'Percent (0 - 100)';
    valueEl.step = '0.01';
    valueEl.min = '0';
    valueEl.max = '100';
  } else if (type === 'amount') {
    valueEl.disabled = false;
    valueEl.placeholder = 'Amount in $';
    valueEl.step = '0.01';
    valueEl.min = '0';
    valueEl.removeAttribute('max');
  } else {
    valueEl.disabled = true;
    if (!opts.preserveValue) valueEl.value = '';
    valueEl.placeholder = 'No discount';
    valueEl.step = '0.01';
    valueEl.min = '0';
    valueEl.removeAttribute('max');
  }
}
function ensureNonOverlappingPromos(list) {
  const byVendor = new Map();
  (Array.isArray(list) ? list : []).forEach(p => {
    const key = String(p.vendorCode || '').trim().toLowerCase();
    if (!key) return;
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key).push(p);
  });
  const result = [];
  byVendor.forEach(arr => {
    const sorted = arr.slice().sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
    let lastEnd = -Infinity;
    sorted.forEach(p => {
      if (Number.isFinite(p.startTs) && Number.isFinite(p.endTs) && p.startTs > lastEnd) {
        result.push(p);
        lastEnd = p.endTs;
      }
    });
  });
  return result;
}
function normalizeVendorPromotions(list) {
  const arr = Array.isArray(list) ? list : [];
  const normalized = arr
    .map((p) => {
      const vendorCode = String(p?.vendorCode || '').trim();
      const vendorName = String(p?.vendorName || '').trim();
      const type = p?.type === 'amount' ? 'amount' : 'percent';
      const rawValue = Number(p?.value || 0);
      const value = type === 'percent' ? Math.max(0, Math.min(100, rawValue)) : Math.max(0, rawValue);
      const startDate = String(p?.startDate || '').trim();
      const endDate = String(p?.endDate || '').trim();
      const startTsRaw = Date.parse(`${startDate}T00:00:00`);
      const endTsRaw = Date.parse(`${endDate}T23:59:59`);
      if (!vendorCode || !startDate || !endDate) return null;
      if (!Number.isFinite(startTsRaw) || !Number.isFinite(endTsRaw)) return null;
      if (value <= 0) return null;
      const swap = startTsRaw > endTsRaw;
      const startTs = swap ? endTsRaw : startTsRaw;
      const endTs = swap ? startTsRaw : endTsRaw;
      return {
        id: String(p?.id || `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`),
        vendorCode,
        vendorName,
        type,
        value,
        startDate: swap ? endDate : startDate,
        endDate: swap ? startDate : endDate,
        startTs,
        endTs,
        vendorCodeLower: vendorCode.toLowerCase(),
        vendorNameLower: vendorName.toLowerCase()
      };
    })
    .filter(Boolean);
  return ensureNonOverlappingPromos(normalized);
}
function promoDateRangeIncludes(promo, dateObj) {
  if (!promo || !dateObj) return false;
  try {
    const d = new Date(dateObj);
    const compareTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Number.isFinite(promo.startTs) && Number.isFinite(promo.endTs)
      ? (compareTs >= promo.startTs && compareTs <= promo.endTs)
      : false;
  } catch (_) { return false; }
}
function currentSaleDateForPromos() {
  try {
    const bd = document.getElementById('backdateToggle');
    if (bd && bd.checked) return null;
  } catch (_) { }
  return new Date();
}
function findActiveVendorPromo(vendorCode, vendorName, saleDate) {
  const dateToUse = saleDate || currentSaleDateForPromos();
  if (!dateToUse) return null;
  const codeLc = String(vendorCode || '').trim().toLowerCase();
  const nameLc = String(vendorName || '').trim().toLowerCase();
  if (!__vendorPromotions || !__vendorPromotions.length) return null;
  return __vendorPromotions.find(p => {
    const matches = (p.vendorCodeLower && codeLc && p.vendorCodeLower === codeLc) ||
      (p.vendorNameLower && nameLc && p.vendorNameLower === nameLc);
    if (!matches) return false;
    return promoDateRangeIncludes(p, dateToUse);
  }) || null;
}
function clearAutoVendorPromo(typeEl, valueEl, reasonEl) {
  const isAuto = !!(typeEl && typeEl.dataset && typeEl.dataset.autoVendorPromo === '1');
  if (!isAuto) return;
  if (typeEl) {
    typeEl.value = 'none';
    try { delete typeEl.dataset.autoVendorPromo; delete typeEl.dataset.manualDiscount; } catch (_) { }
  }
  if (valueEl) valueEl.value = '';
  if (reasonEl) resetSelectToPlaceholder(reasonEl);
  syncDiscountReasonDisabledState(typeEl, reasonEl);
}
function markDiscountManual(typeEl, valueEl, reasonEl) {
  [typeEl, valueEl, reasonEl].forEach(el => {
    try {
      if (el && el.dataset) {
        el.dataset.manualDiscount = '1';
        delete el.dataset.autoVendorPromo;
      }
    } catch (_) { }
  });
}
function applyVendorPromoToFields(vendorValue, typeEl, valueEl, reasonEl, options = {}) {
  if (!typeEl || !valueEl) return null;
  const saleDate = currentSaleDateForPromos();
  if (!saleDate) {
    clearAutoVendorPromo(typeEl, valueEl, reasonEl);
    return null;
  }
  const vendorRaw = String(vendorValue || '').trim();
  if (!vendorRaw) {
    if (options.clearWhenMissingVendor) clearAutoVendorPromo(typeEl, valueEl, reasonEl);
    return null;
  }
  const vendorObj = findVendorStrict(__vendorsCache, vendorRaw) || bestVendorMatch(__vendorsCache, vendorRaw);
  const vendorCode = vendorObj?.code || vendorRaw;
  const vendorName = vendorObj?.name || vendorRaw;
  const promo = findActiveVendorPromo(vendorCode, vendorName, saleDate);
  const isAuto = !!(typeEl.dataset && typeEl.dataset.autoVendorPromo === '1');
  const hasManual = !!(typeEl.dataset && typeEl.dataset.manualDiscount === '1');
  const hasDiscountSet = (typeEl.value && typeEl.value !== 'none') || !!valueEl.value;
  if (!promo) {
    clearAutoVendorPromo(typeEl, valueEl, reasonEl);
    return null;
  }
  if (options.onlyWhenEmptyOrAuto && !isAuto && hasDiscountSet) return promo;
  if (options.respectManual !== false && hasManual && !isAuto) return promo;

  typeEl.value = promo.type === 'amount' ? 'amount' : 'percent';
  applyDiscountTypeState(typeEl, valueEl, { preserveValue: true });
  valueEl.value = promo.value;
  if (reasonEl) {
    const reasonVal = 'Vendor Promo';
    const exists = [...reasonEl.options].some(o => String(o.value || '') === reasonVal);
    if (!exists) {
      const opt = document.createElement('option');
      opt.value = reasonVal;
      opt.textContent = reasonVal;
      reasonEl.appendChild(opt);
    }
    reasonEl.disabled = false;
    reasonEl.value = reasonVal;
  }
  syncDiscountReasonDisabledState(typeEl, reasonEl);
  [typeEl, valueEl, reasonEl].forEach(el => {
    try {
      if (el && el.dataset) {
        el.dataset.autoVendorPromo = '1';
        el.dataset.manualDiscount = '0';
      }
    } catch (_) { }
  });
  return promo;
}
function applyVendorPromoToEntry(options = {}) {
  try {
    const vendorEl = document.getElementById('itemVendor');
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');
    return applyVendorPromoToFields(vendorEl?.value || '', typeEl, valueEl, reasonEl, options);
  } catch (_) { return null; }
}
function applyVendorPromoToEdit(options = {}) {
  try {
    const vendorEl = document.getElementById('edit_vendor');
    const typeEl = document.getElementById('edit_discountType');
    const valueEl = document.getElementById('edit_discountValue');
    const reasonEl = document.getElementById('edit_discountReason');
    return applyVendorPromoToFields(vendorEl?.value || '', typeEl, valueEl, reasonEl, options);
  } catch (_) { return null; }
}
function setupEntryDiscountControls() {
  const typeEl = document.getElementById('discountType');
  const valueEl = document.getElementById('discountValue');
  const reasonEl = document.getElementById('discountReason');
  try { setDiscountReasonOptions(reasonEl, __discountReasons); } catch (_) { }
  if (!typeEl || !valueEl) return;
  const syncState = () => {
    applyDiscountTypeState(typeEl, valueEl);
    syncDiscountReasonDisabledState(typeEl, reasonEl);
    if (typeEl.value === 'none' && valueEl) valueEl.value = '';
  };
  typeEl.addEventListener('change', () => { markDiscountManual(typeEl, valueEl, reasonEl); syncState(); });
  try { valueEl.addEventListener('input', () => markDiscountManual(typeEl, valueEl, reasonEl)); } catch (_) { }
  try { reasonEl?.addEventListener('change', () => markDiscountManual(typeEl, valueEl, reasonEl)); } catch (_) { }
  syncState();
}
function installNavigationGuards() {
  try {
    // Track dirty carts for next session without prompting.
    window.addEventListener('beforeunload', () => {
      try {
        if (__isQuitting) {
          try { localStorage.removeItem(__TABS_STORAGE_KEY); } catch (_) { }
          return;
        }
        if (__hasDirtyCarts()) {
          try { sessionStorage.setItem('posDirtyNavToast', '1'); } catch (_) { }
        }
      } catch (_) { }
    });
  } catch (_) { }
}

// ---------- Data ----------
async function fetchVendors() { return (await invoke('vendors:load')) || []; }
async function fetchCashiers() { return (await invoke('cashiers:load')) || []; }
async function ensureGiftCardVendor() {
  const list = await fetchVendors();
  const vendors = Array.isArray(list) ? list : [];
  const existing = findVendorStrict(vendors, GIFT_CARD_VENDOR_CODE) || findVendorStrict(vendors, GIFT_CARD_VENDOR_NAME);
  if (existing) {
    __vendorsCache = vendors;
    return existing;
  }
  vendors.push({
    name: GIFT_CARD_VENDOR_NAME,
    code: GIFT_CARD_VENDOR_CODE,
    phone: '',
    email: ''
  });
  try {
    await invoke('vendors:create', {
      name: GIFT_CARD_VENDOR_NAME,
      code: GIFT_CARD_VENDOR_CODE,
      phone: '',
      email: ''
    });
  } catch (err) {
    if (err?.status !== 409) throw err;
  }
  const refreshed = await fetchVendors();
  __vendorsCache = Array.isArray(refreshed) ? refreshed : vendors;
  try { setVendorDatalistOptions(__vendorsCache); } catch (_) { }
  return findVendorStrict(__vendorsCache, GIFT_CARD_VENDOR_CODE) || null;
}

// ---------- Vendors (datalist + filtering) ----------
async function loadVendorsIntoDatalist() {
  const vendorList = document.getElementById('vendorList');
  if (!vendorList) return;
  vendorList.innerHTML = '';
  const vendors = await fetchVendors();
  __vendorsCache = Array.isArray(vendors) ? vendors : [];
  setVendorDatalistOptions();
}
function setVendorDatalistOptions(vendorsIn) {
  const vendorList = document.getElementById('vendorList');
  if (!vendorList) return;
  vendorList.innerHTML = '';
  const list = Array.isArray(vendorsIn) && vendorsIn.length ? vendorsIn : (__vendorsCache || []);
  const sorted = [...list].sort((a, b) => {
    const codeA = (a?.code || '').trim();
    const codeB = (b?.code || '').trim();
    if (codeA && codeB) {
      const cmp = codeA.localeCompare(codeB, undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
    if (codeA && !codeB) return -1;
    if (!codeA && codeB) return 1;
    const nameA = (a?.name || '').trim();
    const nameB = (b?.name || '').trim();
    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
  });
  // Deduplicate by code if present, otherwise by name
  const seen = new Set();
  sorted.forEach(v => {
    const code = (v?.code || '').trim();
    const name = (v?.name || '').trim();
    const key = code || name;
    if (!key || seen.has(key.toLowerCase())) return;
    seen.add(key.toLowerCase());
    const opt = document.createElement('option');
    opt.value = code || name; // choose code so selecting fills input with the code
    // Show "CODE - Name" during search suggestions
    const parts = [];
    if (code) parts.push(code);
    if (name) parts.push(name);
    const label = parts.join(' - ');
    if (label) opt.label = label;
    vendorList.appendChild(opt);
  });
}
function updateVendorDatalistForValue(valRaw) {
  const s = norm(valRaw);
  if (!s) { setVendorDatalistOptions(); return; }
  const matches = (__vendorsCache || []).filter(v =>
    norm(v.name).includes(s) || norm(v.code || '').includes(s)
  );
  setVendorDatalistOptions(matches);
}
// Apply the currently filtered list's first option to the input (emulates picking the highlighted option)
function applyFirstVendorOption(el) {
  try {
    const listEl = document.getElementById('vendorList');
    if (!el || !listEl || !listEl.options || !listEl.options.length) return false;
    const first = listEl.options[0];
    const val = String(first?.value || first?.label || '').trim();
    if (!val) return false;
    el.value = val;
    return true;
  } catch (_) { return false; }
}
function findVendorLoose(vendors, input) {
  const s = norm(input);
  if (!s) return null;
  return (
    vendors.find(v => norm(v.name) === s || norm(v.code || '') === s) ||
    vendors.find(v => norm(v.code || '').replace(/\s+/g, '') === s.replace(/\s+/g, '')) ||
    vendors.find(v => norm(v.name).includes(s)) || null
  );
}
// Strict match: only consider exact name/code combos that already exist.
function findVendorStrict(vendors, input) {
  const s = norm(input);
  if (!s) return null;
  const safe = Array.isArray(vendors) ? vendors : [];
  return safe.find(v => {
    const code = norm(v.code || '');
    const name = norm(v.name || '');
    if (!code && !name) return false;
    if (code === s || name === s) return true;
    if (code.replace(/\s+/g, '') === s.replace(/\s+/g, '')) return true;
    return false;
  }) || null;
}

function findCashierStrict(cashiers, input) {
  const s = norm(input);
  if (!s) return null;
  const safe = Array.isArray(cashiers) ? cashiers : [];
  return safe.find(c => norm(c.name || '') === s) || null;
}

// Choose the closest vendor match for partial input.
function bestVendorMatch(vendors, input) {
  const s = norm(input);
  if (!s) return null;
  let best = null;
  let bestScore = -Infinity;
  const safe = Array.isArray(vendors) ? vendors : [];
  for (const v of safe) {
    const code = norm(v.code || '');
    const name = norm(v.name || '');
    if (!code && !name) continue;
    let score = -1;
    if (code === s || name === s) score = 1000 - Math.min((v.code || '').length, (v.name || '').length);
    else if (code.replace(/\s+/g, '') === s.replace(/\s+/g, '')) score = 990 - (v.code || '').length;
    else if (code.startsWith(s)) score = 950 - (v.code || '').length;
    else if (name.startsWith(s)) score = 900 - (v.name || '').length;
    else if (code.includes(s)) score = 800 - (code.indexOf(s));
    else if (name.includes(s)) score = 780 - (name.indexOf(s));
    if (score > bestScore) { bestScore = score; best = v; }
  }
  return best;
}
async function normalizeVendorInput(el) {
  try {
    const val = (el?.value || '').trim();
    if (!val) return;
    const list = __vendorsCache.length ? __vendorsCache : await fetchVendors();
    __vendorsCache = Array.isArray(list) ? list : [];
    const v = findVendorStrict(__vendorsCache, val);
    if (v?.code) el.value = v.code;
  } catch (_) { }
}

// ---------- Cashiers ----------
async function loadCashiersIntoSelect(target = 'cashierSelect') {
  const sel = typeof target === 'string' ? document.getElementById(target) : target;
  if (!sel) return;
  const prev = sel.value || '';
  sel.innerHTML = '';
  let list = await fetchCashiers();
  if (!Array.isArray(list)) list = [];
  ensurePlaceholder(sel);
  list.forEach(c => { const opt = document.createElement('option'); opt.value = c.name; opt.textContent = c.name; sel.appendChild(opt); });
  // Preserve previous selection if still present
  try { if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev; } catch (_) { }
}

// ---------- POS actions ----------
async function addItem() {
  const nameEl = document.getElementById('itemName');
  const priceEl = document.getElementById('itemPrice');
  const qtyEl = document.getElementById('itemQty');
  const vendorEl = document.getElementById('itemVendor');
  const commentEl = document.getElementById('itemComment');
  const discountTypeEl = document.getElementById('discountType');
  const discountValueEl = document.getElementById('discountValue');
  const discountReasonEl = document.getElementById('discountReason');
  const name = (nameEl.value || '').trim();
  const normalizedName = normalizeItemName(name);
  const priceRaw = priceEl.value;
  const price = toMoneyNumber(priceRaw);
  let qtyRaw = (qtyEl?.value || '1').trim();
  let qty = parseInt(qtyRaw, 10);
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  const vendorName = (vendorEl.value || '').trim();
  const comment = (commentEl?.value || '').trim();
  clearFieldError(nameEl); clearFieldError(priceEl); clearFieldError(vendorEl); clearFieldError(discountReasonEl);
  try { applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
  const priceProvided = String(priceRaw || '').trim() !== '';
  if (!name || !priceProvided || isNaN(price)) {
    showToast('Enter a valid item name and price.', { type: 'error' });
    try { nameEl?.focus(); } catch (_) { }
    markFieldError(nameEl);
    markFieldError(priceEl, () => {
      const raw = priceEl?.value;
      const provided = String(raw || '').trim() !== '';
      const num = toMoneyNumber(raw);
      return provided && !isNaN(num);
    });
    return;
  }
  // Safeguard: vendor is required to add to cart
  if (!vendorName) {
    showToast('Please enter a vendor (name or code).', { type: 'error' });
    try { vendorEl?.focus(); } catch (_) { }
    markFieldError(vendorEl);
    return;
  }
  const originalPrice = toMoneyNumber(price);
  const typeVal = discountTypeEl?.value || 'none';
  const discountValueRaw = discountValueEl?.value;
  const discountReasonRaw = (discountReasonEl?.value || '').trim();
  const discount = computeDiscount(originalPrice, typeVal, discountValueRaw, discountReasonRaw);
  if (discount.amount > 0 && !discount.reason) {
    showToast('Please enter a discount reason.', { type: 'error' });
    try { discountReasonEl?.focus(); } catch (_) { }
    markFieldError(discountReasonEl);
    return;
  }
  const finalPrice = finalPriceFrom(originalPrice, discount.amount);

  const list = __vendorsCache.length ? __vendorsCache : await fetchVendors();
  __vendorsCache = Array.isArray(list) ? list : [];
  const v = findVendorStrict(__vendorsCache, vendorName);
  if (__vendorsCache.length && !v) {
    showToast('Please Enter a Valid Vendor.', { type: 'error' });
    try { vendorEl?.focus(); } catch (_) { }
    markFieldError(vendorEl, () => !!findVendorStrict(__vendorsCache, (vendorEl?.value || '').trim()));
    return;
  }
  const vendorFinal = v ? (v.code || v.name) : (vendorName || 'Unknown');

  items.push({
    name: normalizedName,
    price: finalPrice,
    originalPrice,
    quantity: qty,
    vendorName: vendorFinal,
    comment,
    discountType: discount.type,
    discountValue: discount.value,
    discountAmount: discount.amount,
    discountReason: discount.amount > 0 ? discount.reason : ''
  });

  nameEl.value = ''; priceEl.value = ''; if (qtyEl) qtyEl.value = '1'; vendorEl.value = ''; if (commentEl) commentEl.value = '';
  if (discountTypeEl) {
    discountTypeEl.value = 'none';
    applyDiscountTypeState(discountTypeEl, discountValueEl);
  }
  if (discountValueEl) discountValueEl.value = '';
  if (discountReasonEl) discountReasonEl.value = '';
  renderTable();
  // Return focus to the first entry field for rapid entry
  try { nameEl.focus(); } catch (_) { }
  // Persist current tab state after adding an item
  try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
}

async function addGiftCardSaleItem() {
  const modalEl = document.getElementById('giftCardSaleModal');
  if (!modalEl || !window.bootstrap) {
    showToast('Gift card sale modal is unavailable.', { type: 'error' });
    return;
  }
  if (!__giftCardSaleModal) {
    __giftCardSaleModal = new bootstrap.Modal(modalEl);
  }
  const amountEl = document.getElementById('giftCardSaleAmount');
  const selectEl = document.getElementById('giftCardSaleSelect');
  const hintEl = document.getElementById('giftCardSaleHint');
  const emptyEl = document.getElementById('giftCardSaleEmpty');
  const fieldsEl = document.getElementById('giftCardSaleFields');
  const confirmBtn = document.getElementById('giftCardSaleConfirmBtn');
  if (amountEl) amountEl.value = '';
  if (hintEl) hintEl.textContent = '';
  if (selectEl) selectEl.innerHTML = '<option value="" selected disabled>Select a card...</option>';
  if (confirmBtn) confirmBtn.disabled = true;

  const data = await fetchGiftCardsData();
  const cards = Array.isArray(data?.cards) ? data.cards : [];
  const books = Array.isArray(data?.books) ? data.books : [];
  const available = cards.filter(c => String(c.status || '') === 'available');
  available.sort((a, b) => String(a.number || '').localeCompare(String(b.number || '')));
  if (!available.length) {
    if (emptyEl) emptyEl.classList.remove('d-none');
    if (fieldsEl) fieldsEl.classList.add('d-none');
    if (confirmBtn) confirmBtn.disabled = true;
    __giftCardSaleModal.show();
    return;
  }
  if (emptyEl) emptyEl.classList.add('d-none');
  if (fieldsEl) fieldsEl.classList.remove('d-none');
  if (selectEl) {
    available.forEach(card => {
      const opt = document.createElement('option');
      const bookName = giftCardBookLabel(card.bookId, books);
      opt.value = String(card.number || '');
      opt.textContent = bookName ? `${card.number} (${bookName})` : String(card.number || '');
      selectEl.appendChild(opt);
    });
  }
  if (hintEl) hintEl.textContent = `${available.length} card${available.length === 1 ? '' : 's'} available.`;
  if (confirmBtn) confirmBtn.disabled = false;
  __giftCardSaleModal.show();
  setTimeout(() => { try { amountEl?.focus(); } catch (_) { } }, 120);
}

async function confirmGiftCardSaleItem() {
  const amountEl = document.getElementById('giftCardSaleAmount');
  const selectEl = document.getElementById('giftCardSaleSelect');
  const rawAmount = String(amountEl?.value || '').trim();
  const amount = toMoneyNumber(rawAmount);
  const cardNumber = String(selectEl?.value || '').trim();
  if (!rawAmount || !Number.isFinite(amount) || amount <= 0) {
    showToast('Enter a valid gift card amount.', { type: 'error' });
    try { amountEl?.focus(); } catch (_) { }
    return;
  }
  if (!cardNumber) {
    showToast('Select an available gift card.', { type: 'error' });
    try { selectEl?.focus(); } catch (_) { }
    return;
  }
  try { await ensureGiftCardVendor(); } catch (_) { }
  items.push({
    name: GIFT_CARD_ITEM_NAME,
    price: amount,
    originalPrice: amount,
    quantity: 1,
    vendorName: GIFT_CARD_VENDOR_CODE,
    comment: `Card #${cardNumber}`,
    discountType: 'none',
    discountValue: 0,
    discountAmount: 0,
    discountReason: ''
  });
  renderTable();
  try { if (__giftCardSaleModal) __giftCardSaleModal.hide(); } catch (_) { }
  try { document.getElementById('itemName')?.focus(); } catch (_) { }
  try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
}

function clearItemEntry() {
  try {
    const nameEl = document.getElementById('itemName');
    const priceEl = document.getElementById('itemPrice');
    const qtyEl = document.getElementById('itemQty');
    const vendorEl = document.getElementById('itemVendor');
    const commentEl = document.getElementById('itemComment');
    const discountTypeEl = document.getElementById('discountType');
    const discountValueEl = document.getElementById('discountValue');
    const discountReasonEl = document.getElementById('discountReason');
    clearPosErrors();

    if (nameEl) nameEl.value = '';
    if (priceEl) priceEl.value = '';
    if (qtyEl) qtyEl.value = '1';
    if (vendorEl) vendorEl.value = '';
    if (commentEl) commentEl.value = '';
    if (discountTypeEl) discountTypeEl.value = 'none';
    if (discountValueEl) discountValueEl.value = '';
    if (discountReasonEl) resetSelectToPlaceholder(discountReasonEl);
    try { [discountTypeEl, discountValueEl, discountReasonEl].forEach(el => { if (el && el.dataset) { delete el.dataset.autoVendorPromo; delete el.dataset.manualDiscount; } }); } catch (_) { }
    if (discountTypeEl && discountValueEl) applyDiscountTypeState(discountTypeEl, discountValueEl);
    if (discountTypeEl && discountReasonEl) syncDiscountReasonDisabledState(discountTypeEl, discountReasonEl);

    try { nameEl?.focus(); } catch (_) { }
    // Persist current tab state after clearing
    try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
  } catch (_) { }
}
function removeItem(i) {
  items.splice(i, 1);
  renderTable();
  // Persist current tab state after removing an item
  try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
}

// ---------- Edit modal ----------
function ensureEditModal() {
  if (!__editModal) {
    const el = document.getElementById('editItemModal');
    if (el && window.bootstrap) __editModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: true });
    const typeEl = document.getElementById('edit_discountType');
    const valueEl = document.getElementById('edit_discountValue');
    const reasonEl = document.getElementById('edit_discountReason');
    if (typeEl && valueEl && !typeEl.dataset._wired) {
      typeEl.addEventListener('change', () => {
        markDiscountManual(typeEl, valueEl, reasonEl);
        applyDiscountTypeState(typeEl, valueEl, { preserveValue: true });
        syncDiscountReasonDisabledState(typeEl, reasonEl);
      });
      try { valueEl.addEventListener('input', () => markDiscountManual(typeEl, valueEl, reasonEl)); } catch (_) { }
      try { reasonEl?.addEventListener('change', () => markDiscountManual(typeEl, valueEl, reasonEl)); } catch (_) { }
      typeEl.dataset._wired = '1';
    }
  }
  return __editModal;
}
function openEditModal(i) {
  const it = items[i];
  if (!it) return;
  ensureEditModal();
  document.getElementById('edit_name').value = it.name || '';
  document.getElementById('edit_price').value = deriveOriginalPrice(it);
  const qtyEl = document.getElementById('edit_qty');
  if (qtyEl) qtyEl.value = String(Math.max(1, parseInt(it.quantity || 1, 10)));
  document.getElementById('edit_vendor').value = it.vendorName || '';
  document.getElementById('edit_comment').value = it.comment || '';
  const editTypeEl = document.getElementById('edit_discountType');
  const editValueEl = document.getElementById('edit_discountValue');
  const editReasonEl = document.getElementById('edit_discountReason');
  const hasDisc = itemHasDiscount(it);
  const type = hasDisc ? (it.discountType === 'percent' ? 'percent' : 'amount') : 'none';
  if (editTypeEl) editTypeEl.value = type;
  if (editValueEl) {
    if (type === 'percent') editValueEl.value = String(toMoneyNumber(it.discountValue || 0));
    else if (type === 'amount') editValueEl.value = money(it.discountAmount || 0);
    else editValueEl.value = '';
    applyDiscountTypeState(editTypeEl, editValueEl, { preserveValue: true });
  }
  if (editReasonEl) setDiscountReasonOptions(editReasonEl, __discountReasons, hasDisc ? (it.discountReason || '') : '');
  if (editTypeEl && editReasonEl) syncDiscountReasonDisabledState(editTypeEl, editReasonEl);
  try { applyVendorPromoToEdit({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
  const saveBtn = document.getElementById('edit_save_btn');
  saveBtn.dataset.index = String(i);
  __editModal?.show();
}
async function saveEditFromModal() {
  const btn = document.getElementById('edit_save_btn');
  const idx = Number(btn?.dataset?.index || -1);
  if (!(idx >= 0 && items[idx])) { __editModal?.hide(); return; }
  const nameEl = document.getElementById('edit_name');
  const priceEl = document.getElementById('edit_price');
  const qtyEl = document.getElementById('edit_qty');
  const vendorEl = document.getElementById('edit_vendor');
  const commentEl = document.getElementById('edit_comment');
  const name = (nameEl?.value || '').trim();
  const normalizedName = normalizeItemName(name);
  const priceRaw = priceEl?.value;
  const price = toMoneyNumber(priceRaw);
  let qty = parseInt((qtyEl?.value || '1'), 10); if (!Number.isFinite(qty) || qty < 1) qty = 1;
  const vendorName = (vendorEl?.value || '').trim();
  const comment = (commentEl?.value || '').trim();
  clearFieldError(nameEl); clearFieldError(priceEl); clearFieldError(vendorEl);
  try { applyVendorPromoToEdit({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
  const priceProvided = String(priceRaw || '').trim() !== '';
  if (!name || !priceProvided || isNaN(price)) {
    showToast('Enter a valid item name and price.', { type: 'error' });
    try { nameEl?.focus(); } catch (_) { }
    markFieldError(nameEl);
    markFieldError(priceEl, () => {
      const raw = priceEl?.value;
      const provided = String(raw || '').trim() !== '';
      const num = toMoneyNumber(raw);
      return provided && !isNaN(num);
    });
    return;
  }
  // Safeguard: vendor is required when saving edits
  if (!vendorName) {
    showToast('Please enter a vendor (name or code).', { type: 'error' });
    try { vendorEl?.focus(); } catch (_) { }
    markFieldError(vendorEl);
    return;
  }
  const originalPrice = toMoneyNumber(price);
  const typeEl = document.getElementById('edit_discountType');
  const valueEl = document.getElementById('edit_discountValue');
  const reasonEl = document.getElementById('edit_discountReason');
  clearFieldError(reasonEl);
  const discountType = typeEl?.value || 'none';
  const discountValue = valueEl?.value;
  const discountReason = (reasonEl?.value || '').trim();
  const discount = computeDiscount(originalPrice, discountType, discountValue, discountReason);
  if (discount.amount > 0 && !discount.reason) {
    showToast('Please enter a discount reason.', { type: 'error' });
    try { reasonEl?.focus(); } catch (_) { }
    markFieldError(reasonEl);
    return;
  }
  const finalPrice = finalPriceFrom(originalPrice, discount.amount);

  const list = __vendorsCache.length ? __vendorsCache : await fetchVendors();
  __vendorsCache = Array.isArray(list) ? list : [];
  const v = findVendorStrict(__vendorsCache, vendorName);
  const vendorFinal = v ? (v.code || v.name) : (vendorName || 'Unknown');

  items[idx] = {
    ...items[idx],
    name: normalizedName,
    price: finalPrice,
    originalPrice,
    quantity: qty,
    vendorName: vendorFinal,
    comment,
    discountType: discount.type,
    discountValue: discount.value,
    discountAmount: discount.amount,
    discountReason: discount.amount > 0 ? discount.reason : ''
  };

  __editModal?.hide();
  renderTable();
  // Persist current tab state after editing an item
  try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
}

// ---------- Table & totals ----------
function renderTable() {
  const tbody = document.querySelector('#itemTable tbody');
  tbody.innerHTML = '';
  let subtotal = 0;
  let giftCardSubtotal = 0;
  const customerItems = [];
  items.forEach((it, i) => {
    const qty = Math.max(1, parseInt(it.quantity || 1, 10));
    const finalPrice = toMoneyNumber(it.price || 0); // unit final
    const discountAmount = toMoneyNumber(it.discountAmount || 0);
    const originalPrice = deriveOriginalPrice(it); // unit original
    const hasDiscount = discountAmount > 0;
    const reason = hasDiscount ? String(it.discountReason || '').trim() : '';
    const discountSuffix = hasDiscount ? buildDiscountSuffix(it.discountType, it.discountValue, discountAmount, reason, escapeHtml) : '';
    const lineTotal = toMoneyNumber(finalPrice * qty);
    subtotal += lineTotal;
    if (isGiftCardSaleItem(it)) giftCardSubtotal += lineTotal;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(it.name)}${it.comment ? `<div class="text-muted small">${escapeHtml(it.comment)}</div>` : ''}</td>
      <td class="text-center">${qty}</td>
      <td class="text-end">
        <div class="fw-semibold">$${money(lineTotal)}</div>
        ${qty > 1 ? `<div class=\"text-muted small\">${qty} × $${money(finalPrice)} each</div>` : ''}
        ${hasDiscount ? `<div class="text-muted small text-decoration-line-through">Original (unit): $${money(originalPrice)}</div>` : ''}
        ${hasDiscount ? `<div class="text-danger small">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
      </td>
      <td>${escapeHtml(it.vendorName || '')}</td>
      <td>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-primary" onclick="openEditModal(${i})">Edit</button>
          <button class="btn btn-outline-danger" onclick="removeItem(${i})">Remove</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
    customerItems.push({
      name: String(it.name || ''),
      quantity: qty,
      unitPrice: finalPrice,
      total: lineTotal,
      discountAmount,
      originalPrice,
      discountSuffix,
      discountType: String(it.discountType || ''),
      discountValue: String(it.discountValue || ''),
      discountReason: reason,
      hasDiscount,
      vendorName: String(it.vendorName || ''),
      comment: String(it.comment || '')
    });
  });
  const paymentSelect = document.getElementById('paymentSelect');
  const paymentValue = String(paymentSelect?.value || (__carts.get(__activeCartId) || {}).payment || '');
  const splitEnabled = isSplitTenderEnabled();
  const splitTenderType = document.getElementById('splitTenderType')?.value || '';
  const splitTenderAmountRaw = document.getElementById('splitTenderAmount')?.value || '';
  const splitTenderAmountValue = toMoneyNumber(splitTenderAmountRaw);
  const taxableSubtotal = Math.max(0, subtotal - giftCardSubtotal);
  const tax = __taxExempt ? 0 : toMoneyNumber(taxableSubtotal * TAX_RATE);
  const cardFee = getGiftCardFee(
    giftCardSubtotal,
    subtotal,
    tax,
    paymentValue,
    splitEnabled,
    splitTenderType,
    splitTenderAmountValue
  );
  const total = toMoneyNumber(subtotal + tax + cardFee);
  const cashReceivedRaw = getCashReceivedRaw();
  const cashReceivedAmount = toMoneyNumber(cashReceivedRaw);
  const cashDue = getCashDue(total);
  const changeDue = isCashTenderSelected()
    ? Math.max(0, cashReceivedAmount - cashDue)
    : 0;
  const cartMeta = __carts.get(__activeCartId) || {};
  const cashierSelect = document.getElementById('cashierSelect');
  const cashierValue = String(cashierSelect?.value || cartMeta.cashier || '');
  const payload = {
    cartId: String(__activeCartId || ''),
    cartTitle: String(cartMeta.title || ''),
    cashier: cashierValue,
    payment: paymentValue,
    splitTenderEnabled: isSplitTenderEnabled(),
    splitTenderType,
    splitTenderAmount: splitTenderAmountRaw,
    items: customerItems,
    subtotal,
    tax,
    total,
    cardFee,
    cashReceived: cashReceivedRaw,
    changeDue
  };
  sendCustomerCartState(payload);
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('subtotal', money(subtotal));
  set('tax', money(tax));
  set('cardFeeAmount', money(cardFee));
  try {
    const feeRow = document.getElementById('cardFeeRow');
    if (feeRow) feeRow.classList.toggle('d-none', !(cardFee > 0));
  } catch (_) { }
  set('total', money(total));
  __lastTotal = toMoneyNumber(total);
  try { updateCashChange(); } catch (_) { }
  try { updateGiftCardAmountDefault(); } catch (_) { }
  try { updateSplitTenderAmountDefault(); } catch (_) { }
}

function dispatchCustomerCartState(payload) {
  if (!payload) return;
  try {
    if (typeof send === 'function') {
      send('cart:state', payload);
    }
  } catch (_) {
    // Silence failures when IPC is unavailable (tests, background tasks)
  }
}

function sendCustomerCartState(payload) {
  if (!payload) return;
  __lastCustomerCartState = payload;
  dispatchCustomerCartState(payload);
}

function refreshCustomerCartStateFromCashFields() {
  if (!__lastCustomerCartState) return;
  const cashReceivedRaw = getCashReceivedRaw();
  const cashReceivedAmount = toMoneyNumber(cashReceivedRaw);
  const total = toMoneyNumber(__lastCustomerCartState.total || 0);
  const cashDue = getCashDue(total);
  const changeDue = isCashTenderSelected()
    ? Math.max(0, cashReceivedAmount - cashDue)
    : 0;
  const nextPayload = {
    ...__lastCustomerCartState,
    cashReceived: cashReceivedRaw,
    changeDue
  };
  sendCustomerCartState(nextPayload);
}

// ---------- Sound ----------
function playCashRegisterSound() {
  // Play only the ka-ching MP3 (no synthesized pre-tone)
  try {
    // In test/jsdom or environments without media, skip playing
    const ua = (typeof navigator !== 'undefined' && navigator && navigator.userAgent) ? String(navigator.userAgent) : '';
    if (/jsdom/i.test(ua)) return;
    if (typeof Audio !== 'function') return;

    if (typeof __cashAudio === 'object' && __cashAudio) {
      try { __cashAudio.currentTime = 0; } catch (_) { }
      const p = __cashAudio.play && __cashAudio.play();
      if (p && typeof p.catch === 'function') p.catch(() => { });
      return;
    }
    const audio = new Audio('assets/cash-register-kaching-sound-effect-125042.mp3');
    audio.volume = 0.8;
    const p = audio.play && audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => { });
  } catch (_) { }
}

// ---------- Print & save ----------
async function printReceipt() {
  // Prevent printing/saving when cart is empty
  try {
    if (!cartHasItems()) {
      const nameEl = document.getElementById('itemName');
      clearFieldError(nameEl);
      showToast('Please add at least one item before printing & saving.', { type: 'error' });
      try { nameEl?.focus(); } catch (_) { }
      markFieldError(nameEl, () => cartHasItems());
      return;
    }
  } catch (_) { }

  const cashierSelect = document.getElementById('cashierSelect');
  const paymentSelect = document.getElementById('paymentSelect');
  const cashEl = document.getElementById('cashReceived');
  const giftNumberEl = document.getElementById('giftCardNumber');
  const giftAmountEl = document.getElementById('giftCardAmount');
  const splitToggle = document.getElementById('splitTenderToggle');
  const splitTypeEl = document.getElementById('splitTenderType');
  const splitAmountEl = document.getElementById('splitTenderAmount');
  clearFieldError(cashierSelect); clearFieldError(paymentSelect); clearFieldError(cashEl);
  clearFieldError(giftNumberEl); clearFieldError(giftAmountEl);
  clearFieldError(splitTypeEl); clearFieldError(splitAmountEl);
  const cashier = cashierSelect?.value || '';
  const payment = paymentSelect?.value || '';
  const isBackdated = !!document.getElementById('backdateToggle')?.checked;
  const receiptToggle = document.getElementById('receiptWanted');
  const wantsReceipt = receiptToggle ? !!receiptToggle.checked : true;
  const totalDue = toMoneyNumber(__lastTotal || 0);
  const splitEnabled = !!splitToggle?.checked;
  const splitType = splitTypeEl?.value || '';
  const splitAmountRaw = String(splitAmountEl?.value || '').trim();
  const splitAmount = splitAmountRaw ? toMoneyNumber(splitAmountRaw) : 0;
  if (!cashier) {
    showToast('Please select a cashier.', { type: 'error' });
    try { cashierSelect?.focus(); } catch (_) { }
    markFieldError(cashierSelect);
    return;
  }
  if (!payment) {
    showToast('Please select a payment type.', { type: 'error' });
    try { paymentSelect?.focus(); } catch (_) { }
    markFieldError(paymentSelect);
    return;
  }
  if (splitEnabled) {
    if (!splitType) {
      showToast('Select a second tender type.', { type: 'error' });
      try { splitTypeEl?.focus(); } catch (_) { }
      markFieldError(splitTypeEl);
      return;
    }
    if (splitAmountRaw) {
      if (isNaN(splitAmount) || splitAmount < 0) {
        showToast('Enter a valid non-negative split amount.', { type: 'error' });
        try { splitAmountEl?.focus(); } catch (_) { }
        markFieldError(splitAmountEl);
        return;
      }
      if (splitType !== 'Cash' && splitAmount > totalDue + 0.009) {
        showToast('Split amount cannot exceed the total due.', { type: 'error' });
        try { splitAmountEl?.focus(); } catch (_) { }
        markFieldError(splitAmountEl);
        return;
      }
    }
  }
  const cashTendered = (payment || '') === 'Cash' || (splitEnabled && splitType === 'Cash');
  let cashReceivedAmount = 0;
  let cashReceivedRaw = '';
  let cashFieldEl = null;
  // If Cash is selected, require a cash tendered amount
  if (cashTendered && !isBackdated) {
    cashFieldEl = splitEnabled && splitType === 'Cash' ? splitAmountEl : cashEl;
    cashReceivedRaw = splitEnabled && splitType === 'Cash'
      ? String(splitAmountEl?.value ?? '').trim()
      : String(cashEl?.value ?? '').trim();
    if (!cashReceivedRaw) {
      showToast('Enter the cash received from the customer.', { type: 'error' });
      try { cashFieldEl?.focus(); } catch (_) { }
      markFieldError(cashFieldEl);
      return;
    }
    const cashNum = toMoneyNumber(cashReceivedRaw);
    cashReceivedAmount = cashNum;
    if (isNaN(cashNum) || cashNum < 0) {
      showToast('Enter a valid non-negative cash amount.', { type: 'error' });
      try { cashFieldEl?.focus(); } catch (_) { }
      markFieldError(cashFieldEl, () => {
        const rawVal = splitEnabled && splitType === 'Cash'
          ? String(splitAmountEl?.value ?? '').trim()
          : String(cashEl?.value ?? '').trim();
        const parsed = toMoneyNumber(rawVal);
        return rawVal !== '' && !isNaN(parsed) && parsed >= 0;
      });
      return;
    }
  }
  let giftCardNumber = '';
  let giftCardAmount = 0;
  if ((payment || '') === 'Gift Card') {
    giftCardNumber = String(giftNumberEl?.value || '').trim();
    const rawAmount = String(giftAmountEl?.value || '').trim();
    giftCardAmount = rawAmount ? toMoneyNumber(rawAmount) : totalDue;
    if (splitEnabled && splitType === 'Cash' && Number.isFinite(__giftCardBalance)) {
      const fullAmount = Math.min(__giftCardBalance, totalDue);
      giftCardAmount = fullAmount;
      try {
        if (giftAmountEl) {
          giftAmountEl.value = money(fullAmount);
          giftAmountEl.dataset.autoValue = 'true';
        }
      } catch (_) { }
    }
    if (!giftCardNumber) {
      showToast('Enter the gift card number.', { type: 'error' });
      try { giftNumberEl?.focus(); } catch (_) { }
      markFieldError(giftNumberEl);
      return;
    }
    if (isNaN(giftCardAmount) || giftCardAmount <= 0) {
      showToast('Enter a valid gift card amount.', { type: 'error' });
      try { giftAmountEl?.focus(); } catch (_) { }
      markFieldError(giftAmountEl);
      return;
    }
    if (giftCardAmount > totalDue + 0.009) {
      showToast('Gift card amount cannot exceed the total due.', { type: 'error' });
      try { giftAmountEl?.focus(); } catch (_) { }
      markFieldError(giftAmountEl);
      return;
    }
    if (splitEnabled) {
      const remainder = totalDue - giftCardAmount;
      if (splitType === 'Cash') {
        if (!splitAmountRaw && remainder > 0.009) {
          showToast('Enter the cash received for the remaining balance.', { type: 'error' });
          try { splitAmountEl?.focus(); } catch (_) { }
          markFieldError(splitAmountEl);
          return;
        }
        if (splitAmountRaw && splitAmount + 0.009 < remainder) {
          showToast('Cash received must cover the remaining balance.', { type: 'error' });
          try { splitAmountEl?.focus(); } catch (_) { }
          markFieldError(splitAmountEl);
          return;
        }
      } else {
        if (!splitAmountRaw && remainder > 0.009) {
          showToast('Enter the second tender amount for the remaining balance.', { type: 'error' });
          try { splitAmountEl?.focus(); } catch (_) { }
          markFieldError(splitAmountEl);
          return;
        }
        if (splitAmountRaw && Math.abs(giftCardAmount + splitAmount - totalDue) > 0.009) {
          showToast('Gift card and second tender amounts must equal the total due.', { type: 'error' });
          try { splitAmountEl?.focus(); } catch (_) { }
          markFieldError(splitAmountEl);
          return;
        }
      }
    } else if (Math.abs(giftCardAmount - totalDue) > 0.009) {
      showToast('Gift card amount not enough to cover total, add a second tender to complete sale.', { type: 'error' });
      try { giftAmountEl?.focus(); } catch (_) { }
      markFieldError(giftAmountEl);
      return;
    }
  }
  if (splitEnabled && (payment || '') !== 'Gift Card') {
    if (!splitAmountRaw) {
      showToast('Enter the second tender amount.', { type: 'error' });
      try { splitAmountEl?.focus(); } catch (_) { }
      markFieldError(splitAmountEl);
      return;
    }
  }
  if (cashTendered && !isBackdated) {
    const cashDue = getCashDue(totalDue);
    if (cashReceivedAmount + 0.009 < cashDue) {
      showToast('Received amount doesn\'t cover the cart total.', { type: 'error' });
      try { cashFieldEl?.focus(); } catch (_) { }
      markFieldError(cashFieldEl);
      return;
    }
  }
  const cashiersList = await fetchCashiers();
  if (!Array.isArray(cashiersList) || !cashiersList.length) {
    showToast('Add at least one cashier in Manage Cashiers before saving sales.', { type: 'error' });
    try { cashierSelect?.focus(); } catch (_) { }
    markFieldError(cashierSelect);
    return;
  }
  if (!findCashierStrict(cashiersList, cashier)) {
    showToast('Please select a cashier that exists in Manage Cashiers.', { type: 'error' });
    try { cashierSelect?.focus(); } catch (_) { }
    markFieldError(cashierSelect, () => !!findCashierStrict(cashiersList, (cashierSelect?.value || '').trim()));
    return;
  }
  const vendors = await fetchVendors();
  const vendorListForValidation = Array.isArray(vendors) ? vendors : [];
  if (vendorListForValidation.length) {
    const invalidItem = items.find(it => !findVendorStrict(vendorListForValidation, it.vendorName));
    if (invalidItem) {
      showToast(`Vendor "${invalidItem.vendorName || 'Unknown'}" is not in Manage Vendors.`, { type: 'error' });
      try { document.getElementById('itemVendor')?.focus(); } catch (_) { }
      markFieldError(document.getElementById('itemVendor'), el => !!findVendorStrict(vendorListForValidation, (el?.value || '').trim()));
      return;
    }
  }
  try { playCashRegisterSound(); } catch (_) { }

  const numEl = document.getElementById('rcpt-number');
  const dateEl = document.getElementById('rcpt-date');
  const now = new Date();
  // Optional back-dated sale date (keeps current time of day)
  let saleDate = new Date(now.getTime());
  let usedBackdate = false;
  try {
    const useBackdate = !!document.getElementById('backdateToggle')?.checked;
    const dateInput = document.getElementById('backdateDate');
    const ymd = String(dateInput?.value || '').trim();
    if (useBackdate) {
      if (!__isBackdateBeforeToday(ymd)) {
        showToast('Select a date prior to today when back-dating a sale.', { type: 'error' });
        markFieldError(dateInput, el => __isBackdateBeforeToday(String(el?.value || '').trim()));
        return;
      }
      const parts = ymd.split('-').map(n => parseInt(n, 10));
      if (parts.length === 3 && parts.every(n => !isNaN(n) && n > 0)) {
        const [y, m, d] = parts;
        saleDate.setFullYear(y, m - 1, d);
        usedBackdate = true;
      }
    }
  } catch (_) { }
  const number = `MID-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  numEl.textContent = number;
  try {
    if (usedBackdate) {
      dateEl.innerHTML = `${saleDate.toLocaleDateString()} <span style="color:#dc3545;">- back dated</span>`;
    } else {
      dateEl.textContent = saleDate.toLocaleString();
    }
  } catch (_) { dateEl.textContent = saleDate.toLocaleString(); }
  document.getElementById('rcpt-cashier').textContent = cashier || '-';
  document.getElementById('rcpt-payment').textContent = payment || '-';

  let rowsEl = document.getElementById('receiptRows');
  if (!rowsEl) {
    try {
      rowsEl = document.createElement('tbody');
      rowsEl.id = 'receiptRows';
      document.body.appendChild(rowsEl);
    } catch (_) { /* tolerate missing print container in tests */ }
  }
  if (rowsEl) rowsEl.innerHTML = '';
  let subtotal = 0; let giftCardSubtotal = 0; const vendorTotals = {};
  items.forEach(it => {
    const qty = Math.max(1, parseInt(it.quantity || 1, 10));
    const finalPrice = toMoneyNumber(it.price || 0); // unit final
    const originalPrice = deriveOriginalPrice(it);
    const discountAmount = toMoneyNumber(it.discountAmount || (originalPrice - finalPrice));
    const hasDiscount = discountAmount > 0;
    const reason = hasDiscount ? String(it.discountReason || '').trim() : '';
    const discountSuffix = hasDiscount ? buildDiscountSuffix(it.discountType, it.discountValue, discountAmount, reason, escapeHtml) : '';
    const lineTotal = toMoneyNumber(finalPrice * qty);
    subtotal += lineTotal;
    if (isGiftCardSaleItem(it)) giftCardSubtotal += lineTotal;
    const v = findVendorLoose(vendors, it.vendorName); const code = v?.code || '';
    if (code) vendorTotals[code] = (vendorTotals[code] || 0) + lineTotal;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        ${escapeHtml(it.name)}
        ${it.comment ? `<div class="vendor">${escapeHtml(it.comment)}</div>` : ''}
        ${code ? `<div class="vendor">Vendor: ${escapeHtml(code)}</div>` : ''}
        ${qty > 1 ? `<div class="vendor">Qty: ${qty} @ $${money(finalPrice)}</div>` : ''}
        ${hasDiscount ? `<div class="original-line">Original: $${money(originalPrice)}</div>` : ''}
        ${hasDiscount ? `<div class="discount-line">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
      </td>
      <td class="price">$${money(lineTotal)}</td>`;
    if (rowsEl) rowsEl.appendChild(tr);
  });
  const taxableSubtotal = Math.max(0, subtotal - giftCardSubtotal);
  const tax = __taxExempt ? 0 : toMoneyNumber(taxableSubtotal * TAX_RATE);
  const cardFee = getGiftCardFee(
    giftCardSubtotal,
    subtotal,
    tax,
    payment,
    splitEnabled,
    splitType,
    splitAmount
  );
  const total = toMoneyNumber(subtotal + tax + cardFee);
  document.getElementById('receiptSubtotal').textContent = money(subtotal);
  document.getElementById('receiptTax').textContent = money(tax);
  document.getElementById('receiptTotal').textContent = money(total);

  let giftCardBalance = 0;
  if ((payment || '') === 'Gift Card') {
    try {
      const resp = await invoke('giftcards:redeem', {
        number: giftCardNumber,
        amount: giftCardAmount,
        cashier,
        receiptNumber: number
      });
      if (!resp || !resp.ok) {
        showToast('Gift card redemption failed. Please verify the card balance.', { type: 'error' });
        return;
      }
      giftCardBalance = toMoneyNumber(resp.card?.balance ?? 0);
    } catch (err) {
      showToast('Gift card redemption failed: ' + (err?.message || err), { type: 'error' });
      return;
    }
  }

  const cashReceived = cashTendered ? getCashReceivedAmount() : 0;
  const cashDue = cashTendered ? getCashDue(total) : 0;
  const changeDue = cashTendered ? Math.max(0, cashReceived - cashDue) : 0;
  try {
    const giftRow = document.getElementById('receiptGiftCardRow');
    const giftAmountEl = document.getElementById('receiptGiftCardAmount');
    if (giftRow) giftRow.classList.toggle('d-none', (payment || '') !== 'Gift Card');
    if (giftAmountEl) giftAmountEl.textContent = money(giftCardAmount || 0);

    const giftBalRow = document.getElementById('receiptGiftBalanceRow');
    const giftBalEl = document.getElementById('receiptGiftCardBalance');
    if (giftBalRow) giftBalRow.classList.toggle('d-none', (payment || '') !== 'Gift Card');
    if (giftBalEl) giftBalEl.textContent = money(giftCardBalance || 0);

    const splitRow = document.getElementById('receiptSplitTenderRow');
    const splitLabelEl = document.getElementById('receiptSplitTenderLabel');
    const splitAmountEl = document.getElementById('receiptSplitTenderAmount');
    const showSplit = !!splitEnabled && !!splitType && splitType !== 'Cash';
    if (splitRow) splitRow.classList.toggle('d-none', !showSplit);
    if (splitLabelEl && splitType) splitLabelEl.textContent = `${splitType} Tender`;
    if (splitAmountEl) splitAmountEl.textContent = money(splitAmount || 0);

    const cashTenderRow = document.getElementById('receiptCashTenderRow');
    const cashTenderEl = document.getElementById('receiptCashTenderAmount');
    if (cashTenderRow) cashTenderRow.classList.toggle('d-none', !cashTendered);
    if (cashTenderEl) cashTenderEl.textContent = money(cashDue);

    const cashReceivedRow = document.getElementById('receiptCashReceivedRow');
    const cashReceivedEl = document.getElementById('receiptCashReceivedAmount');
    if (cashReceivedRow) cashReceivedRow.classList.toggle('d-none', !cashTendered);
    if (cashReceivedEl) cashReceivedEl.textContent = money(cashReceived);

    const changeRow = document.getElementById('receiptChangeDueRow');
    const changeEl = document.getElementById('receiptChangeDueAmount');
    if (changeRow) changeRow.classList.toggle('d-none', !cashTendered);
    if (changeEl) changeEl.textContent = money(changeDue);
  } catch (_) { }

  // Persist receipt so it appears on the Receipts page
  try {
    const savedItems = items.map(it => {
      const v = findVendorLoose(vendors, it.vendorName);
      const code = v?.code || '';
      const qty = Math.max(1, parseInt(it.quantity || 1, 10));
      const priceFinal = toMoneyNumber(it.price || 0); // unit final
      const originalPrice = deriveOriginalPrice(it);
      const discountAmount = toMoneyNumber(it.discountAmount || (originalPrice - priceFinal));
      const hasDiscount = discountAmount > 0;
      const discountType = hasDiscount ? (it.discountType === 'percent' ? 'percent' : 'amount') : 'none';
      const discountValue = hasDiscount
        ? (discountType === 'percent' ? toMoneyNumber(it.discountValue || 0) : discountAmount)
        : 0;
      const discountReason = hasDiscount ? String(it.discountReason || '').trim() : '';
      return {
        name: it.name,
        price: priceFinal,
        originalPrice,
        quantity: qty,
        vendorCode: code,
        vendor: it.vendorName || '',
        comment: it.comment || '',
        discountType,
        discountValue,
        discountAmount,
        discountReason
      };
    });
    await invoke('receipts:add', {
      datetime: new Date(saleDate.getTime()).toISOString(),
      backdated: !!usedBackdate,
      displayDate: usedBackdate ? (saleDate.toLocaleDateString() + ' - back dated') : saleDate.toLocaleString(),
      number,
      cashier,
      payment,
      items: savedItems,
      taxRate: Number(TAX_RATE),
      subtotal: Number(subtotal),
      tax: Number(tax),
      total: Number(total),
      giftCardNumber: giftCardNumber || '',
      giftCardAmount: giftCardAmount || 0,
      giftCardBalance: giftCardBalance || 0,
      splitTenderEnabled: !!splitEnabled,
      splitTenderType: splitEnabled ? splitType : '',
      splitTenderAmount: splitEnabled ? splitAmount : 0,
      taxExempt: !!__taxExempt,
      taxExemptId: String(__taxExemptInfo?.id || ''),
      taxExemptName: String(__taxExemptInfo?.name || '')
    });
    if (hasGiftCardSaleItems(savedItems)) {
      const details = extractGiftCardSaleDetails(savedItems) || {};
      queueGiftCardActivationReminder({
        receiptNumber: number,
        cardNumber: details.cardNumber || '',
        amount: details.amount || 0
      });
    }
  } catch (e) {
    console.error('Failed to save receipt:', e);
  }

  const style = `
    <style>
      @page { size: Letter portrait; margin: 0.35in; }
      :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
      html,body{height:100%}
      body{background:#fff;margin:0;font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:var(--ink);}
      .invoice{max-width:8.5in;margin:0 auto}
      /* tighter padding to fit more lines per page */
      .sheet{position:relative;background:#fff;padding:20px 24px 120px 24px}
       .bgmark{
          position: fixed;
          top: 50%; left: 50%; transform: translate(-50%, -50%);
          width: 60%; height: auto; opacity: .12; pointer-events: none;
        }
      .header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .brand-wrap{display:flex;gap:12px;align-items:center}
      .brand{font-weight:800;font-size:18px}
      .addr{color:var(--muted);font-size:11px;margin-top:2px}
      .title{font-size:18px;font-weight:800;letter-spacing:.3px;color:var(--emph);text-transform:uppercase}
      .meta{display:grid;grid-template-columns: repeat(2,minmax(160px,1fr)); gap:6px 12px; margin-top:10px}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      thead th{font-size:11px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:8px 6px;text-align:left}
      tbody td{padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}
      th.num, td.num{text-align:right}
      .desc{font-weight:600}
      .vendor{color:var(--muted);font-size:10px}
      .totals{margin-top:10px;display:grid;grid-template-columns: 1fr auto;row-gap:4px}
      .totals .val{min-width:110px;text-align:right}
      .totals .grand{font-weight:800;font-size:15px}
      .thanks{margin-top:10px;color:var(--muted);font-size:11px;text-align:left}
      /* By default, QR sits after content (last page only). If single page, JS adds .qr-fixed to pin it to page bottom */
      .socialQR{position:static; display:flex; flex-direction:row-reverse; align-items:center; gap:8px; text-align:right; margin-top:8px}
      .socialQR img{width:72px; height:auto; border-radius:8px; border:1px solid var(--border)}
      .socialQR .msg{font-weight:700; font-size:11px; line-height:1.2}
      @media print {
        .qr-fixed{ position: fixed; right: 0.5in; bottom: 0.5in; }
        /* Reinforce watermark masking for preview print pipeline */
        .bgmark{
          position: fixed;
          top: 50%; left: 50%; transform: translate(-50%, -50%);
          width: 60%; height: auto; opacity: .12; pointer-events: none;
        }
      }
      ${__greyscalePrint ? '@media print { html{ filter: grayscale(100%); } }' : ''}
    </style>`;

  const vendorsList = await fetchVendors();
  const rowsHtml = items.map((it, idx) => {
    const v = findVendorLoose(vendorsList, it.vendorName); const code = v?.code || '';
    const qty = Math.max(1, parseInt(it.quantity || 1, 10));
    const unit = toMoneyNumber(it.price || 0); // unit final
    const originalPrice = deriveOriginalPrice(it);
    const discountAmount = toMoneyNumber(it.discountAmount || (originalPrice - unit));
    const hasDiscount = discountAmount > 0;
    const reason = hasDiscount ? String(it.discountReason || '').trim() : '';
    const discountSuffix = hasDiscount ? buildDiscountSuffix(it.discountType, it.discountValue, discountAmount, reason, escapeHtml) : '';
    const amount = qty * unit;
    return `
        <tr>
          <td class="num">${idx + 1}</td>
          <td>
            <div class="desc">${escapeHtml(it.name)}</div>
          ${it.comment ? `<div class="vendor">${escapeHtml(it.comment)}</div>` : ''}
          ${code ? `<div class="vendor">Vendor: ${escapeHtml(code)}</div>` : ''}
          ${hasDiscount ? `<div class="original-line">Original: $${money(originalPrice)}</div>` : ''}
          ${hasDiscount ? `<div class="discount-line">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
        </td>
        <td class="num">${qty}</td>
        <td class="num">$${money(unit)}</td>
          <td class="num">$${money(amount)}</td>
        </tr>`;
  }).join('');

  const brandingName = __getBrandingName();
  const brandingAddr = __getBrandingAddressLine();
  const logoSrc = __getBrandingLogoSrc('assets/NEW_MiddletonsBW.PNG');

  const giftBalanceLine = (payment || '') === 'Gift Card'
    ? `<div class="label">Gift Card Balance</div><div class="val">$${money(giftCardBalance || 0)}</div>`
    : '';
  const giftNumberLine = (payment || '') === 'Gift Card'
    ? `<div class="label">Gift Card #</div><div class="val">${escapeHtml(giftCardNumber || '-')}</div>`
    : '';
  const giftTenderLine = (payment || '') === 'Gift Card'
    ? `<div class="label">Gift Card Tender</div><div class="val">$${money(giftCardAmount || 0)}</div>`
    : '';
  const splitTenderLine = splitEnabled && splitType && splitType !== 'Cash'
    ? `<div class="label">${escapeHtml(splitType)} Tender</div><div class="val">$${money(splitAmount || 0)}</div>`
    : '';
  const cashTenderLine = cashTendered
    ? `<div class="label">Cash Tender</div><div class="val">$${money(cashDue)}</div>`
    : '';
  const cashReceivedLine = cashTendered
    ? `<div class="label">Cash Received</div><div class="val">$${money(cashReceived)}</div>`
    : '';
  const changeDueLine = cashTendered
    ? `<div class="label">Change Due</div><div class="val">$${money(changeDue)}</div>`
    : '';
  const cardFeeLine = cardFee > 0
    ? `<div class="label">Card Fee (${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}%)</div><div class="val">$${money(cardFee)}</div>`
    : '';
  const html = `
      <html>
        <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(number)} - Sales Invoice</title>
        <base href="${document.baseURI}">
        ${style}
        <script>
          // decide if content fits on one page; if so, pin QR to page bottom
          function adjustQrPosition(){
            try{
              var qr = document.querySelector('.socialQR');
              var sheet = document.querySelector('.sheet');
              if(!qr || !sheet) return;
              var prev = qr.style.display;
              qr.style.display = 'none';
              var contentH = sheet.scrollHeight;
              qr.style.display = prev;
              var printableH = 96 * 10; // 10in (11in page - 1in margins)
              if(contentH <= printableH){ qr.classList.add('qr-fixed'); } else { qr.classList.remove('qr-fixed'); }
            }catch(e){}
          }
          window.addEventListener('load', function(){ adjustQrPosition(); window.print(); });
          window.addEventListener('afterprint', function(){ window.close(); });
        </script>
      </head>
      <body>
        <div class="invoice">
          <div class="sheet">
            <img class="bgmark" src="assets/NEW_MiddletonsBW.PNG" alt="">
            <div class="header">
              <div class="brand-wrap">
                <img src="assets/NEW_MiddletonsBW.PNG" alt="Logo" style="height:96px; width:auto; border-radius:12px" />
                <div>
                  <div class="brand">Middleton's Antiques &amp; Uniques</div>
                  <div class="addr">1615 S 17th St, Lincoln, NE · 531-500-0135</div>
                </div>
              </div>
              <div class="title">Sales Invoice</div>
            </div>
            <div class="meta">
              <div><div class="label">Invoice #</div><div><strong>${escapeHtml(number)}</strong></div></div>
              <div><div class="label">Date</div><div><strong>${(usedBackdate
      ? `${saleDate.toLocaleDateString()} <span style="color:#dc3545;">- back dated</span>`
      : saleDate.toLocaleString())}</strong></div></div>
              <div><div class="label">Cashier</div><div><strong>${escapeHtml(cashier || '-')}</strong></div></div>
              <div><div class="label">Payment</div><div><strong>${escapeHtml(payment || '-')}</strong></div></div>
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
              <tbody>${rowsHtml || `<tr><td colspan="5" class="label">No items</td></tr>`}</tbody>
            </table>
              <div class="totals">
                <div class="label">Subtotal</div><div class="val">$${money(subtotal)}</div>
                <div class="label">${__taxExempt ? 'Tax (Exempt)' : `Tax (${(TAX_RATE * 100).toFixed(2)}%)`}</div><div class="val">$${money(tax)}</div>
                ${cardFeeLine}
                <div class="label grand">Total</div><div class="val grand">$${money(total)}</div>
                ${giftTenderLine}
                ${splitTenderLine}
                ${cashTenderLine}
                ${cashReceivedLine}
                ${changeDueLine}
                ${giftNumberLine}
                ${giftBalanceLine}
              </div>
            ${__taxExempt ? `<div class="thanks">Exempt: ${escapeHtml(__taxExemptInfo?.name || '')} — ID: ${escapeHtml(__taxExemptInfo?.id || '')}</div>` : ''}

            <div class="thanks">Thank you for shopping small!</div>

            <div class="socialQR">
              <img src="assets/QR.png" alt="Facebook QR code">
              <div class="msg">Visit us on Facebook!! Like, Follow, Share</div>
            </div>
          </div>
        </div>
      </body>
    </html>`;

  // Apply dynamic branding (logo/name/address) into the HTML used for
  // both silent printing and preview windows.
  let brandedHtml = html;
  try {
    const safeName = escapeHtml(brandingName);
    const safeAddr = escapeHtml(brandingAddr);
    if (logoSrc) {
      brandedHtml = brandedHtml.replace(/assets\/NEW_MiddletonsBW\.PNG/g, logoSrc);
    }
    if (safeName) {
      brandedHtml = brandedHtml.replace("Middleton's Antiques &amp; Uniques", safeName);
    }
    if (safeAddr) {
      brandedHtml = brandedHtml.replace('1615 S 17th St, Lincoln, NE A� 531-500-0135', safeAddr);
    }
  } catch (_) { }

  // If back-dated, do not print; just reset POS state
  try {
    if (isBackdated) {
      resetAfterSale();
      return;
    }
  } catch (_) { }

  // If paying cash, show a dismissible Bootstrap alert with change due,
  // then proceed to print after it is dismissed. Otherwise, proceed immediately.
  try {
    if (cashTendered) {
      const cash = getCashReceivedAmount();
      const totalRounded = toMoneyNumber(total);
      const cashDue = (payment || '') === 'Cash'
        ? Math.max(0, totalRounded - (splitEnabled ? splitAmount : 0))
        : (splitEnabled && splitType === 'Cash')
          ? ((payment || '') === 'Gift Card'
            ? Math.max(0, totalRounded - giftCardAmount)
            : Math.max(0, splitAmount))
          : 0;
      const change = Math.max(0, toMoneyNumber(cash - cashDue));
      try { refreshCustomerCartStateFromCashFields(); } catch (_) { }

      const alertEl = document.createElement('div');
      alertEl.className = 'alert alert-dismissible alert-warning shadow-lg';
      alertEl.setAttribute('role', 'alert');
      alertEl.style.position = 'fixed';
      alertEl.style.top = '50%';
      alertEl.style.left = '50%';
      alertEl.style.transform = 'translate(-50%, -50%)';
      alertEl.style.zIndex = '2050';
      alertEl.style.maxWidth = '600px';
      alertEl.style.width = 'calc(100% - 24px)';
      alertEl.style.padding = '20px 24px';
      alertEl.style.textAlign = 'center';
      alertEl.innerHTML = `
        <button type="button" class="btn-close position-absolute top-0 end-0 m-2" data-bs-dismiss="alert" aria-label="Close"></button>
        <div style="font-weight:700; font-size:1.25rem; margin-bottom:8px;">Change Due</div>
        <div style="font-weight:800; font-size:2.25rem; line-height:1; margin-bottom:12px;">$${money(change)}</div>
        <div class="d-grid" style="gap:8px;">
          <button type="button" class="btn btn-primary" data-bs-dismiss="alert">OK</button>
        </div>`;
      document.body.appendChild(alertEl);

      let proceeded = false;
      const removeAlert = () => { try { alertEl.remove(); } catch (_) { } };
      const proceedOnce = () => { if (proceeded) return; proceeded = true; try { removeAlert(); } catch (_) { }; try { completePrintWithHtml(brandedHtml, { shouldPrint: wantsReceipt }); } catch (_) { } };
      try { alertEl.addEventListener('closed.bs.alert', proceedOnce, { once: true }); } catch (_) { }
      const closeBtn = alertEl.querySelector('.btn-close');
      if (closeBtn) closeBtn.addEventListener('click', () => setTimeout(proceedOnce, 0), { once: true });
      const okBtn = alertEl.querySelector('.btn.btn-primary');
      if (okBtn) okBtn.addEventListener('click', () => setTimeout(proceedOnce, 0), { once: true });
      // Also allow Escape key to dismiss
      try {
        const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); proceedOnce(); document.removeEventListener('keydown', onKey, true); } };
        document.addEventListener('keydown', onKey, true);
      } catch (_) { }
      return; // Wait for dismissal before printing
    }
  } catch (_) { }

  completePrintWithHtml(brandedHtml, { shouldPrint: wantsReceipt });
}

function resetAfterSale() {
  try {
    items = [];
    const cashierSelect = document.getElementById('cashierSelect');
    const paymentSelect = document.getElementById('paymentSelect');
    const receiptPref = document.getElementById('receiptWanted');
    document.getElementById('itemName').value = '';
    document.getElementById('itemPrice').value = '';
    document.getElementById('itemVendor').value = '';
    renderTable();
    __lastTotal = 0;
    resetSelectToPlaceholder(cashierSelect);
    resetSelectToPlaceholder(paymentSelect);
    // Reset tax exemption state
    try { const nt = document.getElementById('noTaxToggle'); if (nt) nt.checked = false; } catch (_) { }
    __taxExempt = false; __taxExemptInfo = { id: '', name: '' }; updateTaxRateLabel();
    // Reset cash helpers
    const cashWrap = document.getElementById('cashFields');
    if (cashWrap) cashWrap.classList.add('d-none');
    const cashEl = document.getElementById('cashReceived');
    if (cashEl) cashEl.value = '';
    const changeEl = document.getElementById('changeDue');
    if (changeEl) changeEl.textContent = money(0);
    const splitToggle = document.getElementById('splitTenderToggle');
    if (splitToggle) splitToggle.checked = false;
    const splitType = document.getElementById('splitTenderType');
    if (splitType) resetSelectToPlaceholder(splitType);
    const splitAmountEl = document.getElementById('splitTenderAmount');
    if (splitAmountEl) {
      splitAmountEl.value = '';
      splitAmountEl.dataset.autoValue = '';
    }
    try { toggleSplitTenderFields(); } catch (_) { }
    // Reset back-date controls to default (unchecked and hidden, date set to latest allowed day)
    try {
      const bdToggle = document.getElementById('backdateToggle');
      const bdWrap = document.getElementById('backdateWrap');
      const bdDate = document.getElementById('backdateDate');
      if (bdToggle) bdToggle.checked = false;
      if (bdWrap) bdWrap.classList.add('d-none');
      if (bdDate) {
        const defaultBackdate = __backdateMaxYmd();
        bdDate.value = defaultBackdate;
        bdDate.setAttribute('max', defaultBackdate);
      }
    } catch (_) { }
    // Reset receipt preference to default (checked)
    if (receiptPref) receiptPref.checked = true;
    updatePrintButtonLabel();
    try { showGiftCardActivationReminder(); } catch (_) { }
    // Return focus to the first entry field
    try { const first = document.getElementById('itemName'); first?.focus(); } catch (_) { }
  } catch (_) { }
  // Close the completed sale tab and switch appropriately
  try { __completeSaleAndCloseTab(); } catch (_) { }
}

async function completePrintWithHtml(html, opts = {}) {
  const shouldPrint = opts?.shouldPrint !== false;
  let printed = false;
  if (shouldPrint && __silentPrint) {
    // Show a brief status bar on the POS screen during silent print
    showStatusBar('Printing Sales Receipt');
    try {
      // Remove auto-print/auto-close scripts from the HTML so the hidden
      // printing window does NOT trigger its own preview/dialog.
      let content = String(html || '');
      try {
        content = content
          .replace(/window\.print\(\);?/g, '')
          .replace(/window\.close\(\);?/g, '');
      } catch (_) { }
      // Ask main process to print silently to default/specified printer
      if (api?.hasIpc) {
        printed = await invoke('print:silent', content);
      }
    } catch (e) {
      console.error('Silent print failed, will fall back to preview:', e);
    } finally {
      hideStatusBar();
    }
  }

  // Fallback to preview window if silent print is disabled or failed
  if (shouldPrint && !printed) {
    try {
      const w = window.open('', '', 'width=960,height=900');
      if (w) { w.document.write(html); w.document.close(); }
    } catch (_) { }
  }
  // Reset POS
  resetAfterSale();
}

function preparePaymentSelect() { const sel = document.getElementById('paymentSelect'); if (!sel) return; ensurePlaceholder(sel); sel.value = ''; }
function prepareSplitTenderSelect() { const sel = document.getElementById('splitTenderType'); if (!sel) return; ensurePlaceholder(sel); sel.value = ''; }

// ---------- Cash change helpers ----------
function isCashPaymentSelected() {
  try { const sel = document.getElementById('paymentSelect'); return (sel?.value || '') === 'Cash'; } catch (_) { return false; }
}
function isGiftCardPaymentSelected() {
  try { const sel = document.getElementById('paymentSelect'); return (sel?.value || '') === 'Gift Card'; } catch (_) { return false; }
}
function isSplitCashSelected() {
  try {
    const splitType = document.getElementById('splitTenderType')?.value || '';
    return isSplitTenderEnabled() && splitType === 'Cash';
  } catch (_) { return false; }
}
function isCashTenderSelected() {
  return isCashPaymentSelected() || isSplitCashSelected();
}
function getCashDue(total) {
  const splitAmount = isSplitTenderEnabled()
    ? toMoneyNumber(document.getElementById('splitTenderAmount')?.value || 0)
    : 0;
  if (isCashPaymentSelected()) {
    return Math.max(0, total - splitAmount);
  }
  if (isSplitCashSelected()) {
    if (isGiftCardPaymentSelected()) {
      const giftAmount = toMoneyNumber(document.getElementById('giftCardAmount')?.value || 0);
      return Math.max(0, total - giftAmount);
    }
    return Math.max(0, splitAmount);
  }
  return 0;
}
function getCashReceivedRaw() {
  if (isSplitCashSelected()) {
    return String(document.getElementById('splitTenderAmount')?.value || '');
  }
  return String(document.getElementById('cashReceived')?.value || '');
}
function getCashReceivedAmount() {
  return toMoneyNumber(getCashReceivedRaw());
}
function isSplitTenderEnabled() {
  try { const toggle = document.getElementById('splitTenderToggle'); return !!toggle?.checked; } catch (_) { return false; }
}
function toggleCashFields() {
  const wrap = document.getElementById('cashFields');
  if (!wrap) return;
  const show = isCashPaymentSelected();
  wrap.classList.toggle('d-none', !show);
}
function toggleGiftCardFields() {
  const wrap = document.getElementById('giftCardFields');
  if (!wrap) return;
  const show = isGiftCardPaymentSelected();
  wrap.classList.toggle('d-none', !show);
  if (show) {
    try { updateGiftCardAmountDefault(); } catch (_) { }
    try { refreshGiftCardBalanceHint(); } catch (_) { }
  } else {
    __giftCardBalance = null;
  }
}
function updateSplitTenderPlacement() {
  const wrap = document.getElementById('splitTenderFields');
  if (!wrap) return;
  const anchor = document.getElementById('splitTenderAnchor');
  const giftWrap = document.getElementById('giftCardFields');
  const target = isGiftCardPaymentSelected() ? giftWrap : anchor;
  if (target && wrap.parentNode !== target) {
    target.appendChild(wrap);
  }
}
function toggleSplitTenderFields() {
  const wrap = document.getElementById('splitTenderFields');
  if (!wrap) return;
  updateSplitTenderPlacement();
  const show = isSplitTenderEnabled();
  wrap.classList.toggle('d-none', !show);
  if (show) {
    try { updateSplitTenderAmountDefault(); } catch (_) { }
  }
}
function updateGiftCardAmountDefault() {
  const amountEl = document.getElementById('giftCardAmount');
  if (!amountEl || !isGiftCardPaymentSelected()) return;
  const splitType = document.getElementById('splitTenderType')?.value || '';
  const forceFullBalance = isSplitTenderEnabled() && splitType === 'Cash';
  if (forceFullBalance && Number.isFinite(__giftCardBalance)) {
    const totalDue = toMoneyNumber(__lastTotal || 0);
    const fullAmount = Math.min(__giftCardBalance, totalDue);
    amountEl.value = money(fullAmount);
    amountEl.dataset.autoValue = 'true';
    try { updateSplitTenderAmountDefault(); } catch (_) { }
    return;
  }
  const current = String(amountEl.value || '').trim();
  const isAuto = String(amountEl.dataset.autoValue || '') === 'true';
  if (current && !isAuto) return;
  const totalDue = toMoneyNumber(__lastTotal || 0);
  const balance = Number.isFinite(__giftCardBalance) ? __giftCardBalance : null;
  const nextAmount = balance === null ? totalDue : Math.min(balance, totalDue);
  amountEl.value = money(nextAmount);
  amountEl.dataset.autoValue = 'true';
  try { updateSplitTenderAmountDefault(); } catch (_) { }
}
function updateCashChange() {
  const cashInput = document.getElementById('cashReceived');
  const changeEl = document.getElementById('changeDue');
  if (!cashInput || !changeEl) return;
  const cash = getCashReceivedAmount();
  const total = toMoneyNumber(__lastTotal || 0);
  const cashDue = getCashDue(total);
  const change = isCashTenderSelected()
    ? Math.max(0, toMoneyNumber(cash - cashDue))
    : 0;
  changeEl.textContent = money(change);
  try { refreshCustomerCartStateFromCashFields(); } catch (_) { }
}
function updateSplitTenderAmountDefault() {
  if (!isSplitTenderEnabled() || !isGiftCardPaymentSelected()) return;
  const amountEl = document.getElementById('splitTenderAmount');
  if (!amountEl) return;
  const current = String(amountEl.value || '').trim();
  const isAuto = String(amountEl.dataset.autoValue || '') === 'true';
  if (current && !isAuto) return;
  const totalDue = toMoneyNumber(__lastTotal || 0);
  const giftAmount = toMoneyNumber(document.getElementById('giftCardAmount')?.value || 0);
  const remainder = Math.max(0, totalDue - giftAmount);
  amountEl.value = money(remainder);
  amountEl.dataset.autoValue = 'true';
}
async function refreshGiftCardBalanceHint() {
  const hintEl = document.getElementById('giftCardBalanceHint');
  const numberEl = document.getElementById('giftCardNumber');
  if (!hintEl || !numberEl) return;
  const number = String(numberEl.value || '').trim();
  if (!number) {
    hintEl.textContent = '';
    __giftCardBalance = null;
    return;
  }
  try {
    const resp = await invoke('giftcards:lookup', { number });
    if (!resp || !resp.card) {
      hintEl.textContent = 'Gift card not found.';
      __giftCardBalance = null;
      return;
    }
    const status = String(resp.card.status || '').toUpperCase();
    const balanceValue = toMoneyNumber(resp.card.balance || 0);
    __giftCardBalance = balanceValue;
    try {
      const amountEl = document.getElementById('giftCardAmount');
      if (amountEl) amountEl.dataset.autoValue = 'true';
    } catch (_) { }
    hintEl.textContent = `Status: ${status} · Balance: $${money(balanceValue)}`;
    updateGiftCardAmountDefault();
  } catch (_) {
    hintEl.textContent = '';
    __giftCardBalance = null;
  }
}

function updatePrintButtonLabel() {
  const btn = document.getElementById('printSaveBtn');
  const receipt = document.getElementById('receiptWanted');
  if (!btn) return;
  const wants = receipt ? !!receipt.checked : true;
  btn.textContent = wants ? 'Print & Save' : 'Save';
}

// ---------- Quantity picker ----------
function hideQtyPicker() {
  try {
    const pop = document.getElementById('qtyPickerPopover');
    const toggle = document.getElementById('qtyPickerToggle');
    const input = document.getElementById('itemQty');
    if (pop) pop.classList.add('d-none');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    if (input) input.setAttribute('aria-expanded', 'false');
    __qtyPickerOpen = false;
  } catch (_) { }
}
function showQtyPicker() {
  try {
    const pop = document.getElementById('qtyPickerPopover');
    const toggle = document.getElementById('qtyPickerToggle');
    const input = document.getElementById('itemQty');
    if (!pop || !toggle || !input) return;
    pop.classList.remove('d-none');
    toggle.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-expanded', 'true');
    __qtyPickerOpen = true;
  } catch (_) { }
}
function toggleQtyPicker() { if (__qtyPickerOpen) hideQtyPicker(); else showQtyPicker(); }
function setupQtyPicker() {
  try {
    const pop = document.getElementById('qtyPickerPopover');
    const toggle = document.getElementById('qtyPickerToggle');
    const input = document.getElementById('itemQty');
    const wrap = document.getElementById('qtyPickerWrap');
    if (!pop || !toggle || !input || !wrap) return;
    if (pop.dataset._wired === '1') return;
    pop.dataset._wired = '1';

    const apply = (valRaw) => {
      const n = Math.max(1, parseInt(valRaw, 10) || 1);
      input.value = String(n);
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) { }
      try { input.focus(); input.select?.(); } catch (_) { }
      hideQtyPicker();
      try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
    };

    pop.querySelectorAll('button[data-value]')?.forEach(btn => {
      btn.addEventListener('click', () => apply(btn.getAttribute('data-value')));
    });
    try { document.getElementById('qtyPickerClose')?.addEventListener('click', hideQtyPicker); } catch (_) { }

    toggle.addEventListener('click', (e) => { try { e.preventDefault(); } catch (_) { } toggleQtyPicker(); });
    input.addEventListener('keydown', (e) => {
      try {
        if (e.key === 'Escape') { hideQtyPicker(); return; }
        if (e.key === 'ArrowDown' && !__qtyPickerOpen) { showQtyPicker(); }
      } catch (_) { }
    });
    document.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (wrap.contains(target)) return;
      hideQtyPicker();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideQtyPicker(); }, true);
  } catch (_) { }
}

async function populatePosReturnCashiers() {
  try {
    const sel = document.getElementById('posReturnCashierSelect');
    if (!sel) return;
    const previous = sel.value || '';
    sel.innerHTML = '';
    ensurePlaceholder(sel);
    let list = await fetchCashiers();
    if (!Array.isArray(list)) list = [];
    if (list.length === 0) list = [{ name: 'Manager' }];
    list.forEach((c, idx) => {
      const opt = document.createElement('option');
      opt.value = String(c?.name || (`Cashier ${idx + 1}`)).trim();
      opt.textContent = opt.value;
      try { opt.dataset.cashier = JSON.stringify(c); } catch (_) { }
      opt.dataset.index = String(idx);
      sel.appendChild(opt);
    });
    const preferred = (document.getElementById('cashierSelect')?.value || '').trim();
    if (preferred && [...sel.options].some(o => o.value === preferred)) {
      sel.value = preferred;
    } else if (previous) {
      sel.value = previous;
    }
  } catch (_) { }
}

const ITEM_NAME_SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by',
  'for', 'from', 'in', 'into', 'nor', 'of', 'on',
  'or', 'per', 'to', 'via', 'with'
]);

function normalizeItemName(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\s+/)
    .map((word, index) => normalizeItemWord(word, index === 0))
    .join(' ');
}

function normalizeItemWord(token, isFirstWord) {
  if (!token) return token;
  return token
    .split(/([-\/])/)
    .map((segment, segIndex) => {
      if (!segment || segment === '-' || segment === '/') return segment;
      const lower = segment.toLowerCase();
      const isException = ITEM_NAME_SMALL_WORDS.has(lower);
      const shouldCap = (isFirstWord && segIndex === 0) ? true : !isException;
      return shouldCap
        ? lower.charAt(0).toUpperCase() + lower.slice(1)
        : lower;
    })
    .join('');
}

function setupPosReturnModal() {
  try {
    if (__returnModal) return;
    const el = document.getElementById('posReturnModal');
    if (!el || !window.bootstrap) return;
    __returnModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: false });
    const confirmBtn = document.getElementById('posReturnConfirmBtn');
    const cancelBtn = document.getElementById('posReturnCancelBtn');
    const closeX = document.getElementById('posReturnCloseX');
    const receiptInput = document.getElementById('posReturnReceiptId');
    const reasonInput = document.getElementById('posReturnReasonInput');
    const cashierSelect = document.getElementById('posReturnCashierSelect');
    let busy = false;

    const reset = () => {
      try { if (receiptInput) receiptInput.value = ''; } catch (_) { }
      try { if (reasonInput) reasonInput.value = ''; } catch (_) { }
    };

    const dismiss = () => {
      busy = false;
      try { if (confirmBtn) confirmBtn.disabled = false; } catch (_) { }
      reset();
      try { __returnModal.hide(); } catch (_) { }
    };

    const handleError = (message) => {
      try { showToast(message, { type: 'error' }); } catch (_) { }
    };

    const handleConfirm = async () => {
      if (busy) return;
      const id = (receiptInput?.value || '').trim();
      if (!id) {
        handleError('Enter a receipt number or ID.');
        try { receiptInput?.focus(); } catch (_) { }
        return;
      }
      const reason = (reasonInput?.value || '').trim();
      if (!reason) {
        handleError('Please describe why the receipt is being returned.');
        try { reasonInput?.focus(); } catch (_) { }
        return;
      }
      const opt = cashierSelect?.options[cashierSelect.selectedIndex];
      let cashierObj = null;
      try { cashierObj = opt?.dataset?.cashier ? JSON.parse(opt.dataset.cashier) : null; } catch (_) { }
      const user = (cashierObj?.name || cashierSelect?.value || 'Manager').trim();
      busy = true;
      try { if (confirmBtn) confirmBtn.disabled = true; } catch (_) { }
      try {
        const resp = await invoke('receipts:return', { id, reason, user, userObj: cashierObj });
        if (!resp) {
          handleError('Unable to return the receipt. Ensure the ID is correct and the receipt is not already voided/returned.');
          return;
        }
        try { showToast('Receipt marked as returned.', { type: 'success' }); } catch (_) { }
        dismiss();
      } catch (err) {
        handleError('Error returning receipt: ' + (err?.message || err));
      } finally {
        busy = false;
        try { if (confirmBtn) confirmBtn.disabled = false; } catch (_) { }
      }
    };

    confirmBtn?.addEventListener('click', handleConfirm);
    cancelBtn?.addEventListener('click', dismiss);
    closeX?.addEventListener('click', dismiss);
    el.addEventListener('shown.bs.modal', async () => {
      await populatePosReturnCashiers();
      reset();
      try { receiptInput?.focus(); } catch (_) { }
    });
    el.addEventListener('hidden.bs.modal', () => {
      busy = false;
      try { if (confirmBtn) confirmBtn.disabled = false; } catch (_) { }
      reset();
    });
  } catch (_) { }
}

function openReturnModal() {
  if (!__returnModal) setupPosReturnModal();
  if (!__returnModal) {
    try { showToast('Return modal unavailable.', { type: 'error' }); } catch (_) { }
    return;
  }
  try { __returnModal.show(); } catch (_) { }
}

// ---------- Init ----------
window.addEventListener('load', async () => {
  // Establish a per-app-run session id so we only restore tabs within a single run
  try {
    __sessionId = sessionStorage.getItem(__SESSION_KEY) || __readWindowSessionId();
    if (!__sessionId) {
      __sessionId = `S-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      sessionStorage.setItem(__SESSION_KEY, __sessionId);
    }
    __writeWindowSessionId(__sessionId);
  } catch (_) { __sessionId = `S-${Date.now()}-${Math.floor(Math.random() * 100000)}`; }
  try {
    const s = await invoke('settings:load');
    const tr = Number(s?.taxRate);
    if (!isNaN(tr) && tr >= 0 && tr <= 1) TAX_RATE = tr;
    const gcRate = Number(s?.giftCardSurchargeRate);
    if (!isNaN(gcRate) && gcRate >= 0 && gcRate <= 1) GIFT_CARD_SURCHARGE_RATE = gcRate;
    __silentPrint = !!s?.silentPrint;
    __greyscalePrint = !!s?.greyscalePrint;
    try {
      const list = Array.isArray(s?.discountReasons) ? s.discountReasons : [];
      const cleaned = list.map(r => String(r || '').trim()).filter(Boolean);
      if (cleaned.length) __discountReasons = cleaned;
    } catch (_) { }
    try {
      __vendorPromotions = normalizeVendorPromotions(s?.vendorPromotions || []);
    } catch (_) { __vendorPromotions = []; }
    try { __setTaxExemptOrgs(s?.taxExemptOrgs || []); } catch (_) { }
    __branding = {
      bizName: String(s?.bizName || __branding.bizName),
      bizAddress: String(s?.bizAddress || __branding.bizAddress),
      bizPhone: String(s?.bizPhone || __branding.bizPhone),
      logoPath: String(s?.logoPath || '')
    };
  } catch (_) { }
  await loadCashiersIntoSelect();
  preparePaymentSelect();
  prepareSplitTenderSelect();
  setupEntryDiscountControls();
  try { setDiscountReasonOptions(document.getElementById('edit_discountReason'), __discountReasons); } catch (_) { }
  await loadVendorsIntoDatalist();
  try { applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
  try {
    const priceEl = document.getElementById('itemPrice');
    if (priceEl) {
      priceEl.addEventListener('blur', () => formatPriceInput(priceEl));
      priceEl.addEventListener('change', () => formatPriceInput(priceEl));
    }
  } catch (_) { }
  setupQtyPicker();
  try { setupPosReturnModal(); } catch (_) { }
  renderTable();
  updateTaxRateLabel();
  updateGiftCardFeeLabel();
  try { __applyBrandingToDocument(); } catch (_) { }
  installNavigationGuards();
  // Clean up any stray overlays after startup
  try { cleanupStrayBackdrops(); } catch (_) { }
  // Ensure input focus behavior is resilient
  try { forceFocusOnInputs(); } catch (_) { }
  // Enable Bootstrap tooltips where present
  try {
    if (window.bootstrap && window.bootstrap.Tooltip) {
      Array.from(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
        .forEach(el => { try { new bootstrap.Tooltip(el); } catch (_) { } });
    }
  } catch (_) { }

  const addrEl = document.getElementById('rcpt-address');

  // Safety: retry population shortly after load if still empty
  try {
    setTimeout(async () => {
      try {
        const cs = document.getElementById('cashierSelect');
        if (!selectHasRealOptions(cs)) await loadCashiersIntoSelect();
      } catch (_) { }
      try { await loadVendorsIntoDatalist(); } catch (_) { }
    }, 250);
  } catch (_) { }
  if (addrEl) addrEl.textContent = '1615 S 17th St, Lincoln, NE 68502 · 531-500-0135';

  // New Sale button adds a new tab
  try {
    const btn = document.getElementById('newSaleBtn');
    if (btn) btn.addEventListener('click', () => { try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { } __createNewCartTab(); });
  } catch (_) { }
  try {
    const giftCardConfirmBtn = document.getElementById('giftCardSaleConfirmBtn');
    if (giftCardConfirmBtn) giftCardConfirmBtn.addEventListener('click', confirmGiftCardSaleItem);
  } catch (_) { }
  try {
    const giftCardReminderActivateBtn = document.getElementById('giftCardReminderActivateBtn');
    if (giftCardReminderActivateBtn) giftCardReminderActivateBtn.addEventListener('click', () => { handleGiftCardReminderActivate(); });
  } catch (_) { }
  try {
    const activateCardBtn = document.getElementById('activateCardBtn');
    if (activateCardBtn) activateCardBtn.addEventListener('click', activateGiftCardFromPos);
  } catch (_) { }
  // Cancel Sale: clears and closes current tab
  try {
    const cancelBtn = document.getElementById('cancelSaleBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      __cancelActiveCart();
    });
  } catch (_) { }
  // Try to restore previous tabs; otherwise, start with one tab
  try {
    if (__restoreTabs()) {
      // Renumber tabs as Sale 1..N on each app open
      __renumberTabs();
      __renderTabs();
      __persistTabs();
      try { __updateCancelSaleButtonEnabled(); } catch (_) { }
    } else {
      __createNewCartTab();
    }
  } catch (_) { __createNewCartTab(); }

  try {
    const flag = sessionStorage.getItem('posDirtyNavToast');
    if (flag) {
      sessionStorage.removeItem('posDirtyNavToast');
      if (__hasDirtyCarts()) {
        showToast('Open sales were kept. Complete or cancel to clear them.', { type: 'info', duration: 3500 });
      }
    }
  } catch (_) { }

  // Persist tabs on leave/hidden (but not when quitting the app)
  try {
    window.addEventListener('beforeunload', () => {
      try { if (!__isQuitting) __persistTabs(); } catch (_) { }
    });
    window.addEventListener('pagehide', () => { try { if (!__isQuitting) __persistTabs(); } catch (_) { } });
    document.addEventListener('visibilitychange', () => { try { if (document.hidden && !__isQuitting) __persistTabs(); } catch (_) { } });
    window.addEventListener('unload', () => {
      try { closeCustomerCartWindow(); } catch (_) { }
      try { requestLogoutOnClose(); } catch (_) { }
    });
  } catch (_) { }

  // Mark quitting so beforeunload can prompt appropriately
  try {
    api?.on?.('app:prepareQuit', () => {
      try { __isQuitting = true; } catch (_) { }
      try { closeCustomerCartWindow(); } catch (_) { }
      try { invoke('auth:logout'); } catch (_) { }
    });
  } catch (_) { }

  const itemVendorEl = document.getElementById('itemVendor');
  if (itemVendorEl) {
    function normalizeVendorLocal(el) {
      try {
        const s = norm(el.value || '');
        if (!s) return;
        const list = Array.isArray(__vendorsCache) && __vendorsCache.length ? __vendorsCache : [];
        const v = findVendorStrict(list, s);
        if (v && v.code) el.value = v.code;
      } catch (_) { }
    }
    itemVendorEl.addEventListener('input', () => updateVendorDatalistForValue(itemVendorEl.value || ''));
    itemVendorEl.addEventListener('focus', () => updateVendorDatalistForValue(itemVendorEl.value || ''));
    itemVendorEl.addEventListener('change', () => { normalizeVendorInput(itemVendorEl); applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); });
    itemVendorEl.addEventListener('blur', () => { normalizeVendorInput(itemVendorEl); applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); });
    itemVendorEl.addEventListener('keydown', (e) => {
      const isTab = e.key === 'Tab';
      const isEnter = e.key === 'Enter';
      if (!isTab && !isEnter) return;
      const hasInput = String(itemVendorEl.value || '').trim() !== '';
      if (isTab && !hasInput) return;
      // If a vendor option is highlighted in the datalist, commit it before leaving the field
      try { applyFirstVendorOption(itemVendorEl); } catch (_) { }
      // Synchronously normalize to known vendor code
      normalizeVendorLocal(itemVendorEl);
      // Also kick off async normalization as a fallback (no need to wait)
      try { normalizeVendorInput(itemVendorEl); } catch (_) { }
      try { applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
    });
  }

  // Edit modal vendor field: mirror the same Tab/Enter completion behavior
  const editVendorEl = document.getElementById('edit_vendor');
  if (editVendorEl) {
    function normalizeEditVendorLocal(el) {
      try {

        // Refresh sources when opening the dropdown/field
        try { document.getElementById('cashierSelect')?.addEventListener('focus', () => { loadCashiersIntoSelect(); }); } catch (_) { }
        try { document.getElementById('itemVendor')?.addEventListener('focus', () => { loadVendorsIntoDatalist(); }); } catch (_) { }
        const s = norm(el.value || '');
        if (!s) return;
        const list = Array.isArray(__vendorsCache) && __vendorsCache.length ? __vendorsCache : [];
        const v = findVendorStrict(list, s);
        if (v && v.code) el.value = v.code;
      } catch (_) { }
    }
    editVendorEl.addEventListener('change', () => { normalizeVendorInput(editVendorEl); applyVendorPromoToEdit({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); });
    editVendorEl.addEventListener('blur', () => { normalizeVendorInput(editVendorEl); applyVendorPromoToEdit({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); });
    editVendorEl.addEventListener('keydown', (e) => {
      const isTab = e.key === 'Tab';
      const isEnter = e.key === 'Enter';
      if (!isTab && !isEnter) return;
      const hasInput = String(editVendorEl.value || '').trim() !== '';
      if (isTab && !hasInput) return;
      try { applyFirstVendorOption(editVendorEl); } catch (_) { }
      normalizeEditVendorLocal(editVendorEl);
      try { applyVendorPromoToEdit({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
    });
  }

  const saveBtn = document.getElementById('edit_save_btn');
  if (saveBtn) saveBtn.addEventListener('click', saveEditFromModal);

  // Preload cash register sound for instant playback
  try {
    __cashAudio = new Audio('assets/cash-register-kaching-sound-effect-125042.mp3');
    __cashAudio.preload = 'auto';
    __cashAudio.volume = 0.8;
  } catch (_) { }

  // Cash helpers
  try {
    const cashierSelect = document.getElementById('cashierSelect');
    if (cashierSelect) {
      cashierSelect.addEventListener('change', () => {
        try { if (__activeCartId) __carts.set(__activeCartId, __snapshotFromUI()); } catch (_) { }
        try { renderTable(); } catch (_) { }
      });
    }
    const paySel = document.getElementById('paymentSelect');
    if (paySel) paySel.addEventListener('change', () => {
      toggleCashFields();
      toggleGiftCardFields();
      toggleSplitTenderFields();
      updateCashChange();
      try { renderTable(); } catch (_) { }
    });
    const cashEl = document.getElementById('cashReceived');
    if (cashEl) cashEl.addEventListener('input', updateCashChange);
    const splitToggle = document.getElementById('splitTenderToggle');
    if (splitToggle) {
      splitToggle.addEventListener('change', () => {
        toggleSplitTenderFields();
        toggleCashFields();
        updateCashChange();
        try { renderTable(); } catch (_) { }
      });
    }
    const splitTypeEl = document.getElementById('splitTenderType');
    if (splitTypeEl) {
      splitTypeEl.addEventListener('change', () => {
        toggleCashFields();
        updateCashChange();
        try { renderTable(); } catch (_) { }
      });
    }
    const splitAmountEl = document.getElementById('splitTenderAmount');
    if (splitAmountEl) {
      const markSplitManual = () => { splitAmountEl.dataset.autoValue = 'false'; };
      splitAmountEl.addEventListener('input', () => { markSplitManual(); updateCashChange(); });
      splitAmountEl.addEventListener('blur', () => {
        markSplitManual();
        formatPriceInput(splitAmountEl);
        updateCashChange();
        try { renderTable(); } catch (_) { }
      });
      splitAmountEl.addEventListener('change', () => {
        markSplitManual();
        formatPriceInput(splitAmountEl);
        updateCashChange();
        try { renderTable(); } catch (_) { }
      });
    }
    const giftNumberEl = document.getElementById('giftCardNumber');
    if (giftNumberEl) {
      giftNumberEl.addEventListener('change', refreshGiftCardBalanceHint);
      giftNumberEl.addEventListener('blur', refreshGiftCardBalanceHint);
    }
    const giftAmountEl = document.getElementById('giftCardAmount');
    if (giftAmountEl) {
      const markGiftManual = () => { giftAmountEl.dataset.autoValue = 'false'; };
      giftAmountEl.addEventListener('blur', () => {
        markGiftManual();
        formatPriceInput(giftAmountEl);
        updateSplitTenderAmountDefault();
        try { renderTable(); } catch (_) { }
      });
      giftAmountEl.addEventListener('change', () => {
        markGiftManual();
        formatPriceInput(giftAmountEl);
        updateSplitTenderAmountDefault();
        try { renderTable(); } catch (_) { }
      });
    }
    toggleCashFields();
    toggleGiftCardFields();
    toggleSplitTenderFields();
    updateCashChange();
  } catch (_) { }
  // Receipt preference toggle -> update button label
  try {
    const receipt = document.getElementById('receiptWanted');
    if (receipt) receipt.addEventListener('change', updatePrintButtonLabel);
    updatePrintButtonLabel();
  } catch (_) { }
  try {
    const returnBtn = document.getElementById('posReturnBtn');
    if (returnBtn) returnBtn.addEventListener('click', openReturnModal);
  } catch (_) { }
  // Back-date helpers
  try {
    const bdToggle = document.getElementById('backdateToggle');
    const bdWrap = document.getElementById('backdateWrap');
    const bdDate = document.getElementById('backdateDate');
    const maxBackdate = __backdateMaxYmd();
    if (bdDate) {
      bdDate.setAttribute('max', maxBackdate);
      bdDate.value = __sanitizeBackdateValue(bdDate.value || maxBackdate);
      bdDate.addEventListener('change', () => {
        const sanitized = __sanitizeBackdateValue(bdDate.value);
        if (bdDate.value !== sanitized) {
          bdDate.value = sanitized;
          showToast('Back-dated sales must use a date before today.', { type: 'error' });
        }
      });
    }
    const sync = () => {
      try { if (bdWrap) bdWrap.classList.toggle('d-none', !bdToggle.checked); } catch (_) { }
      try { applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true }); } catch (_) { }
    };
    if (bdToggle) bdToggle.addEventListener('change', sync);
    sync();
  } catch (_) { }

  // Tax Exempt (No Tax) helpers
  try {
    const modalEl = document.getElementById('noTaxModal');
    if (modalEl && window.bootstrap) __noTaxModal = new bootstrap.Modal(modalEl, { backdrop: 'static', keyboard: false });
    const toggle = document.getElementById('noTaxToggle');
    const idEl = document.getElementById('noTaxId');
    const nameEl = document.getElementById('noTaxName');
    const applyBtn = document.getElementById('noTaxApplyBtn');
    const cancelBtn = document.getElementById('noTaxCancelBtn');

    const openModal = () => {
      try {
        if (!__noTaxModal) return;
        // Prefill if available
        if (nameEl) nameEl.value = String(__taxExemptInfo?.name || '');
        if (idEl) idEl.value = String(__taxExemptInfo?.id || '');
        try { __renderTaxExemptOrgOptions(); } catch (_) { }
        try { __syncTaxExemptIdFromName(nameEl, idEl); } catch (_) { }
        __noTaxModal.show();
        setTimeout(() => { try { (nameEl || idEl)?.focus(); } catch (_) { } }, 100);
      } catch (_) { }
    };

    const validateAndApply = () => {
      const nameVal = String(nameEl?.value || '').trim();
      const idVal = String(idEl?.value || '').trim();
      const okId = /^[a-z0-9]+$/i.test(idVal);
      clearFieldError(nameEl); clearFieldError(idEl);
      if (!nameVal) {
        try { showToast('Please enter a name or organization.', { type: 'error' }); } catch (_) { }
        try { nameEl?.focus(); } catch (_) { }
        markFieldError(nameEl);
        return;
      }
      if (!okId) {
        try { showToast('Tax ID must be alphanumeric (no spaces).', { type: 'error' }); } catch (_) { }
        try { idEl?.focus(); } catch (_) { }
        markFieldError(idEl, el => /^[a-z0-9]+$/i.test(String(el?.value || '').trim()));
        return;
      }
      __taxExempt = true;
      __taxExemptInfo = { id: idVal, name: nameVal };
      try { updateTaxRateLabel(); renderTable(); } catch (_) { }
      try { __noTaxModal?.hide(); } catch (_) { }
    };

    if (toggle) {
      toggle.addEventListener('change', () => {
        try {
          if (toggle.checked) {
            openModal();
          } else {
            // Turn off exemption
            __taxExempt = false;
            __taxExemptInfo = { id: '', name: '' };
            updateTaxRateLabel();
            renderTable();
          }
        } catch (_) { }
      });
    }
    if (applyBtn) applyBtn.addEventListener('click', validateAndApply);
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      try {
        if (!__taxExempt && toggle) toggle.checked = false;
      } catch (_) { }
    });
    if (nameEl) {
      nameEl.addEventListener('change', () => __syncTaxExemptIdFromName(nameEl, idEl));
      nameEl.addEventListener('blur', () => __syncTaxExemptIdFromName(nameEl, idEl));
    }
    // If modal is closed by backdrop/close button, revert toggle when not applied
    if (modalEl) modalEl.addEventListener('hidden.bs.modal', () => {
      try { if (!__taxExempt && toggle) toggle.checked = false; } catch (_) { }
    });
  } catch (_) { }
  // Periodically ensure the UI isn't blocked by stale overlays
  try { setInterval(() => { cleanupStrayBackdrops(); nukeBlockingOverlays(); }, 1500); } catch (_) { }

  // POS-specific: gentle refocus helper — only when nothing else has focus
  try {
    document.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button') : null;
      if (!btn) return;
      // Skip if button opens toggles/modals or is inside one
      if (btn.closest('.modal')) return;
      if (btn.getAttribute('data-bs-toggle')) return;
      // If this click is intended to open the Edit Item modal, don't refocus
      try { const oc = String(btn.getAttribute('onclick') || ''); if (oc.includes('openEditModal(')) return; } catch (_) { }
      const nameEl = document.getElementById('itemName');
      if (!nameEl) return; // not on POS page
      // Do not steal focus if a modal is opening/open or another input already has focus
      setTimeout(() => {
        try {
          const hasOpenModal = !!document.querySelector('.modal.show');
          if (hasOpenModal) return;
          const ae = document.activeElement;
          if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
          nameEl.focus();
        } catch (_) { }
      }, 120);
    });
  } catch (_) { }
});

// live tax updates
try {
  api?.on?.('settings:changed', (_evt, payload) => {
    const tr = Number(payload?.taxRate);
    if (!isNaN(tr) && tr >= 0 && tr <= 1) { TAX_RATE = tr; renderTable(); updateTaxRateLabel(); }
    const gcRate = Number(payload?.giftCardSurchargeRate);
    if (!isNaN(gcRate) && gcRate >= 0 && gcRate <= 1) {
      GIFT_CARD_SURCHARGE_RATE = gcRate;
      renderTable();
      updateGiftCardFeeLabel();
    }
    if (typeof payload?.silentPrint === 'boolean') { __silentPrint = !!payload.silentPrint; }
    if (typeof payload?.greyscalePrint === 'boolean') { __greyscalePrint = !!payload.greyscalePrint; }
    try {
      if (payload) {
        __branding = {
          bizName: String(payload.bizName || __branding.bizName),
          bizAddress: String(payload.bizAddress || __branding.bizAddress),
          bizPhone: String(payload.bizPhone || __branding.bizPhone),
          logoPath: String(payload.logoPath || __branding.logoPath || '')
        };
        __applyBrandingToDocument();
      }
    } catch (_) { }
    try {
      if (Array.isArray(payload?.discountReasons)) {
        const cleaned = payload.discountReasons.map(r => String(r || '').trim()).filter(Boolean);
        if (cleaned.length) __discountReasons = cleaned;
        setDiscountReasonOptions(document.getElementById('discountReason'), __discountReasons);
        setDiscountReasonOptions(document.getElementById('edit_discountReason'), __discountReasons);
        syncDiscountReasonDisabledState(document.getElementById('discountType'), document.getElementById('discountReason'));
        syncDiscountReasonDisabledState(document.getElementById('edit_discountType'), document.getElementById('edit_discountReason'));
      }
    } catch (_) { }
    try {
      if (Array.isArray(payload?.vendorPromotions)) {
        __vendorPromotions = normalizeVendorPromotions(payload.vendorPromotions);
        applyVendorPromoToEntry({ onlyWhenEmptyOrAuto: true, clearWhenMissingVendor: true });
      }
    } catch (_) { }
    try {
      if (Array.isArray(payload?.taxExemptOrgs)) {
        __setTaxExemptOrgs(payload.taxExemptOrgs);
      }
    } catch (_) { }
    // After settings changes, clear any leftover overlays that might capture input
    try { setTimeout(() => cleanupStrayBackdrops(), 0); } catch (_) { }
  });
} catch (_) { }

// Expose
window.addItem = addItem;
window.printReceipt = printReceipt;
window.openEditModal = openEditModal;

// Test-friendly exports (no impact in Electron runtime)
try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      // utils
      money,
      escapeHtml,
      toMoneyNumber,
      formatPercent,
      formatDiscountLabel,
      buildDiscountSuffix,
      clamp,
      // pricing & discounts
      computeDiscount,
      finalPriceFrom,
      deriveOriginalPrice,
      itemHasDiscount,
      // vendors
      findVendorLoose,
      // cart flows
      addItem,
      clearItemEntry,
      addGiftCardSaleItem,
      confirmGiftCardSaleItem,
      printReceipt,
      removeItem,
      // totals & UI
      renderTable,
      updateTaxRateLabel,
      updateCashChange,
      queueGiftCardActivationReminder,
      showGiftCardActivationReminder,
      extractGiftCardSaleDetails,
      // tiny test hooks
      __test: {
        setTaxRate: (v) => { try { TAX_RATE = Number(v); updateTaxRateLabel(); } catch (_) { } },
        setTaxExempt: (b) => { try { __taxExempt = !!b; updateTaxRateLabel(); } catch (_) { } },
        resetCart: () => { try { items = []; } catch (_) { } },
        getItems: () => { try { return items.slice(); } catch (_) { return []; } },
        setVendorPromotions: (list) => { try { __vendorPromotions = normalizeVendorPromotions(list); } catch (_) { __vendorPromotions = []; } },
        setVendorsCache: (list) => { try { __vendorsCache = Array.isArray(list) ? list : []; } catch (_) { __vendorsCache = []; } },
        applyVendorPromoToFields,
        findActiveVendorPromo,
        promoDateRangeIncludes,
      }
    };
  }
} catch (_) { }

// giftcards.js
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
    __suppressUnloadTimer = setTimeout(() => { __suppressUnloadPrompt = false; }, 5000);
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

const DISPLAY_LIMIT = 200;
const SECTION_COLLAPSE_PX = 260;
let cache = { books: [], cards: [], transactions: [] };
let GIFT_CARD_SURCHARGE_RATE = 0.03;

function escapeHtml(s) {
    return String(s || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}
function money(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return '0.00';
    return num.toFixed(2);
}
function toMoneyNumber(n) {
    const num = Number(n);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
}
function formatRatePct(rate) {
    const pct = Math.max(0, Number(rate || 0) * 100);
    return pct.toFixed(2).replace(/\.?0+$/, '');
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
        const ms = Math.max(1200, Number(opts.duration || 2600));
        setTimeout(() => { try { el.remove(); } catch (_) { } }, ms);
    } catch (_) { }
}

function bookLabel(bookId) {
    const book = (cache.books || []).find(b => b.id === bookId);
    if (!book) return '';
    return book.label || book.prefix || book.id || '';
}

function isGiftCardSaleItem(item) {
    const name = String(item?.name || '').toLowerCase();
    return name.includes('gift card') || name.includes('giftcard');
}
function getReceiptItemsSubtotal(receipt) {
    return (Array.isArray(receipt?.items) ? receipt.items : []).reduce((sum, it) => {
        const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
        const unit = toMoneyNumber(it.price || 0);
        return sum + toMoneyNumber(unit * qty);
    }, 0);
}
function getGiftCardSaleTotal(receipt) {
    return (Array.isArray(receipt?.items) ? receipt.items : []).reduce((sum, it) => {
        if (!isGiftCardSaleItem(it)) return sum;
        const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
        const unit = toMoneyNumber(it.price || 0);
        return sum + toMoneyNumber(unit * qty);
    }, 0);
}
function getGiftCardFee(receipt, giftCardSaleTotal) {
    const giftTotal = toMoneyNumber(giftCardSaleTotal || 0);
    if (giftTotal <= 0) return 0;
    const splitEnabled = !!receipt?.splitTenderEnabled;
    const splitType = String(receipt?.splitTenderType || '');
    const payment = String(receipt?.payment || '');
    const cardTenderUsed = payment === 'Card' || (splitEnabled && splitType === 'Card');
    if (!cardTenderUsed) return 0;
    if (splitEnabled && payment !== 'Card') {
        const splitAmount = toMoneyNumber(receipt?.splitTenderAmount || 0);
        const subtotal = (receipt?.subtotal !== undefined && receipt?.subtotal !== null)
            ? toMoneyNumber(receipt.subtotal)
            : getReceiptItemsSubtotal(receipt);
        const tax = toMoneyNumber(receipt?.tax || 0);
        const baseTotal = toMoneyNumber(subtotal + tax);
        const primaryAmount = Math.max(0, baseTotal - splitAmount);
        if (primaryAmount + 0.009 >= giftTotal) return 0;
    }
    return toMoneyNumber(giftTotal * GIFT_CARD_SURCHARGE_RATE);
}

async function loadCashiers() {
    try {
        const list = await invoke('cashiers:load');
        const cashiers = Array.isArray(list) ? list : [];
        ['activateCashier'].forEach(id => {
            const sel = document.getElementById(id);
            if (!sel) return;
            sel.innerHTML = '<option value="" disabled selected>Select...</option>';
            cashiers.forEach(c => {
                const opt = document.createElement('option');
                opt.value = c.name;
                opt.textContent = c.name;
                sel.appendChild(opt);
            });
        });
    } catch (_) { }
}

async function loadData() {
    const data = await invoke('giftcards:load');
    cache = data && typeof data === 'object' ? data : { books: [], cards: [], transactions: [] };
}

function renderSummary() {
    const cards = Array.isArray(cache.cards) ? cache.cards : [];
    const available = cards.filter(c => c.status === 'available').length;
    const active = cards.filter(c => c.status === 'active').length;
    const redeemed = cards.filter(c => c.status === 'redeemed').length;
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('summaryAvailable', available);
    setText('summaryActive', active);
    setText('summaryRedeemed', redeemed);

    const summaryBody = document.getElementById('bookSummaryTable');
    if (!summaryBody) return;
    summaryBody.innerHTML = '';
    (cache.books || []).forEach(book => {
        const bookCards = cards.filter(c => c.bookId === book.id);
        const bookAvailable = bookCards.filter(c => c.status === 'available').length;
        const bookActive = bookCards.filter(c => c.status === 'active').length;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(book.label || book.prefix || book.id || '')}</td>
            <td class="text-end">${bookAvailable}</td>
            <td class="text-end">${bookActive}</td>
        `;
        summaryBody.appendChild(tr);
    });
}

function renderAvailableTable() {
    const tbody = document.getElementById('availableTable');
    const countEl = document.getElementById('availableCount');
    const hintEl = document.getElementById('availableHint');
    if (!tbody) return;
    const available = (cache.cards || []).filter(c => c.status === 'available');
    available.sort((a, b) => String(a.number).localeCompare(String(b.number)));
    const shown = available.slice(0, DISPLAY_LIMIT);
    tbody.innerHTML = '';
    shown.forEach(card => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(card.number)}</td>
            <td>${escapeHtml(bookLabel(card.bookId))}</td>
            <td class="text-end">${escapeHtml(card.status)}</td>
            <td class="text-end">
                <button class="btn btn-sm btn-outline-success" data-action="activate-card" data-number="${escapeHtml(card.number)}">
                    Activate
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
    if (countEl) countEl.textContent = `${available.length} available`;
    if (hintEl) {
        hintEl.textContent = available.length > DISPLAY_LIMIT
            ? `Showing first ${DISPLAY_LIMIT} cards.`
            : '';
    }
    requestAnimationFrame(() => updateGiftcardCollapseUi('availableSection', 'availableTableWrapper', 'availableToggle'));
}

function renderActiveTable() {
    const tbody = document.getElementById('activeTable');
    const countEl = document.getElementById('activeCount');
    const hintEl = document.getElementById('activeHint');
    if (!tbody) return;
    const active = (cache.cards || []).filter(c => c.status === 'active');
    active.sort((a, b) => String(a.number).localeCompare(String(b.number)));
    const shown = active.slice(0, DISPLAY_LIMIT);
    tbody.innerHTML = '';
    shown.forEach(card => {
        const sold = card.soldAt ? new Date(card.soldAt).toLocaleDateString() : '';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(card.number)}</td>
            <td>${escapeHtml(bookLabel(card.bookId))}</td>
            <td class="text-end">$${money(card.balance)}</td>
            <td class="text-end">${escapeHtml(sold)}</td>
        `;
        tbody.appendChild(tr);
    });
    if (countEl) countEl.textContent = `${active.length} active`;
    if (hintEl) {
        hintEl.textContent = active.length > DISPLAY_LIMIT
            ? `Showing first ${DISPLAY_LIMIT} cards.`
            : '';
    }
    requestAnimationFrame(() => updateGiftcardCollapseUi('activeSection', 'activeTableWrapper', 'activeToggle'));
}

function renderRedeemedTable() {
    const tbody = document.getElementById('redeemedTable');
    const countEl = document.getElementById('redeemedCount');
    const hintEl = document.getElementById('redeemedHint');
    if (!tbody) return;
    const txns = (cache.transactions || []).filter(t => String(t.type || '') === 'redeem');
    txns.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const shown = txns.slice(0, DISPLAY_LIMIT);
    tbody.innerHTML = '';
    shown.forEach(txn => {
        const date = txn.createdAt ? new Date(txn.createdAt).toLocaleString() : '';
        const receipt = String(txn.receiptNumber || '').trim();
        const receiptCell = receipt
            ? `<a href="receipts.html?receipt=${encodeURIComponent(receipt)}" data-receipt-id="${escapeHtml(receipt)}">${escapeHtml(receipt)}</a>`
            : '-';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(txn.number)}</td>
            <td>${receiptCell}</td>
            <td>${escapeHtml(date)}</td>
            <td class="text-end">$${money(txn.amount)}</td>
            <td class="text-end">$${money(txn.balanceAfter)}</td>
        `;
        tbody.appendChild(tr);
    });
    if (countEl) countEl.textContent = `${txns.length} redeemed`;
    if (hintEl) {
        hintEl.textContent = txns.length > DISPLAY_LIMIT
            ? `Showing latest ${DISPLAY_LIMIT} redemptions.`
            : '';
    }
    requestAnimationFrame(() => updateGiftcardCollapseUi('redeemedSection', 'redeemedTableWrapper', 'redeemedToggle'));
}

async function refreshAll() {
    await loadData();
    renderSummary();
    renderAvailableTable();
    renderActiveTable();
    renderRedeemedTable();
}

function updateGiftcardCollapseUi(sectionId, wrapperId, toggleId) {
    const section = document.getElementById(sectionId);
    const wrapper = document.getElementById(wrapperId);
    const toggle = document.getElementById(toggleId);
    if (!section || !wrapper || !toggle) return;
    const isCollapsed = section.classList.contains('giftcards-collapsed');
    toggle.setAttribute('aria-expanded', String(!isCollapsed));
    toggle.title = isCollapsed ? 'Show full list' : 'Hide list';
    const icon = toggle.querySelector('.giftcards-toggle-icon');
    if (icon) icon.textContent = isCollapsed ? '▼' : '▲';
    const needsToggle = wrapper.scrollHeight > SECTION_COLLAPSE_PX + 4;
    toggle.classList.toggle('d-none', !needsToggle);
    if (!needsToggle) {
        section.classList.remove('giftcards-collapsed');
        toggle.setAttribute('aria-expanded', 'true');
        if (icon) icon.textContent = '▲';
    }
}

function toggleGiftcardCollapse(sectionId, wrapperId, toggleId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.classList.toggle('giftcards-collapsed');
    updateGiftcardCollapseUi(sectionId, wrapperId, toggleId);
}

async function addBook() {
    const label = String(document.getElementById('bookLabel')?.value || '').trim();
    const prefix = String(document.getElementById('bookPrefix')?.value || '').trim();
    const start = String(document.getElementById('bookStart')?.value || '').trim();
    const end = String(document.getElementById('bookEnd')?.value || '').trim();
    const pad = String(document.getElementById('bookPad')?.value || '').trim();
    if (!start || !end) {
        showToast('Start and end numbers are required.', { type: 'error' });
        return;
    }
    try {
        const resp = await invoke('giftcards:addBook', {
            label,
            prefix,
            start,
            end,
            pad
        });
        if (!resp || !resp.ok) {
            showToast('Failed to add gift card book.', { type: 'error' });
            return;
        }
        showToast(`Added ${resp.added} cards.`, { type: 'success' });
        document.getElementById('bookLabel').value = '';
        document.getElementById('bookPrefix').value = '';
        document.getElementById('bookStart').value = '';
        document.getElementById('bookEnd').value = '';
        document.getElementById('bookPad').value = '';
        await refreshAll();
    } catch (err) {
        showToast(err?.message || 'Failed to add gift card book.', { type: 'error' });
    }
}

function setupActivateModal() {
    const modalEl = document.getElementById('activateGiftCardModal');
    if (!modalEl || !window.bootstrap) return null;
    return new bootstrap.Modal(modalEl);
}

function openActivateModal(number, opts = {}) {
    const numberInput = document.getElementById('activateNumber');
    const amountInput = document.getElementById('activateAmount');
    const cashierSelect = document.getElementById('activateCashier');
    const receiptInput = document.getElementById('activateReceipt');
    const noteInput = document.getElementById('activateNote');
    if (numberInput) numberInput.value = number || '';
    if (amountInput) amountInput.value = opts.amount || '';
    if (receiptInput) receiptInput.value = opts.receipt || '';
    if (noteInput) noteInput.value = '';
    if (cashierSelect) cashierSelect.value = '';
    let modal = window.__activateGiftModal;
    if (!modal) {
        modal = setupActivateModal();
        window.__activateGiftModal = modal;
    }
    try { modal?.show(); } catch (_) { }
    try { (cashierSelect || amountInput)?.focus(); } catch (_) { }
}

async function activateCard() {
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
        const modal = window.__activateGiftModal;
        try { modal?.hide(); } catch (_) { }
        document.getElementById('activateNumber').value = '';
        document.getElementById('activateAmount').value = '';
        document.getElementById('activateReceipt').value = '';
        document.getElementById('activateNote').value = '';
        await refreshAll();
    } catch (err) {
        showToast(err?.message || 'Failed to activate gift card.', { type: 'error' });
    }
}

async function lookupCard() {
    const number = String(document.getElementById('lookupNumber')?.value || '').trim();
    const resultEl = document.getElementById('lookupResult');
    const historyEl = document.getElementById('lookupHistory');
    if (!resultEl || !historyEl) return;
    if (!number) {
        resultEl.textContent = 'Enter a card number to see its balance and history.';
        historyEl.innerHTML = '';
        return;
    }
    try {
        const resp = await invoke('giftcards:lookup', { number });
        if (!resp || !resp.card) {
            resultEl.textContent = 'Gift card not found.';
            historyEl.innerHTML = '';
            return;
        }
        const card = resp.card;
        resultEl.innerHTML = `
            <div><strong>Status:</strong> ${escapeHtml(String(card.status || '').toUpperCase())}</div>
            <div><strong>Balance:</strong> $${money(card.balance)}</div>
            <div><strong>Initial Value:</strong> $${money(card.initialValue)}</div>
            <div><strong>Sold:</strong> ${escapeHtml(card.soldAt ? new Date(card.soldAt).toLocaleString() : '-')}</div>
            <div><strong>Cashier:</strong> ${escapeHtml(card.soldBy || '-')}</div>
        `;
        const history = Array.isArray(resp.transactions) ? resp.transactions : [];
        const recent = history.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5);
        if (!recent.length) {
            historyEl.innerHTML = '<div class="small text-muted">No transactions recorded yet.</div>';
            return;
        }
        historyEl.innerHTML = `
            <div class="small text-muted mb-1">Recent Activity</div>
            <div class="table-responsive">
                <table class="table table-sm">
                    <thead class="table-light">
                        <tr>
                            <th>Date</th>
                            <th>Type</th>
                            <th class="text-end">Amount</th>
                            <th class="text-end">Balance</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${recent.map(txn => `
                            <tr>
                                <td>${escapeHtml(new Date(txn.createdAt).toLocaleString())}</td>
                                <td>${escapeHtml(String(txn.type || '').toUpperCase())}</td>
                                <td class="text-end">$${money(txn.amount)}</td>
                                <td class="text-end">$${money(txn.balanceAfter)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        `;
    } catch (err) {
        resultEl.textContent = err?.message || 'Lookup failed.';
        historyEl.innerHTML = '';
    }
}

function buildReceiptHtml(receipt) {
    if (!receipt) return '<div class="text-muted">Receipt not found.</div>';
    const items = Array.isArray(receipt.items) ? receipt.items : [];
    const rows = items.map(it => {
        const qty = Math.max(1, parseInt(it.quantity || it.qty || 1, 10));
        const unit = toMoneyNumber(it.price || 0);
        const lineTotal = toMoneyNumber(unit * qty);
        return `
            <tr>
                <td>${escapeHtml(it.name || '')}</td>
                <td class="text-end">${qty}</td>
                <td class="text-end">$${money(unit)}</td>
                <td class="text-end">$${money(lineTotal)}</td>
            </tr>
        `;
    }).join('');
    const splitEnabled = !!receipt.splitTenderEnabled;
    const splitAmount = toMoneyNumber(receipt.splitTenderAmount || 0);
    const primaryAmount = Math.max(0, toMoneyNumber(receipt.total || 0) - splitAmount);
    const giftNumber = String(receipt.giftCardNumber || '').trim();
    const giftBalance = toMoneyNumber(receipt.giftCardBalance || 0);
    const giftCardSaleTotal = getGiftCardSaleTotal(receipt);
    const cardFee = getGiftCardFee(receipt, giftCardSaleTotal);
    const splitBlock = splitEnabled ? `
        <div class="d-flex justify-content-between"><div>${escapeHtml(receipt.payment || 'Tender 1')}</div><div>$${money(primaryAmount)}</div></div>
        <div class="d-flex justify-content-between"><div>${escapeHtml(receipt.splitTenderType || 'Tender 2')}</div><div>$${money(splitAmount)}</div></div>
        <div class="d-flex justify-content-between"><div>Split Total</div><div>$${money(receipt.total || 0)}</div></div>
    ` : '';
    const giftBlock = (giftNumber || giftBalance > 0) ? `
        <div class="d-flex justify-content-between"><div>Gift Card #</div><div>${escapeHtml(giftNumber || '-')}</div></div>
        <div class="d-flex justify-content-between"><div>Gift Card Balance</div><div>$${money(giftBalance)}</div></div>
    ` : '';
    const cardFeeBlock = cardFee > 0
        ? `<div class="d-flex justify-content-between"><div>Card Fee (${formatRatePct(GIFT_CARD_SURCHARGE_RATE)}%)</div><div>$${money(cardFee)}</div></div>`
        : '';
    return `
        <div class="mb-2">
            <div><strong>Receipt #:</strong> ${escapeHtml(receipt.number || receipt.id || '')}</div>
            <div><strong>Date:</strong> ${escapeHtml(receipt.displayDate || receipt.datetime || '')}</div>
            <div><strong>Cashier:</strong> ${escapeHtml(receipt.cashier || '')}</div>
            <div><strong>Payment:</strong> ${escapeHtml(receipt.payment || '')}</div>
        </div>
        <div class="table-responsive">
            <table class="table table-sm">
                <thead class="table-light">
                    <tr>
                        <th>Item</th>
                        <th class="text-end">Qty</th>
                        <th class="text-end">Unit</th>
                        <th class="text-end">Amount</th>
                    </tr>
                </thead>
                <tbody>${rows || '<tr><td colspan="4" class="text-muted">No items.</td></tr>'}</tbody>
            </table>
        </div>
        <div class="mt-2">
            <div class="d-flex justify-content-between"><div>Subtotal</div><div>$${money(receipt.subtotal || 0)}</div></div>
            <div class="d-flex justify-content-between"><div>Tax</div><div>$${money(receipt.tax || 0)}</div></div>
            ${cardFeeBlock}
            <div class="d-flex justify-content-between fw-semibold"><div>Total</div><div>$${money(receipt.total || 0)}</div></div>
            ${splitBlock}
            ${giftBlock}
        </div>
    `;
}

function setupReceiptModal() {
    const modalEl = document.getElementById('giftcardReceiptModal');
    if (!modalEl || !window.bootstrap) return null;
    return new bootstrap.Modal(modalEl);
}

async function openReceiptModal(receiptId) {
    const bodyEl = document.getElementById('giftcardReceiptBody');
    if (bodyEl) bodyEl.innerHTML = 'Loading receipt…';
    let modal = window.__giftReceiptModal;
    if (!modal) {
        modal = setupReceiptModal();
        window.__giftReceiptModal = modal;
    }
    try { modal?.show(); } catch (_) { }
    try {
        const receipt = await invoke('receipts:get', receiptId);
        if (bodyEl) bodyEl.innerHTML = buildReceiptHtml(receipt);
    } catch (err) {
        if (bodyEl) bodyEl.textContent = err?.message || 'Failed to load receipt.';
    }
}

window.addEventListener('load', async () => {
    try {
        const s = await invoke('settings:load');
        const rate = Number(s?.giftCardSurchargeRate);
        if (!isNaN(rate) && rate >= 0 && rate <= 1) GIFT_CARD_SURCHARGE_RATE = rate;
    } catch (_) { }
    await loadCashiers();
    await refreshAll();
    document.getElementById('addBookBtn')?.addEventListener('click', addBook);
    document.getElementById('activateCardBtn')?.addEventListener('click', activateCard);
    document.getElementById('lookupBtn')?.addEventListener('click', lookupCard);
    document.getElementById('availableToggle')?.addEventListener('click', () => toggleGiftcardCollapse('availableSection', 'availableTableWrapper', 'availableToggle'));
    document.getElementById('activeToggle')?.addEventListener('click', () => toggleGiftcardCollapse('activeSection', 'activeTableWrapper', 'activeToggle'));
    document.getElementById('redeemedToggle')?.addEventListener('click', () => toggleGiftcardCollapse('redeemedSection', 'redeemedTableWrapper', 'redeemedToggle'));
    document.getElementById('lookupNumber')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') lookupCard();
    });
    document.getElementById('availableTable')?.addEventListener('click', (e) => {
        const button = e.target instanceof Element ? e.target.closest('button[data-action="activate-card"]') : null;
        if (!button) return;
        const number = button.getAttribute('data-number') || '';
        if (number) openActivateModal(number);
    });
    document.getElementById('redeemedTable')?.addEventListener('click', (e) => {
        const link = e.target instanceof Element ? e.target.closest('a[data-receipt-id]') : null;
        if (!link) return;
        e.preventDefault();
        const receiptId = link.getAttribute('data-receipt-id') || '';
        if (receiptId) openReceiptModal(receiptId);
    });

    try {
        const params = new URLSearchParams(window.location.search || '');
        const cardNumber = String(params.get('activateCard') || '').trim();
        if (cardNumber) {
            const amount = String(params.get('amount') || '').trim();
            const receipt = String(params.get('receipt') || '').trim();
            openActivateModal(cardNumber, { amount, receipt });
        }
    } catch (_) { }
    try {
        api?.on?.('settings:changed', (_evt, payload) => {
            const rate = Number(payload?.giftCardSurchargeRate);
            if (!isNaN(rate) && rate >= 0 && rate <= 1) GIFT_CARD_SURCHARGE_RATE = rate;
        });
    } catch (_) { }
    window.addEventListener('resize', () => {
        updateGiftcardCollapseUi('availableSection', 'availableTableWrapper', 'availableToggle');
        updateGiftcardCollapseUi('activeSection', 'activeTableWrapper', 'activeToggle');
        updateGiftcardCollapseUi('redeemedSection', 'redeemedTableWrapper', 'redeemedToggle');
    });
});

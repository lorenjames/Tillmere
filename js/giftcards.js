// giftcards.js
const { ipcRenderer } = require('electron');

const DISPLAY_LIMIT = 200;
let cache = { books: [], cards: [], transactions: [] };

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

async function loadCashiers() {
    try {
        const list = await ipcRenderer.invoke('cashiers:load');
        const cashiers = Array.isArray(list) ? list : [];
        ['sellCashier'].forEach(id => {
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
    const data = await ipcRenderer.invoke('giftcards:load');
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
        `;
        tbody.appendChild(tr);
    });
    if (countEl) countEl.textContent = `${available.length} available`;
    if (hintEl) {
        hintEl.textContent = available.length > DISPLAY_LIMIT
            ? `Showing first ${DISPLAY_LIMIT} cards.`
            : '';
    }
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
            ? `<a href="receipts.html?receipt=${encodeURIComponent(receipt)}">${escapeHtml(receipt)}</a>`
            : '-';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(txn.number)}</td>
            <td>${receiptCell}</td>
            <td>${escapeHtml(date)}</td>
            <td class="text-end">$${money(txn.amount)}</td>
        `;
        tbody.appendChild(tr);
    });
    if (countEl) countEl.textContent = `${txns.length} redeemed`;
    if (hintEl) {
        hintEl.textContent = txns.length > DISPLAY_LIMIT
            ? `Showing latest ${DISPLAY_LIMIT} redemptions.`
            : '';
    }
}

async function refreshAll() {
    await loadData();
    renderSummary();
    renderAvailableTable();
    renderActiveTable();
    renderRedeemedTable();
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
        const resp = await ipcRenderer.invoke('giftcards:addBook', {
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

async function sellCard() {
    const number = String(document.getElementById('sellNumber')?.value || '').trim();
    const amount = String(document.getElementById('sellAmount')?.value || '').trim();
    const cashier = String(document.getElementById('sellCashier')?.value || '').trim();
    const receiptNumber = String(document.getElementById('sellReceipt')?.value || '').trim();
    const note = String(document.getElementById('sellNote')?.value || '').trim();
    if (!number) { showToast('Gift card number is required.', { type: 'error' }); return; }
    if (!amount) { showToast('Gift card amount is required.', { type: 'error' }); return; }
    if (!cashier) { showToast('Select a cashier.', { type: 'error' }); return; }
    try {
        const resp = await ipcRenderer.invoke('giftcards:sell', { number, amount, cashier, receiptNumber, note });
        if (!resp || !resp.ok) {
            showToast('Failed to activate gift card.', { type: 'error' });
            return;
        }
        showToast('Gift card activated.', { type: 'success' });
        document.getElementById('sellNumber').value = '';
        document.getElementById('sellAmount').value = '';
        document.getElementById('sellReceipt').value = '';
        document.getElementById('sellNote').value = '';
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
        const resp = await ipcRenderer.invoke('giftcards:lookup', { number });
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

window.addEventListener('load', async () => {
    await loadCashiers();
    await refreshAll();
    document.getElementById('addBookBtn')?.addEventListener('click', addBook);
    document.getElementById('sellCardBtn')?.addEventListener('click', sellCard);
    document.getElementById('lookupBtn')?.addEventListener('click', lookupCard);
    document.getElementById('lookupNumber')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') lookupCard();
    });
});

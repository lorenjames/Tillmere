// opening.js
// Cash drawer opening/closing flow for single register
let ipcRenderer = null;
try { ({ ipcRenderer } = require('electron')); } catch (_) { ipcRenderer = null; }

function wireCloseAppLink() {
  if (!ipcRenderer) return;
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

const DRAWER_DENOMS = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];
let __drawerState = null;
let __managerMode = false;
let __closingDenominationTargets = {};
let __openingPrefillCounts = null;
let __pendingOpeningSubmission = null;
let __depositModalInstance = null;
let __drawerHistoryRows = [];

// ---- UI helpers ----
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
function money(n) { return Number(n || 0).toFixed(2); }
function toMoneyNumber(n) { const num = Number(n); if (!Number.isFinite(num)) return 0; return Math.round(num * 100) / 100; }
function ensurePlaceholder(selectEl) {
  if (!selectEl) return;
  if ([...selectEl.options].some(o => o.value === '')) { selectEl.value = ''; return; }
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = 'Select...';
  opt.disabled = true;
  opt.selected = true;
  selectEl.insertBefore(opt, selectEl.firstChild);
  selectEl.value = '';
}

// ---- Cashiers ----
async function loadCashiersIntoSelect(target) {
  const sel = typeof target === 'string' ? document.getElementById(target) : target;
  if (!sel || !ipcRenderer) return;
  const prev = sel.value || '';
  let list = await ipcRenderer.invoke('cashiers:load');
  if (!Array.isArray(list)) list = [];
  // Deduplicate by name (case-insensitive)
  const seen = new Set();
  const unique = list.filter(c => {
    const k = String(c.name || '').trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  sel.innerHTML = '';
  ensurePlaceholder(sel);
  unique.forEach(c => { const opt = document.createElement('option'); opt.value = c.name; opt.textContent = c.name; sel.appendChild(opt); });
  try { if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev; } catch (_) { }
}

// ---- Denoms ----
function drawerDenomLabel(d) { return d >= 1 ? `$${money(d)}` : `${Math.round(d * 100)}¢`; }
function normalizeClosingDenominationTargets(targets = {}) {
  const safe = {};
  DRAWER_DENOMS.forEach(d => {
    const key = String(d);
    const raw = targets?.[key] ?? targets?.[d];
    const qty = Math.max(0, Math.floor(Number(raw || 0)));
    safe[key] = Number.isFinite(qty) ? qty : 0;
  });
  return safe;
}

function computeDepositCounts(counts = {}, targets = {}) {
  const safeTargets = normalizeClosingDenominationTargets(targets);
  const deposit = {};
  DRAWER_DENOMS.forEach(denom => {
    const key = String(denom);
    const actual = Math.max(0, Math.floor(Number(counts[key] || counts[denom] || 0)));
    const targetQty = Math.max(0, Math.floor(Number(safeTargets[key] || 0)));
    if (actual > targetQty) {
      deposit[key] = actual - targetQty;
    }
  });
  return deposit;
}

function renderDepositModalRows(depositCounts, counts, targets) {
  const rows = [];
  const keys = Object.keys(depositCounts || {})
    .map(k => Number(k))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  if (!keys.length) {
    return '<tr><td colspan="4" class="text-muted small text-center">No specific denominations exceed the targets; please remove the appropriate mix of bills.</td></tr>';
  }
  const safeTargets = normalizeClosingDenominationTargets(targets);
  keys.forEach(denom => {
    const key = String(denom);
    const depositQty = Number(depositCounts[key] || 0);
    const actual = Math.max(0, Math.floor(Number(counts[key] || counts[denom] || 0)));
    const targetQty = Math.max(0, Math.floor(Number(safeTargets[key] || 0)));
    const amount = toMoneyNumber(denom * depositQty);
    rows.push(`
      <tr>
        <td>${drawerDenomLabel(denom)}</td>
        <td class="text-end">${actual}</td>
        <td class="text-end">${targetQty}</td>
        <td class="text-end">${depositQty} ($${money(amount)})</td>
      </tr>
    `);
  });
  return rows.join('');
}

function ensureDepositModal() {
  const el = document.getElementById('drawerDepositModal');
  if (!el) return null;
  if (window.bootstrap && window.bootstrap.Modal) {
    __depositModalInstance = window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static', keyboard: false });
  } else {
    __depositModalInstance = {
      show: () => {
        el.classList.add('show');
        el.style.display = 'block';
      },
      hide: () => {
        el.classList.remove('show');
        el.style.display = 'none';
      }
    };
  }
  return __depositModalInstance;
}

function buildDepositReference(cashier) {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  const safeCashier = String(cashier || 'cashier').trim().replace(/\s+/g, '-');
  return `${timestamp}-${safeCashier}`;
}
async function confirmDepositVerification(depositAmount, depositCounts, counts, targets, cashier) {
  const modalEl = document.getElementById('drawerDepositModal');
  if (!modalEl) return true;
  const amountEl = document.getElementById('depositModalAmount');
  if (amountEl) amountEl.textContent = money(depositAmount);
  const bodyEl = document.getElementById('depositModalBody');
  if (bodyEl) {
    bodyEl.innerHTML = renderDepositModalRows(depositCounts || {}, counts, targets || {});
  }
  const refEl = document.getElementById('depositModalNumber');
  const refValue = buildDepositReference(cashier);
  if (refEl) refEl.value = refValue;
  const confirmBtn = document.getElementById('depositModalConfirm');
  const cancelBtn = document.getElementById('depositModalCancel');
  const modal = ensureDepositModal();
  return new Promise(resolve => {
    const cleanup = () => {
      confirmBtn?.removeEventListener('click', onConfirm);
      cancelBtn?.removeEventListener('click', onCancel);
      modalEl.removeEventListener('hidden.bs.modal', onHidden);
    };
    const onConfirm = () => {
      cleanup();
      modal?.hide();
      resolve(true);
    };
    const onCancel = () => {
      cleanup();
      modal?.hide();
      resolve(false);
    };
    const onHidden = () => {
      cleanup();
      resolve(false);
    };
    confirmBtn?.addEventListener('click', onConfirm);
    cancelBtn?.addEventListener('click', onCancel);
    modalEl.addEventListener('hidden.bs.modal', onHidden, { once: true });
    if (modal) {
      modal.show();
    } else {
      modalEl.classList.add('show');
      modalEl.style.display = 'block';
    }
  });
}

function computeClosingDenominationTotal(targets = {}) {
  const normalized = normalizeClosingDenominationTargets(targets);
  return DRAWER_DENOMS.reduce((sum, denom) => sum + denom * (Number(normalized[String(denom)] || 0)), 0);
}

function renderDrawerDenoms(containerId, counts = {}, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const safeCounts = counts || {};
  const showDeposit = Boolean(opts.showDeposit);
  const depositTargets = showDeposit ? normalizeClosingDenominationTargets(opts.depositTargets || {}) : null;
  container.innerHTML = '';
  if (showDeposit) {
    const header = document.createElement('div');
    header.className = 'd-flex align-items-center justify-content-between mb-2 small text-muted';
    header.innerHTML = `
      <div class="flex-shrink-0" style="width:90px">Denomination</div>
      <div class="flex-grow-1 text-center">Count</div>
      <div class="flex-shrink-0 text-end" style="width:90px">Deposit</div>
    `;
    container.appendChild(header);
  }
  DRAWER_DENOMS.forEach(denom => {
    const row = document.createElement('div');
    row.className = 'd-flex align-items-center justify-content-between gap-2 mb-2';
    const depositHtml = showDeposit
      ? `
        <div class="text-end" style="width:90px">
          <small class="d-block text-muted">Deposit</small>
          <strong data-deposit-denom="${denom}">0</strong>
        </div>`
      : '';
    row.innerHTML = `
      <div class="flex-shrink-0" style="width:90px">${drawerDenomLabel(denom)}</div>
      <input type="number" min="0" step="1" class="form-control form-control-sm text-end flex-grow-1" style="max-width:120px;" data-denom="${denom}" value="${Number(safeCounts[String(denom)] || 0)}">
      ${depositHtml}
    `;
    container.appendChild(row);
  });
  if (showDeposit) {
    updateDepositDenominationColumn(containerId, depositTargets);
  }
}

function updateDepositDenominationColumn(containerId, targets = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const normalizedTargets = normalizeClosingDenominationTargets(targets);
  const counts = readDrawerCounts(containerId);
  DRAWER_DENOMS.forEach(denom => {
    const qty = Math.max(0, Math.floor(Number(counts[String(denom)] || 0)));
    const targetQty = Math.max(0, Math.floor(Number(normalizedTargets[String(denom)] || 0)));
    const depositQty = Math.max(0, qty - targetQty);
    const el = container.querySelector(`[data-deposit-denom="${denom}"]`);
    if (el) el.textContent = depositQty;
  });
}
function readDrawerCounts(containerId) {
  const container = document.getElementById(containerId);
  const counts = {};
  if (!container) return counts;
  DRAWER_DENOMS.forEach(denom => {
    const inp = container.querySelector(`input[data-denom="${denom}"]`);
    const val = Math.max(0, Math.floor(Number(inp?.value || 0)));
    counts[String(denom)] = Number.isFinite(val) ? val : 0;
  });
  return counts;
}
function drawerTotalFromInputs(containerId) {
  const counts = readDrawerCounts(containerId);
  let total = 0;
  Object.keys(counts).forEach(k => { total += Number(k) * Number(counts[k] || 0); });
  return toMoneyNumber(total);
}
function updateDrawerTotal(containerId, totalElId) {
  const total = drawerTotalFromInputs(containerId);
  const el = document.getElementById(totalElId);
  if (el) el.textContent = money(total);
}

function updateClosingInstructionsTotals(total = drawerTotalFromInputs('drawerCloseDenoms')) {
  const floatAmount = toMoneyNumber(Math.min(total, __dailyDrawerTotal));
  const deposit = toMoneyNumber(total - floatAmount);
  const floatDisplay = document.getElementById('closingFloatDisplay');
  const depositDisplay = document.getElementById('closingDepositDisplay');
  if (floatDisplay) floatDisplay.textContent = `$${money(floatAmount)}`;
  if (depositDisplay) depositDisplay.textContent = `$${money(deposit)}`;
  return { floatAmount, deposit };
}

let __dailyDrawerTotal = 0;
const TENDER_TYPES = ['Cash', 'Card', 'Check', 'Gift Card'];
function esc(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function normalizeTender(tender) {
  const raw = String(tender || '').trim();
  return TENDER_TYPES.includes(raw) ? raw : 'Other';
}
function formatDateAsYmd(value) {
  const dt = value instanceof Date ? value : new Date(value || '');
  if (!dt || Number.isNaN(dt.getTime())) return '';
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function updateClosingTargetHint() {
  const hint = document.getElementById('drawerCloseTargetHint');
  if (!hint) return;
  const total = drawerTotalFromInputs('drawerCloseDenoms');
  if (__dailyDrawerTotal > 0) {
    const diff = toMoneyNumber(total - __dailyDrawerTotal);
    const prefix = diff >= 0 ? '+' : '-';
    hint.textContent = `Target: $${money(__dailyDrawerTotal)} | Variance: ${prefix}$${money(Math.abs(diff))}`;
  } else {
    hint.textContent = 'Daily Drawer Total not configured.';
  }
  updateClosingInstructionsTotals(total);
}
function updateDepositTargetCard(state) {
  const targetEl = document.getElementById('drawerTargetAmount');
  const subtitleEl = document.getElementById('drawerTargetSubtitle');
  const lastTotalEl = document.getElementById('drawerLastClosingTotal');
  const varianceEl = document.getElementById('drawerTargetVariance');
  const statusEl = document.getElementById('drawerTargetStatus');
  const btn = document.getElementById('drawerPrintDepositBtn');
  const target = Number(__dailyDrawerTotal || 0);
  const closingTotal = Number(state?.closing?.total || 0);
  const closingCounts = state?.closing?.counts || {};
  const hasClosing = !!state?.closing && Object.keys(closingCounts).length > 0;
  if (targetEl) targetEl.textContent = target > 0 ? `$${money(target)}` : '$0.00';
  if (subtitleEl) subtitleEl.textContent = target > 0
    ? 'Closing totals are expected to match this target.'
    : 'Set the daily drawer total in Settings > Manager Mode.';
  if (lastTotalEl) lastTotalEl.textContent = `$${money(closingTotal)}`;
  if (varianceEl) {
    if (target > 0) {
      const diff = toMoneyNumber(closingTotal - target);
      const prefix = diff >= 0 ? '+' : '-';
      varianceEl.textContent = `Variance: ${prefix}$${money(Math.abs(diff))}`;
    } else {
      varianceEl.textContent = 'Variance: not enforced (target not configured).';
    }
  }
  if (statusEl) {
    if (hasClosing) {
      const when = state.closing.ts ? ` on ${new Date(state.closing.ts).toLocaleString()}` : '';
      const who = state.closing.cashier ? ` by ${esc(state.closing.cashier)}` : '';
      statusEl.textContent = `Last closing recorded${who}${when}.`;
    } else {
      statusEl.textContent = 'No closing recorded yet.';
    }
  }
  if (btn) {
    btn.disabled = !hasClosing;
    btn.title = hasClosing ? 'Open deposit report for the latest closing' : 'Complete a closing before printing the deposit report';
  }
  updateClosingTargetHint();
}
async function loadDailyDrawerTotal() {
  if (!ipcRenderer) return;
  try {
    const settings = await ipcRenderer.invoke('settings:load');
    const denomTargets = normalizeClosingDenominationTargets(settings?.drawerDenominationTargets || settings?.denominationTargets || {});
    __closingDenominationTargets = denomTargets;
    const computedTarget = computeClosingDenominationTotal(denomTargets);
    __dailyDrawerTotal = computedTarget || Math.max(0, Number(settings?.dailyDrawerTotal || 0));
  } catch (err) {
    console.error('Failed to load daily drawer total', err);
    __dailyDrawerTotal = 0;
  }
  updateDepositTargetCard(__drawerState || {});
  updateDepositDenominationColumn('drawerCloseDenoms', __closingDenominationTargets);
}
function buildTenderTotals(receipts, ymd) {
  const totals = { Cash: 0, Card: 0, Check: 0, 'Gift Card': 0, Other: 0 };
  (Array.isArray(receipts) ? receipts : []).forEach(r => {
    if (r.voided) return;
    const when = r.datetime ? new Date(r.datetime) : null;
    if (!when) return;
    const rowYmd = formatDateAsYmd(when);
    if (!rowYmd || rowYmd !== ymd) return;
    const tender = normalizeTender(r.payment);
    totals[tender] = toMoneyNumber(totals[tender] + Number(r.total || 0));
  });
  return totals;
}
let __submitModalInstance = null;
function ensureSubmitModal() {
  const el = document.getElementById('drawerSubmitModal');
  if (!el) return null;
  if (window.bootstrap && window.bootstrap.Modal) {
    __submitModalInstance = window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static', keyboard: false });
    return __submitModalInstance;
  }
  __submitModalInstance = {
    show: () => {
      el.classList.add('show');
      el.style.display = 'block';
    },
    hide: () => {
      el.classList.remove('show');
      el.style.display = 'none';
    }
  };
  return __submitModalInstance;
}
function updateSubmitModalSummary() {
  const closing = __drawerState?.closing;
  const closingTotal = Number(closing?.total || 0);
  const floatAmount = Number(closing?.floatAmount || 0);
  const depositAmount = Number(closing?.deposit?.amount ?? Math.max(0, closingTotal - floatAmount));
  const closingBy = closing?.cashier || 'Cashier';
  const closingAt = closing?.ts ? new Date(closing.ts).toLocaleString() : 'Not recorded';
  const noteText = String(closing?.note || 'None').trim() || 'None';
  const closingByEl = document.getElementById('drawerSubmitClosingBy');
  const closingAtEl = document.getElementById('drawerSubmitClosingAt');
  const closingTotalEl = document.getElementById('drawerSubmitClosingTotal');
  const depositEl = document.getElementById('drawerSubmitDepositTotal');
  const floatEl = document.getElementById('drawerSubmitFloatTotal');
  const noteEl = document.getElementById('drawerSubmitClosingNote');
  if (closingByEl) closingByEl.textContent = closingBy;
  if (closingAtEl) closingAtEl.textContent = closingAt;
  if (closingTotalEl) closingTotalEl.textContent = money(closingTotal);
  if (depositEl) depositEl.textContent = money(depositAmount);
  if (floatEl) floatEl.textContent = money(floatAmount);
  if (noteEl) noteEl.textContent = noteText;
}
function openSubmitTotalsModal() {
  if (!__drawerState?.closing) {
    showToast('Submit closing counts before finalizing daily totals.', { type: 'error' });
    return;
  }
  if (__drawerState?.approved) {
    showToast('Daily totals already submitted.', { type: 'info' });
    return;
  }
  updateSubmitModalSummary();
  const modal = ensureSubmitModal();
  if (modal) {
    modal.show();
  } else {
    const el = document.getElementById('drawerSubmitModal');
    if (el) {
      el.classList.add('show');
      el.style.display = 'block';
    }
  }
}
async function printDepositReport() {
  if (!ipcRenderer) return;
  const closing = __drawerState?.closing;
  const counts = closing?.counts || {};
  if (!closing || Object.keys(counts).length === 0) {
    showToast('Complete a closing before printing the deposit report.', { type: 'error' });
    return;
  }
  const date = String(__drawerState?.date || todayYmd()).trim() || todayYmd();
  let receipts = [];
  try {
    receipts = await ipcRenderer.invoke('receipts:load');
  } catch (err) {
    console.error(err);
    showToast('Failed to load receipts for the deposit report.', { type: 'error' });
    return;
  }
  const tenderTotals = buildTenderTotals(receipts, date);
  openDepositReportWindow({
    date,
    target: Number(__dailyDrawerTotal || 0),
    closingTotal: Number(closing.total || 0),
    counts,
    depositAmount: Number(closing.deposit?.amount || 0),
    depositCounts: closing.deposit?.counts || {},
    openingCounts: __drawerState?.opening?.counts || {},
    openingCashier: __drawerState?.opening?.cashier || '',
    openingTs: __drawerState?.opening?.ts || '',
    tenderTotals,
    closingBy: closing.cashier,
    closingTs: closing.ts,
    closingNote: closing.note
  });
}
function openDepositReportWindow(data) {
  const {
    date,
    target,
    closingTotal,
    counts,
    depositAmount: depositAmountRaw,
    depositCounts,
    openingCounts: rawOpeningCounts,
    openingCashier,
    openingTs,
    tenderTotals,
    closingBy,
    closingTs,
    closingNote
  } = data || {};
  const depositAmount = toMoneyNumber(Number(depositAmountRaw || 0));
  const openingCounts = rawOpeningCounts || {};
  const openingInfo = openingCashier && openingCashier.trim()
    ? `${esc(openingCashier)}${openingTs ? ` on ${new Date(openingTs).toLocaleString()}` : ''}`
    : '—';
  const variance = toMoneyNumber(closingTotal - target);
  const denomKeys = Array.from(new Set([
    ...DRAWER_DENOMS.map(d => String(d)),
    ...Object.keys(counts || {})
  ]))
    .map(v => Number(v))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const denomRows = denomKeys.length
    ? denomKeys.map(denom => {
      const qty = Number(counts[String(denom)] || 0);
      const amount = toMoneyNumber(qty * denom);
      return `<tr>
        <td>${drawerDenomLabel(denom)}</td>
        <td class="text-end">${qty}</td>
        <td class="text-end">$${money(amount)}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="3" class="text-muted small">No denominations recorded.</td></tr>';
  const depositKeySet = Array.from(new Set([
    ...DRAWER_DENOMS.map(d => String(d)),
    ...Object.keys(depositCounts || {})
  ]))
    .map(v => Number(v))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const depositRows = depositKeySet.length
    ? depositKeySet.map(denom => {
      const qty = Number(depositCounts?.[String(denom)] || 0);
      const amount = toMoneyNumber(qty * denom);
      return `<tr>
        <td>${drawerDenomLabel(denom)}</td>
        <td class="text-end">${qty}</td>
        <td class="text-end">$${money(amount)}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="3" class="text-muted small text-center">No deposit denominations recorded.</td></tr>';
  const openingKeySet = Array.from(new Set([
    ...DRAWER_DENOMS.map(d => String(d)),
    ...Object.keys(openingCounts || {})
  ]))
    .map(v => Number(v))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const openingRows = openingKeySet.length
    ? openingKeySet.map(denom => {
      const qty = Number(openingCounts?.[String(denom)] || 0);
      const amount = toMoneyNumber(qty * denom);
      return `<tr>
        <td>${drawerDenomLabel(denom)}</td>
        <td class="text-end">${qty}</td>
        <td class="text-end">$${money(amount)}</td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="3" class="text-muted small text-center">No opening denominations recorded.</td></tr>';
  const openingTotal = openingKeySet.reduce((sum, denom) => {
    return sum + Number(openingCounts?.[String(denom)] || 0) * denom;
  }, 0);
  const tenderRows = ['Cash', 'Card', 'Check', 'Gift Card', 'Other'].map(t => {
    return `<tr>
      <td>${t}</td>
      <td class="text-end">$${money(tenderTotals?.[t] || 0)}</td>
    </tr>`;
  }).join('');
  const totalTender = ['Cash', 'Card', 'Check', 'Gift Card', 'Other']
    .reduce((sum, key) => sum + Number(tenderTotals?.[key] || 0), 0);
  const style = `
    <style>
      @page { size: Letter portrait; margin: 0.25in; }
      body{margin:0;background:#f3f4f6;color:#111;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:12px;}
      .doc{max-width:8.5in;margin:0 auto;}
      .sheet{background:#fff;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:14px;}
      .actions{display:flex;justify-content:flex-end;margin-bottom:6px;}
      .print-btn{background:#2563eb;color:#fff;border:none;border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;}
      .hdr{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
      .title{font-size:18px;font-weight:700;letter-spacing:.25px;color:#0f172a;}
      .label{color:#6b7280;font-size:11px;}
      .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:6px 10px;margin-top:10px;font-size:11px;}
      .summary div{line-height:1.3;}
      .summary-opening{margin-top:4px;}
      .section-title{margin-top:8px;font-size:13px;font-weight:600;}
      .two-column{display:grid;grid-template-columns:repeat(2,minmax(240px,1fr));gap:12px;margin-top:12px;align-items:start;}
      .split-section{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:10px;margin-top:14px;align-items:start;}
      .column-block table{margin-top:6px;}
      .column-block table th, .column-block table td{border-bottom:1px solid #e5e7eb;}
      table{width:100%;border-collapse:collapse;margin-top:4px;font-size:11px;}
      th,td{padding:5px 6px;border-bottom:1px solid #e5e7eb;}
      th{text-align:left;color:#6b7280;font-weight:600;}
      td.text-end{text-align:right;}
      .notes{margin-top:12px;font-size:11px;color:#1f2937;}
      @media print{ body{background:#fff;} .sheet{margin:0;box-shadow:none;padding:10px;} .actions{display:none;} .two-column{grid-template-columns:repeat(2,minmax(220px,1fr));} .split-section{grid-template-columns:repeat(2,minmax(200px,1fr));gap:6px;} }
      .sheet, table {page-break-inside: avoid;}
    </style>`;
  const closingInfo = closingBy ? ` by ${esc(closingBy)}` : '';
  const closingTime = closingTs ? ` on ${new Date(closingTs).toLocaleString()}` : '';
  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Deposit Report (${esc(date)})</title>
        ${style}
      </head>
      <body>
        <div class="doc">
          <div class="actions"><button class="print-btn" onclick="window.print()">Print</button></div>
        <div class="sheet">
            <div class="hdr">
              <div>
                <div class="title">Daily Deposit Summary</div>
                <div class="label">${esc(date)}</div>
              </div>
              <div class="label">Generated ${new Date().toLocaleString()}</div>
            </div>
            <div class="summary">
              <div><div class="label">Drawer Target</div><strong>$${money(target)}</strong></div>
              <div><div class="label">Closing Total</div><strong>$${money(closingTotal)}</strong></div>
              <div><div class="label">Variance</div><strong>${variance >= 0 ? '+' : '-'}$${money(Math.abs(variance))}</strong></div>
              <div><div class="label">Closing</div><strong>${closingInfo}${closingTime}</strong></div>
            </div>
            <div class="summary summary-opening">
              <div><div class="label">Opening</div><strong>${openingInfo}</strong></div>
            </div>
            <div class="two-column">
              <div class="column-block">
                <div class="section-title">Opening Denominations</div>
                <table>
                  <thead>
                    <tr><th>Denomination</th><th class="text-end">Count</th><th class="text-end">Amount ($)</th></tr>
                  </thead>
                  <tbody>${openingRows}</tbody>
                  <tfoot>
                    <tr>
                      <th>Total</th>
                      <th></th>
                      <th class="text-end">$${money(openingTotal)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div class="column-block">
                <div class="section-title">Closing Denominations</div>
                <table>
                  <thead>
                    <tr><th>Denomination</th><th class="text-end">Count</th><th class="text-end">Amount ($)</th></tr>
                  </thead>
                  <tbody>${denomRows}</tbody>
                  <tfoot>
                    <tr>
                      <th>Total</th>
                      <th></th>
                      <th class="text-end">$${money(closingTotal)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <div class="split-section">
              <div class="column-block">
                <div class="section-title">Deposit</div>
                <div class="summary">
                  <div><div class="label">Deposit Amount</div><strong>$${money(depositAmount)}</strong></div>
                </div>
                <table>
                  <thead>
                    <tr><th>Denomination</th><th class="text-end">Count</th><th class="text-end">Amount ($)</th></tr>
                  </thead>
                  <tbody>${depositRows}</tbody>
                </table>
              </div>
              <div class="column-block">
                <div class="section-title">Daily Sales by Tender</div>
                <table>
                  <thead><tr><th>Tender</th><th class="text-end">Total ($)</th></tr></thead>
                  <tbody>${tenderRows}</tbody>
                  <tfoot>
                    <tr><th>Total</th><th class="text-end">$${money(totalTender)}</th></tr>
                  </tfoot>
                </table>
              </div>
            </div>
            ${closingNote ? `<div class="notes">Note: ${esc(closingNote)}</div>` : ''}
            <div class="notes">Denomination counts are used for deposit reconciliation.</div>
          </div>
        </div>
      </body>
    </html>`;
  const w = window.open('', '', 'width=960,height=900');
  if (!w) {
    showToast('Unable to open deposit report window.', { type: 'error' });
    return;
  }
  w.document.write(html);
  w.document.close();
  try { w.focus(); } catch (_) { }
}

// ---- Status ----
function renderDrawerStatusUI(state) {
  const statusEl = document.getElementById('drawerStatusText');
  const metaEl = document.getElementById('drawerMetaText');
  const submitBtn = document.getElementById('drawerSubmitTotalsBtn');
  const openBtn = document.getElementById('drawerOpenBtn');
  const closeBtn = document.getElementById('drawerCloseBtn');
  const status = String(state?.status || 'none');
  const opening = state?.opening;
  const closing = state?.closing;
  const approved = state?.approved;
  if (statusEl) {
    statusEl.textContent = status === 'approved' ? 'Daily totals submitted'
      : status === 'closing-submitted' ? 'Closing completed'
      : status === 'closing-draft' ? 'Closing in progress'
      : status === 'opening-submitted' ? 'Opening submitted'
      : status === 'opening-draft' ? 'Opening in progress'
      : 'Not started';
  }
  const metaParts = [];
  if (opening?.cashier) metaParts.push(`Opening: ${opening.cashier} ($${money(opening.total || 0)})`);
  if (closing?.cashier) metaParts.push(`Closing: ${closing.cashier} ($${money(closing.total || 0)})`);
  try {
    const variance = Number(state?.variance || 0);
    if (!isNaN(variance) && Math.abs(variance) > 0.009) metaParts.push(`Over/Short: ${variance >= 0 ? '+' : '-'}$${money(Math.abs(variance))}`);
  } catch (_) { }
  if (approved?.ts) {
    const who = approved.by ? ` by ${esc(approved.by)}` : '';
    metaParts.push(`Submitted${who} on ${new Date(approved.ts).toLocaleString()}`);
  }
  if (metaEl) metaEl.textContent = metaParts.join(' • ') || 'Opening and closing are required once per day.';
  const canSubmitTotals = Boolean(closing?.submitted && !approved);
  try { if (submitBtn) submitBtn.disabled = !canSubmitTotals; } catch (_) { }
  try { if (openBtn) openBtn.disabled = !!approved; } catch (_) { }
  try { if (closeBtn) closeBtn.disabled = !opening || !!approved; } catch (_) { }
  try { updateDepositTargetCard(state); } catch (_) { }
}

async function refreshDrawerState() {
  try {
    if (!ipcRenderer) {
      const statusEl = document.getElementById('drawerStatusText');
      if (statusEl) statusEl.textContent = 'Electron IPC unavailable';
      const metaEl = document.getElementById('drawerMetaText');
      if (metaEl) metaEl.textContent = 'Reload the app with Electron to use drawer features.';
      return;
    }
    __drawerState = await ipcRenderer.invoke('drawer:get');
    renderDrawerStatusUI(__drawerState);
    const statusEl = document.getElementById('drawerStatusText');
    if (statusEl && statusEl.textContent.trim().toLowerCase() === 'loading...') statusEl.textContent = 'Not started';
    if (statusEl && statusEl.textContent.trim() === '') statusEl.textContent = 'Not started';
  } catch (e) {
    console.error(e);
    showToast('Failed to load drawer status.', { type: 'error' });
    try {
      const statusEl = document.getElementById('drawerStatusText');
      if (statusEl) statusEl.textContent = 'Error loading drawer data';
      const metaEl = document.getElementById('drawerMetaText');
      if (metaEl) metaEl.textContent = 'Check console for details; you can retry Opening/Closing.';
    } catch (_) { }
  }
}

// ---- Prefill from last closing ----
function todayYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function deriveFloatCountsFromClosing(closingCounts = {}, depositCounts = {}) {
  const closingSource = closingCounts && typeof closingCounts === 'object' ? closingCounts : {};
  const depositSource = depositCounts && typeof depositCounts === 'object' ? depositCounts : {};
  const floatCounts = {};
  DRAWER_DENOMS.forEach(denom => {
    const key = String(denom);
    const closingQty = Math.max(0, Math.floor(Number(closingSource[key] ?? closingSource[denom] ?? 0)));
    const depositQty = Math.max(0, Math.floor(Number(depositSource[key] ?? depositSource[denom] ?? 0)));
    floatCounts[key] = Math.max(0, closingQty - depositQty);
  });
  return floatCounts;
}
async function prefillOpeningFromLastClosing() {
  try {
    const today = todayYmd();
    const rows = await ipcRenderer.invoke('drawer:list', { startDate: '', endDate: today });
    if (!Array.isArray(rows)) { __openingPrefillCounts = null; return; }
    const prev = rows.find(r => r.date < today && r.closing && r.closing.counts);
    if (prev?.closing?.counts) {
      __openingPrefillCounts = deriveFloatCountsFromClosing(prev.closing.counts, prev.closing.deposit?.counts);
    } else {
      __openingPrefillCounts = null;
    }
  } catch (e) {
    __openingPrefillCounts = null;
  }
}
function hasOpeningChangedFromPrefill(counts) {
  if (!__openingPrefillCounts) return false;
  const keys = new Set([...Object.keys(__openingPrefillCounts), ...Object.keys(counts || {})]);
  for (const k of keys) {
    const a = Number((counts || {})[k] || 0);
    const b = Number(__openingPrefillCounts[k] || 0);
    if (a !== b) return true;
  }
  return false;
}

// ---- Opening / Closing ----
async function openDrawerOpeningModal() {
  await prefillOpeningFromLastClosing();
  await loadCashiersIntoSelect('drawerOpenCashier');
  const counts = __openingPrefillCounts || __drawerState?.opening?.counts || {};
  renderDrawerDenoms('drawerOpenDenoms', counts);
  try { document.getElementById('drawerOpenDenoms')?.addEventListener('input', () => updateDrawerTotal('drawerOpenDenoms', 'drawerOpenTotal')); } catch (_) { }
  updateDrawerTotal('drawerOpenDenoms', 'drawerOpenTotal');
  try {
    const noteEl = document.getElementById('drawerOpenNoteInline');
    if (noteEl) noteEl.value = String(__drawerState?.opening?.note || '');
  } catch (_) { }
  const el = document.getElementById('drawerOpenModal');
  if (el && window.bootstrap && window.bootstrap.Modal) {
    window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' }).show();
  } else if (el) {
    el.classList.add('show');
    el.style.display = 'block';
  }
}

async function openDrawerClosingModal() {
  await loadCashiersIntoSelect('drawerCloseCashier');
  const counts = __drawerState?.closing?.counts || {};
  renderDrawerDenoms('drawerCloseDenoms', counts, { showDeposit: true, depositTargets: __closingDenominationTargets });
  const needChangeEl = document.getElementById('drawerNeedChange');
  if (needChangeEl) needChangeEl.checked = false;
  try { document.getElementById('drawerCloseDenoms')?.addEventListener('input', () => { updateDrawerTotal('drawerCloseDenoms', 'drawerCloseTotal'); updateClosingTargetHint(); updateDepositDenominationColumn('drawerCloseDenoms', __closingDenominationTargets); }); } catch (_) { }
  updateDrawerTotal('drawerCloseDenoms', 'drawerCloseTotal');
  try {
    const noteEl = document.getElementById('drawerCloseNote');
    if (noteEl) noteEl.value = String(__drawerState?.closing?.note || '');
  } catch (_) { }
  updateClosingTargetHint();
  const el = document.getElementById('drawerCloseModal');
  if (el && window.bootstrap && window.bootstrap.Modal) {
    window.bootstrap.Modal.getOrCreateInstance(el, { backdrop: 'static' }).show();
  } else if (el) {
    el.classList.add('show');
    el.style.display = 'block';
  }
}

async function finalizeOpeningSubmit(payload, pinEl) {
  try {
    await ipcRenderer.invoke('drawer:saveOpening', payload);
    if (pinEl) pinEl.value = '';
    const el = document.getElementById('drawerOpenModal');
    if (window.bootstrap && el) window.bootstrap.Modal.getOrCreateInstance(el).hide();
    else if (el) { el.classList.remove('show'); el.style.display = 'none'; }
    try {
      const noteModal = document.getElementById('drawerOpenNoteModal');
      if (noteModal && window.bootstrap) window.bootstrap.Modal.getOrCreateInstance(noteModal).hide();
      else if (noteModal) { noteModal.classList.remove('show'); noteModal.style.display = 'none'; }
    } catch (_) { }
    __pendingOpeningSubmission = null;
    try { const noteEl = document.getElementById('drawerOpenNote'); if (noteEl) noteEl.value = ''; } catch (_) { }
    try { const noteEl = document.getElementById('drawerOpenNoteInline'); if (noteEl) noteEl.value = ''; } catch (_) { }
    await refreshDrawerState();
    showToast('Opening submitted.', { type: 'success' });
  } catch (e) {
    console.error(e);
    showToast(e?.message || 'Failed to save opening.', { type: 'error' });
  }
}

async function submitOpeningWithNote() {
  const noteEl = document.getElementById('drawerOpenNote');
  const note = String(noteEl?.value || '').trim();
  if (!note) { showToast('Please add a note explaining the change.', { type: 'error' }); return; }
  const payload = __pendingOpeningSubmission || {};
  await finalizeOpeningSubmit({ ...payload, note }, document.getElementById('drawerOpenPin'));
  try {
    const inline = document.getElementById('drawerOpenNoteInline');
    if (inline) inline.value = note;
  } catch (_) { }
}

async function submitDrawerOpening() {
  const cashierEl = document.getElementById('drawerOpenCashier');
  const pinEl = document.getElementById('drawerOpenPin');
  const cashier = String(cashierEl?.value || '').trim();
  const pin = String(pinEl?.value || '').trim();
  const noteEl = document.getElementById('drawerOpenNoteInline');
  const note = String(noteEl?.value || '').trim();
  if (!cashier) { showToast('Select a cashier for opening.', { type: 'error' }); return; }
  if (!pin) { showToast('Enter PIN for opening.', { type: 'error' }); return; }
  const counts = readDrawerCounts('drawerOpenDenoms');
  const changed = hasOpeningChangedFromPrefill(counts);
  if (changed && !note) {
    __pendingOpeningSubmission = { cashier, pin, counts };
    try {
      const noteModalInput = document.getElementById('drawerOpenNote');
      if (noteModalInput) noteModalInput.value = '';
    } catch (_) { }
    const noteModal = document.getElementById('drawerOpenNoteModal');
    if (noteModal && window.bootstrap && window.bootstrap.Modal) window.bootstrap.Modal.getOrCreateInstance(noteModal, { backdrop: 'static' }).show();
    else if (noteModal) { noteModal.classList.add('show'); noteModal.style.display = 'block'; }
    return;
  }
  await finalizeOpeningSubmit({ cashier, pin, counts, note }, pinEl);
}

async function submitDrawerClosing() {
  const cashierEl = document.getElementById('drawerCloseCashier');
  const pinEl = document.getElementById('drawerClosePin');
  const cashier = String(cashierEl?.value || '').trim();
  const pin = String(pinEl?.value || '').trim();
  const noteEl = document.getElementById('drawerCloseNote');
  const note = String(noteEl?.value || '').trim();
  if (!cashier) { showToast('Select a cashier for closing.', { type: 'error' }); return; }
  if (!pin) { showToast('Enter PIN for closing.', { type: 'error' }); return; }
  const counts = readDrawerCounts('drawerCloseDenoms');
  const closingAmount = Object.keys(counts).reduce((sum, denom) => sum + Number(denom) * Number(counts[denom] || 0), 0);
  const closingTotal = toMoneyNumber(closingAmount);
  const needChange = Boolean(document.getElementById('drawerNeedChange')?.checked);
  const depositAmount = toMoneyNumber(Math.max(0, closingTotal - __dailyDrawerTotal));
  const { floatAmount, deposit } = updateClosingInstructionsTotals(closingTotal);
  if (closingTotal < __dailyDrawerTotal) {
    showToast(`Closing total ($${money(closingTotal)}) must be at least the drawer target ($${money(__dailyDrawerTotal)}).`, { type: 'error' });
    return;
  }
  let depositCounts = {};
  if (depositAmount > 0) {
    depositCounts = computeDepositCounts(counts, __closingDenominationTargets);
    const confirmed = await confirmDepositVerification(depositAmount, depositCounts, counts, __closingDenominationTargets, cashier);
    if (!confirmed) {
      showToast('Deposit verification canceled.', { type: 'error' });
      return;
    }
  }
  const depositNumberEl = document.getElementById('depositModalNumber');
  const depositNumber = String(depositNumberEl?.value || '').trim();
  try {
    await ipcRenderer.invoke('drawer:saveClosing', {
      cashier,
      pin,
      counts,
      note,
      floatAmount,
      depositAmount,
      depositCounts,
      needChange,
      depositNumber
    });
    if (pinEl) pinEl.value = '';
    if (noteEl) noteEl.value = '';
    if (window.bootstrap) window.bootstrap.Modal.getOrCreateInstance(document.getElementById('drawerCloseModal')).hide();
    else { const el = document.getElementById('drawerCloseModal'); if (el) { el.classList.remove('show'); el.style.display = 'none'; } }
    await refreshDrawerState();
    const summary = floatAmount > 0
      ? `Closing submitted. Keep $${money(floatAmount)} in drawer, deposit $${money(deposit)}.`
      : `Closing submitted. Deposit $${money(deposit)} recorded.`;
    showToast(summary, { type: 'success' });
    if (floatAmount <= 0) {
      try { await printDepositReport(); } catch (err) { console.error('Deposit report failed', err); }
    } else {
      showToast('Float noted for next day.', { type: 'info', duration: 2500 });
    }
  } catch (e) {
    console.error(e);
    showToast(e?.message || 'Failed to save closing.', { type: 'error' });
  }
}

async function submitDailyTotals() {
  if (!ipcRenderer) return;
  const closing = __drawerState?.closing;
  if (!closing) {
    showToast('Submit closing counts before finalizing daily totals.', { type: 'error' });
    return;
  }
  if (__drawerState?.approved) {
    showToast('Daily totals already submitted.', { type: 'info' });
    return;
  }
  const modal = ensureSubmitModal();
  try {
    await ipcRenderer.invoke('drawer:approve', {
      date: __drawerState?.date || todayYmd(),
      by: closing.cashier || 'Cashier'
    });
    if (modal) modal.hide();
    await refreshDrawerState();
    showToast('Daily totals submitted. Printing deposit report.', { type: 'success' });
    try {
      await printDepositReport();
    } catch (err) {
      console.error('Deposit report failed after submission', err);
    }
  } catch (e) {
    console.error(e);
    showToast(e?.message || 'Failed to submit daily totals.', { type: 'error' });
  }
}

// ---- History (manager only) ----
function readManagerModeStateFromStorage() {
  try {
    const enabled = localStorage.getItem('managerModeEnabled') === '1';
    const expires = Math.max(0, Number(localStorage.getItem('managerModeExpiresAt') || '0'));
    if (enabled && expires && Date.now() > expires) {
      localStorage.removeItem('managerModeEnabled');
      localStorage.removeItem('managerModeExpiresAt');
      return { enabled: false, expiresAt: 0 };
    }
    return { enabled, expiresAt: expires };
  } catch (_) {
    return { enabled: false, expiresAt: 0 };
  }
}

function syncManagerModeFromStorage() {
  const state = readManagerModeStateFromStorage();
  __managerMode = state.enabled;
  try {
    const card = document.getElementById('drawerHistoryCard');
    if (card) card.style.display = __managerMode ? '' : 'none';
  } catch (_) { }
  try {
    const badge = document.getElementById('managerModeBadge');
    if (badge) {
      badge.style.display = '';
      badge.textContent = __managerMode ? 'Manager Mode' : 'Manager Locked';
      badge.className = __managerMode ? 'badge bg-success' : 'badge bg-secondary';
    }
  } catch (_) { }
}
function renderHistoryTable(rows) {
  const wrap = document.getElementById('drawerHistoryTableWrap');
  const empty = document.getElementById('drawerHistoryEmpty');
  const tbody = document.getElementById('drawerHistoryTableBody');
  if (!wrap || !empty || !tbody) return;
  const safeRows = Array.isArray(rows) ? rows : [];
  __drawerHistoryRows = safeRows;
  if (!__managerMode) {
    wrap.style.display = 'none';
    empty.textContent = 'Enable Manager Mode to view drawer history.';
    empty.style.display = '';
    return;
  }
  if (!safeRows.length) {
    wrap.style.display = 'none';
    empty.textContent = 'No drawer records found for the selected dates.';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  wrap.style.display = '';
  tbody.innerHTML = safeRows.map(r => {
    const opening = r.opening ? `${r.opening.cashier || ''} ($${money(r.opening.total || 0)})` : '-';
    const closing = r.closing ? `${r.closing.cashier || ''} ($${money(r.closing.total || 0)})` : '-';
    const variance = Number(r.variance || 0);
    const varianceLabel = `${variance >= 0 ? '+' : '-'}$${money(Math.abs(variance))}`;
    const actionHasClosing = r.closing && Object.keys(r.closing.counts || {}).length > 0;
    const actionButton = `
      <button type="button"
        class="btn btn-sm btn-outline-secondary"
        data-history-date="${esc(r.date || '')}"
        ${actionHasClosing ? '' : 'disabled'}
        title="${actionHasClosing ? 'View deposit report' : 'No closing recorded'}">
        ${actionHasClosing ? 'View Report' : 'No Report'}
      </button>
    `;
    return `
      <tr>
        <td>${r.date || ''}</td>
        <td>${opening}</td>
        <td>${closing}</td>
        <td class="${variance === 0 ? 'text-muted' : (variance > 0 ? 'text-success' : 'text-danger')}">${varianceLabel}</td>
        <td>${r.status || ''}</td>
        <td class="text-end">${actionButton}</td>
      </tr>
    `;
  }).join('');
  tbody.querySelectorAll('[data-history-date]').forEach(btn => {
    btn.addEventListener('click', () => {
      const date = btn.getAttribute('data-history-date');
      void openHistoryDepositReport(date);
    });
  });
}

async function openHistoryDepositReport(date) {
  if (!ipcRenderer) return;
  if (!__managerMode) {
    showToast('Enable Manager Mode to view drawer reports.', { type: 'error' });
    return;
  }
  const targetDate = String(date || '').trim();
  if (!targetDate) {
    showToast('Select a history record to view its deposit report.', { type: 'error' });
    return;
  }
  const record = __drawerHistoryRows.find(r => String(r?.date || '') === targetDate);
  if (!record || !record.closing) {
    showToast('Unable to locate closing details for that date.', { type: 'error' });
    return;
  }
  const closing = record.closing;
  const closingCounts = closing.counts || {};
  if (!Object.keys(closingCounts).length) {
    showToast('Closing counts are missing for that record.', { type: 'error' });
    return;
  }
  let receipts = [];
  try {
    receipts = await ipcRenderer.invoke('receipts:load');
  } catch (err) {
    console.error(err);
    showToast('Failed to load receipts for the deposit report.', { type: 'error' });
    return;
  }
  const reportDate = targetDate || todayYmd();
  const tenderTotals = buildTenderTotals(receipts, reportDate);
  openDepositReportWindow({
    date: reportDate,
    target: Number(__dailyDrawerTotal || 0),
    closingTotal: Number(closing.total || 0),
    counts: closingCounts,
    depositAmount: Number(closing.deposit?.amount || 0),
    depositCounts: closing.deposit?.counts || {},
    openingCounts: record.opening?.counts || {},
    openingCashier: record.opening?.cashier || '',
    openingTs: record.opening?.ts || '',
    tenderTotals,
    closingBy: closing.cashier,
    closingTs: closing.ts,
    closingNote: closing.note
  });
}
async function loadDrawerHistory() {
  if (!__managerMode) {
    renderHistoryTable([]);
    return;
  }
  const start = document.getElementById('historyStart')?.value || '';
  const end = document.getElementById('historyEnd')?.value || '';
  try {
    const rows = await ipcRenderer.invoke('drawer:list', { startDate: start, endDate: end });
    renderHistoryTable(Array.isArray(rows) ? rows : []);
  } catch (e) {
    console.error(e);
    showToast('Failed to load drawer history.', { type: 'error' });
  }
}

// ---- Init ----
window.addEventListener('load', async () => {
  try { document.getElementById('drawerOpenBtn')?.addEventListener('click', openDrawerOpeningModal); } catch (_) { }
  try { document.getElementById('drawerCloseBtn')?.addEventListener('click', openDrawerClosingModal); } catch (_) { }
  try { document.getElementById('drawerSubmitTotalsBtn')?.addEventListener('click', openSubmitTotalsModal); } catch (_) { }
  try { document.getElementById('drawerOpenSubmitBtn')?.addEventListener('click', submitDrawerOpening); } catch (_) { }
  try { document.getElementById('drawerCloseSubmitBtn')?.addEventListener('click', submitDrawerClosing); } catch (_) { }
  try { document.getElementById('drawerSubmitConfirmBtn')?.addEventListener('click', submitDailyTotals); } catch (_) { }
  try { document.getElementById('drawerOpenNoteSubmitBtn')?.addEventListener('click', submitOpeningWithNote); } catch (_) { }
  try { document.getElementById('drawerPrintDepositBtn')?.addEventListener('click', printDepositReport); } catch (_) { }
  syncManagerModeFromStorage();
  try { document.getElementById('historyFilterBtn')?.addEventListener('click', loadDrawerHistory); } catch (_) { }
  try {
    if (ipcRenderer && ipcRenderer.on) {
      ipcRenderer.on('settings:changed', (_evt, payload) => {
        let targetUpdated = false;
        if (payload?.drawerDenominationTargets || payload?.denominationTargets) {
          __closingDenominationTargets = normalizeClosingDenominationTargets(payload.drawerDenominationTargets || payload.denominationTargets || {});
          __dailyDrawerTotal = computeClosingDenominationTotal(__closingDenominationTargets);
          updateDepositDenominationColumn('drawerCloseDenoms', __closingDenominationTargets);
          targetUpdated = true;
        }
        if (!targetUpdated && typeof payload?.dailyDrawerTotal === 'number') {
          __dailyDrawerTotal = Math.max(0, Number(payload.dailyDrawerTotal));
          targetUpdated = true;
        }
        if (targetUpdated) {
          updateDepositTargetCard(__drawerState || {});
        }
      });
    }
  } catch (_) { }
  const statusEl = document.getElementById('drawerStatusText');
  if (statusEl) statusEl.textContent = 'Loading...';
  await loadDailyDrawerTotal();
  await refreshDrawerState();
  await loadDrawerHistory();
  setTimeout(() => {
    const st = document.getElementById('drawerStatusText');
    if (st && st.textContent.trim().toLowerCase() === 'loading...') refreshDrawerState();
  }, 400);
  setTimeout(() => {
    const st = document.getElementById('drawerStatusText');
    if (st && st.textContent.trim().toLowerCase() === 'loading...') refreshDrawerState();
  }, 1000);
});

window.addEventListener('storage', (event) => {
  if (event.key === 'managerModeEnabled' || event.key === 'managerModeExpiresAt') {
    syncManagerModeFromStorage();
  }
});

try {
  if (ipcRenderer && ipcRenderer.on) {
    ipcRenderer.on('app:prepareQuit', () => {
      try {
        localStorage.removeItem('managerModeEnabled');
        localStorage.removeItem('managerModeExpiresAt');
      } catch (_) {}
    });
  }
} catch (_) {}

// Surface script errors in UI
window.addEventListener('error', (e) => {
  try {
    const statusEl = document.getElementById('drawerStatusText');
    if (statusEl) statusEl.textContent = 'Error loading drawer UI';
    const metaEl = document.getElementById('drawerMetaText');
    if (metaEl) metaEl.textContent = (e?.message || 'Unknown error').toString();
  } catch (_) { }
});

// Expose for inline handlers/tests
window.submitDrawerOpening = submitDrawerOpening;
window.submitDrawerClosing = submitDrawerClosing;
window.openDrawerSubmitTotalsModal = openSubmitTotalsModal;
window.submitDailyTotals = submitDailyTotals;
window.approveDrawerDay = submitDailyTotals;
window.openDrawerOpeningModal = openDrawerOpeningModal;
window.openDrawerClosingModal = openDrawerClosingModal;
window.submitOpeningWithNote = submitOpeningWithNote;
window.refreshDrawerState = refreshDrawerState;
window.printDepositReport = printDepositReport;
window.openHistoryDepositReport = openHistoryDepositReport;

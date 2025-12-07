const { ipcRenderer } = require('electron');

const state = {
  bodyEl: null,
  titleEl: null,
  metaEl: null,
  subtotalEl: null,
  taxEl: null,
  totalEl: null,
  totalSummaryEl: null,
  changeDueWrapEl: null,
  changeDueEl: null,
  cashReceivedWrapEl: null,
  cashReceivedEl: null
};

/* Customer carousel logic disabled
const carouselState = {
  slides: [],
  currentIndex: 0,
  timer: null,
  intervalMs: 7000
};
const carouselElements = {
  title: null,
  caption: null,
  image: null,
  indicators: null
};
*/

function escapeHtml(value) {
  const str = String(value || '');
  return str.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

function safeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatMoney(value) {
  return safeNumber(value).toFixed(2);
}

function renderCart(payload) {
  if (!state.bodyEl) return;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  state.bodyEl.innerHTML = '';
  if (!items.length) {
    state.bodyEl.innerHTML = '<tr><td colspan="3" class="text-center text-muted py-5">Welcome to Middletons!</td></tr>';
  } else {
    items.forEach((item) => {
      const tr = document.createElement('tr');
      const qty = Math.max(0, safeNumber(item.quantity));
      const vendorParts = [];
      if (item.comment) vendorParts.push(escapeHtml(item.comment));
      const meta = vendorParts.length ? `<div class="text-muted small">${vendorParts.join(' A? ')}</div>` : '';
      let discountBlock = '';
      if (item.hasDiscount && safeNumber(item.discountAmount) > 0) {
        const suffix = item.discountSuffix ? ` ${escapeHtml(item.discountSuffix)}` : '';
        discountBlock = `
          <div class="text-danger small text-uppercase">Discount: -$${formatMoney(item.discountAmount)}${suffix}</div>
          <div class="text-muted small text-decoration-line-through">Original (unit): $${formatMoney(item.originalPrice)}</div>`;
      }
      tr.innerHTML = `
        <td>
          <div class="fw-semibold">${escapeHtml(item.name)}</div>
          ${meta}
          ${discountBlock}
        </td>
        <td class="text-center fs-4">${qty}</td>
        <td class="text-end">
          <div class="fw-semibold">$${formatMoney(item.total)}</div>
          <div class="text-muted small">${formatMoney(item.unitPrice)} ea</div>
        </td>`;
      state.bodyEl.appendChild(tr);
    });
  }
  const subtotal = formatMoney(payload?.subtotal);
  const tax = formatMoney(payload?.tax);
  const total = formatMoney(payload?.total);
  state.subtotalEl.textContent = subtotal;
  state.taxEl.textContent = tax;
  state.totalEl.textContent = total;
  state.totalSummaryEl.textContent = total;
  state.titleEl.textContent = payload?.cartTitle?.trim() || 'Current Cart';
  const paymentValue = String(payload?.payment || '');
  const changeDueText = formatMoney(payload?.changeDue);
  const cashReceivedText = formatMoney(payload?.cashReceived);
  const isCashPayment = paymentValue.trim().toLowerCase() === 'cash';
  const metaPieces = [];
  if (payload?.cashier) metaPieces.push(`Cashier: ${payload.cashier}`);
  if (payload?.payment) metaPieces.push(`Payment: ${payload.payment}`);
  const metaSeparator = ` ${String.fromCodePoint(0x2022)} `;
  state.metaEl.textContent = metaPieces.join(metaSeparator) || 'Thank You for Shopping Small!';
  if (state.changeDueWrapEl && state.changeDueEl) {
    state.changeDueEl.textContent = changeDueText;
    state.changeDueWrapEl.classList.toggle('d-none', !isCashPayment);
  }
  if (state.cashReceivedWrapEl && state.cashReceivedEl) {
    state.cashReceivedEl.textContent = cashReceivedText;
    state.cashReceivedWrapEl.classList.toggle('d-none', !isCashPayment);
  }
}
function handleCartUpdate(_evt, payload) {
  renderCart(payload);
}

function initCustomerCartView() {
  state.bodyEl = document.getElementById('customerCartBody');
  state.titleEl = document.getElementById('customerCartTitle');
  state.metaEl = document.getElementById('customerCartMeta');
  state.subtotalEl = document.getElementById('customerSubtotal');
  state.taxEl = document.getElementById('customerTax');
  state.totalEl = document.getElementById('customerTotal');
  state.totalSummaryEl = document.getElementById('customerTotalSummary');
  state.changeDueWrapEl = document.getElementById('customerChangeDueWrap');
  state.changeDueEl = document.getElementById('customerChangeDue');
  state.cashReceivedWrapEl = document.getElementById('customerCashReceivedWrap');
  state.cashReceivedEl = document.getElementById('customerCashReceived');
  renderCart(null);
  if (ipcRenderer && typeof ipcRenderer.on === 'function') {
    ipcRenderer.on('customer-cart:update', handleCartUpdate);
  }
  if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
    ipcRenderer.invoke('customer-cart:request')
      .then((initial) => { if (initial) renderCart(initial); })
      .catch(() => { });
  }
}

document.addEventListener('DOMContentLoaded', initCustomerCartView);

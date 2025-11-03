// renderer.js
const { ipcRenderer } = require('electron');

// ---------- Globals ----------
let TAX_RATE = 0.0725;
let items = []; // { name, price, vendorName, comment }
let __vendorsCache = [];
let __editModal = null;
let __cashAudio = null;
let __allowNavigation = false;
let __lastTotal = 0;

// ---------- Utils ----------
function money(n) { return Number(n || 0).toFixed(2); }
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
  const num = Number(n);
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
  if (el) el.textContent = (Number(TAX_RATE) * 100).toFixed(2);
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
function setupEntryDiscountControls() {
  const typeEl = document.getElementById('discountType');
  const valueEl = document.getElementById('discountValue');
  const reasonEl = document.getElementById('discountReason');
  if (!typeEl || !valueEl) return;
  const syncState = () => {
    applyDiscountTypeState(typeEl, valueEl);
    if (typeEl.value === 'none') {
      valueEl.value = '';
      if (reasonEl) reasonEl.placeholder = reasonEl.placeholder || 'e.g., VIP customer';
    }
  };
  typeEl.addEventListener('change', syncState);
  syncState();
}
function installNavigationGuards() {
  const confirmMessage = 'Items are still in the cart. If you leave this page, all sale details will be lost. Continue?';
  const shouldWarn = () => cartHasItems();

  window.addEventListener('beforeunload', (event) => {
    if (__allowNavigation || !shouldWarn()) return;
    event.preventDefault();
    event.returnValue = confirmMessage;
    return confirmMessage;
  });

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor) return;
    if (!anchor.matches('.nav-link, .dropdown-item')) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (anchor.target && anchor.target.toLowerCase() !== '_self') return;
    if (!shouldWarn()) return;
    const ok = window.confirm(confirmMessage);
    if (!ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const destination = anchor.href || href;
    if (!destination) return;
    __allowNavigation = true;
    event.preventDefault();
    try { window.location.assign(destination); } finally {
      setTimeout(() => { __allowNavigation = false; }, 2000);
    }
  }, true);
}

// ---------- Data ----------
async function fetchVendors() { return (await ipcRenderer.invoke('vendors:load')) || []; }
async function fetchCashiers() { return (await ipcRenderer.invoke('cashiers:load')) || []; }

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
function findVendorLoose(vendors, input) {
  const s = norm(input);
  if (!s) return null;
  return (
    vendors.find(v => norm(v.name) === s || norm(v.code || '') === s) ||
    vendors.find(v => norm(v.code || '').replace(/\s+/g, '') === s.replace(/\s+/g, '')) ||
    vendors.find(v => norm(v.name).includes(s)) || null
  );
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
    __vendorsCache = list;
    const v = findVendorLoose(list, val);
    if (v?.code) el.value = v.code;
  } catch (_) {}
}

// ---------- Cashiers ----------
async function loadCashiersIntoSelect() {
  const sel = document.getElementById('cashierSelect');
  if (!sel) return;
  sel.innerHTML = '';
  let list = await fetchCashiers();
  if (!Array.isArray(list) || list.length === 0) {
    list = [{ name: 'Cashier' }];
    await ipcRenderer.invoke('cashiers:save', list);
  }
  ensurePlaceholder(sel);
  list.forEach(c => { const opt = document.createElement('option'); opt.value = c.name; opt.textContent = c.name; sel.appendChild(opt); });
  sel.value = '';
}

// ---------- POS actions ----------
async function addItem() {
  const nameEl = document.getElementById('itemName');
  const priceEl = document.getElementById('itemPrice');
  const vendorEl = document.getElementById('itemVendor');
  const commentEl = document.getElementById('itemComment');
  const discountTypeEl = document.getElementById('discountType');
  const discountValueEl = document.getElementById('discountValue');
  const discountReasonEl = document.getElementById('discountReason');
  const name = (nameEl.value || '').trim();
  const price = parseFloat(priceEl.value);
  const vendorName = (vendorEl.value || '').trim();
  const comment = (commentEl?.value || '').trim();
  if (!name || isNaN(price)) return alert('Enter a valid item name and price.');
  const originalPrice = toMoneyNumber(price);
  const typeVal = discountTypeEl?.value || 'none';
  const discountValueRaw = discountValueEl?.value;
  const discountReasonRaw = (discountReasonEl?.value || '').trim();
  const discount = computeDiscount(originalPrice, typeVal, discountValueRaw, discountReasonRaw);
  if (discount.amount > 0 && !discount.reason) return alert('Please enter a discount reason.');
  const finalPrice = finalPriceFrom(originalPrice, discount.amount);

  let vendorFinal = vendorName;
  try {
    const list = __vendorsCache.length ? __vendorsCache : await fetchVendors();
    __vendorsCache = list;
    const v = findVendorLoose(list, vendorName);
    vendorFinal = v?.code || vendorName;
  } catch (_) {}

  items.push({
    name,
    price: finalPrice,
    originalPrice,
    vendorName: vendorFinal,
    comment,
    discountType: discount.type,
    discountValue: discount.value,
    discountAmount: discount.amount,
    discountReason: discount.amount > 0 ? discount.reason : ''
  });

  nameEl.value = ''; priceEl.value = ''; vendorEl.value = ''; if (commentEl) commentEl.value = '';
  if (discountTypeEl) {
    discountTypeEl.value = 'none';
    applyDiscountTypeState(discountTypeEl, discountValueEl);
  }
  if (discountValueEl) discountValueEl.value = '';
  if (discountReasonEl) discountReasonEl.value = '';
  renderTable();
}
function removeItem(i) { items.splice(i, 1); renderTable(); }

// ---------- Edit modal ----------
function ensureEditModal() {
  if (!__editModal) {
    const el = document.getElementById('editItemModal');
    if (el && window.bootstrap) __editModal = new bootstrap.Modal(el, { backdrop: 'static', keyboard: true });
    const typeEl = document.getElementById('edit_discountType');
    const valueEl = document.getElementById('edit_discountValue');
    if (typeEl && valueEl && !typeEl.dataset._wired) {
      typeEl.addEventListener('change', () => applyDiscountTypeState(typeEl, valueEl, { preserveValue: true }));
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
  if (editReasonEl) editReasonEl.value = hasDisc ? (it.discountReason || '') : '';
  const saveBtn = document.getElementById('edit_save_btn');
  saveBtn.dataset.index = String(i);
  __editModal?.show();
}
async function saveEditFromModal() {
  const btn = document.getElementById('edit_save_btn');
  const idx = Number(btn?.dataset?.index || -1);
  if (!(idx >= 0 && items[idx])) { __editModal?.hide(); return; }
  const name = (document.getElementById('edit_name').value || '').trim();
  const price = parseFloat(document.getElementById('edit_price').value);
  const vendorName = (document.getElementById('edit_vendor').value || '').trim();
  const comment = (document.getElementById('edit_comment').value || '').trim();
  if (!name || isNaN(price)) return alert('Enter a valid item name and price.');
  const originalPrice = toMoneyNumber(price);
  const typeEl = document.getElementById('edit_discountType');
  const valueEl = document.getElementById('edit_discountValue');
  const reasonEl = document.getElementById('edit_discountReason');
  const discountType = typeEl?.value || 'none';
  const discountValue = valueEl?.value;
  const discountReason = (reasonEl?.value || '').trim();
  const discount = computeDiscount(originalPrice, discountType, discountValue, discountReason);
  if (discount.amount > 0 && !discount.reason) return alert('Please enter a discount reason.');
  const finalPrice = finalPriceFrom(originalPrice, discount.amount);

  let vendorFinal = vendorName;
  try {
    const list = __vendorsCache.length ? __vendorsCache : await fetchVendors();
    __vendorsCache = list;
    const v = findVendorLoose(list, vendorName);
    if (v?.code) vendorFinal = v.code;
    else vendorFinal = vendorName;
  } catch (_) {}

  items[idx] = {
    ...items[idx],
    name,
    price: finalPrice,
    originalPrice,
    vendorName: vendorFinal,
    comment,
    discountType: discount.type,
    discountValue: discount.value,
    discountAmount: discount.amount,
    discountReason: discount.amount > 0 ? discount.reason : ''
  };

  __editModal?.hide();
  renderTable();
}

// ---------- Table & totals ----------
function renderTable() {
  const tbody = document.querySelector('#itemTable tbody');
  tbody.innerHTML = '';
  let subtotal = 0;
  items.forEach((it, i) => {
    const finalPrice = toMoneyNumber(it.price || 0);
    const discountAmount = toMoneyNumber(it.discountAmount || 0);
    const originalPrice = deriveOriginalPrice(it);
    const hasDiscount = discountAmount > 0;
    const reason = hasDiscount ? String(it.discountReason || '').trim() : '';
    const discountSuffix = hasDiscount ? buildDiscountSuffix(it.discountType, it.discountValue, discountAmount, reason, escapeHtml) : '';
    subtotal += finalPrice;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(it.name)}${it.comment ? `<div class="text-muted small">${escapeHtml(it.comment)}</div>` : ''}</td>
      <td class="text-end">
        <div class="fw-semibold">$${money(finalPrice)}</div>
        ${hasDiscount ? `<div class="text-muted small text-decoration-line-through">Original: $${money(originalPrice)}</div>` : ''}
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
  });
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('subtotal', money(subtotal));
  set('tax', money(tax));
  set('total', money(total));
  __lastTotal = toMoneyNumber(total);
  try { updateCashChange(); } catch (_) {}
}

// ---------- Sound ----------
function playCashRegisterSound() {
  // Play only the ka-ching MP3 (no synthesized pre-tone)
  try {
    if (typeof __cashAudio === 'object' && __cashAudio) {
      __cashAudio.currentTime = 0;
      __cashAudio.play().catch(() => {});
      return;
    }
    const audio = new Audio('assets/cash-register-kaching-sound-effect-125042.mp3');
    audio.volume = 0.8;
    audio.play().catch(() => {});
  } catch (_) {}
}

// ---------- Print & save ----------
async function printReceipt() {
  const cashierSelect = document.getElementById('cashierSelect');
  const paymentSelect = document.getElementById('paymentSelect');
  const cashier = cashierSelect?.value || '';
  const payment = paymentSelect?.value || '';
  if (!cashier) return alert('Please select a cashier.');
  if (!payment) return alert('Please select a payment type.');
  try { playCashRegisterSound(); } catch (_) {}

  const numEl = document.getElementById('rcpt-number');
  const dateEl = document.getElementById('rcpt-date');
  const now = new Date();
  const number = `MID-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  numEl.textContent = number; dateEl.textContent = now.toLocaleString();
  document.getElementById('rcpt-cashier').textContent = cashier || '-';
  document.getElementById('rcpt-payment').textContent = payment || '-';

  const vendors = await fetchVendors();
  const rowsEl = document.getElementById('receiptRows');
  rowsEl.innerHTML = '';
  let subtotal = 0; const vendorTotals = {};
  items.forEach(it => {
    const finalPrice = toMoneyNumber(it.price || 0);
    const originalPrice = deriveOriginalPrice(it);
    const discountAmount = toMoneyNumber(it.discountAmount || (originalPrice - finalPrice));
    const hasDiscount = discountAmount > 0;
    const reason = hasDiscount ? String(it.discountReason || '').trim() : '';
    const discountSuffix = hasDiscount ? buildDiscountSuffix(it.discountType, it.discountValue, discountAmount, reason, escapeHtml) : '';
    subtotal += finalPrice;
    const v = findVendorLoose(vendors, it.vendorName); const code = v?.code || '';
    if (code) vendorTotals[code] = (vendorTotals[code] || 0) + finalPrice;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        ${escapeHtml(it.name)}
        ${it.comment ? `<div class="vendor">${escapeHtml(it.comment)}</div>` : ''}
        ${code ? `<div class="vendor">Vendor: ${escapeHtml(code)}</div>` : ''}
        ${hasDiscount ? `<div class="original-line">Original: $${money(originalPrice)}</div>` : ''}
        ${hasDiscount ? `<div class="discount-line">Discount: -$${money(discountAmount)}${discountSuffix}</div>` : ''}
      </td>
      <td class="price">$${money(finalPrice)}</td>`;
    rowsEl.appendChild(tr);
  });
  const tax = subtotal * TAX_RATE; const total = subtotal + tax;
  document.getElementById('receiptSubtotal').textContent = money(subtotal);
  document.getElementById('receiptTax').textContent = money(tax);
  document.getElementById('receiptTotal').textContent = money(total);

  // Persist receipt so it appears on the Receipts page
  try {
    const savedItems = items.map(it => {
        const v = findVendorLoose(vendors, it.vendorName);
        const code = v?.code || '';
        const priceFinal = toMoneyNumber(it.price || 0);
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
          vendorCode: code,
          vendor: it.vendorName || '',
          comment: it.comment || '',
          discountType,
          discountValue,
          discountAmount,
          discountReason
        };
      });
    await ipcRenderer.invoke('receipts:add', {
      datetime: new Date(now.getTime()).toISOString(),
      number,
      cashier,
      payment,
      items: savedItems,
      taxRate: Number(TAX_RATE),
      subtotal: Number(subtotal),
      tax: Number(tax),
      total: Number(total)
    });
  } catch (e) {
    console.error('Failed to save receipt:', e);
  }

  const style = `
    <style>
      @page { size: Letter portrait; margin: 0.5in; }
      :root{ --ink:#111827; --muted:#6b7280; --border:#e5e7eb; --emph:#0f172a; }
      html,body{height:100%}
      body{background:#fff;margin:0;font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:var(--ink);}
      .invoice{max-width:8.5in;margin:0 auto}
      /* extra bottom padding to avoid overlap with QR block */
      .sheet{position:relative;background:#fff;padding:32px 40px 200px 40px}
      .bgmark{position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:70%; height:auto; opacity:.04; pointer-events:none; filter: blur(0.8px);
        -webkit-mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
                mask-image: radial-gradient(ellipse at center, rgba(0,0,0,1) 50%, rgba(0,0,0,0) 85%);
        -webkit-mask-size: 100% 100%; mask-size:100% 100% }
      .header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .brand-wrap{display:flex;gap:12px;align-items:center}
      .brand{font-weight:800;font-size:20px}
      .addr{color:var(--muted);font-size:12px;margin-top:2px}
      .title{font-size:22px;font-weight:800;letter-spacing:.5px;color:var(--emph);text-transform:uppercase}
      .meta{display:grid;grid-template-columns: repeat(2,minmax(180px,1fr)); gap:8px 16px; margin-top:12px}
      table{width:100%;border-collapse:collapse;margin-top:16px}
      thead th{font-size:12px;color:var(--muted);font-weight:700;border-bottom:1px solid var(--border);padding:10px 8px;text-align:left}
      tbody td{padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:top}
      th.num, td.num{text-align:right}
      .desc{font-weight:600}
      .vendor{color:var(--muted);font-size:11px}
      .totals{margin-top:12px;display:grid;grid-template-columns: 1fr auto;row-gap:6px}
      .totals .val{min-width:120px;text-align:right}
      .totals .grand{font-weight:800;font-size:16px}
      /* By default, QR sits after content (last page only). If single page, JS adds .qr-fixed to pin it to page bottom */
      .socialQR{position:static; display:flex; flex-direction:row-reverse; align-items:center; gap:10px; text-align:right; margin-top:12px}
      .socialQR img{width:90px; height:auto; border-radius:8px; border:1px solid var(--border)}
      .socialQR .msg{font-weight:700; font-size:12px; line-height:1.2}
      @media print { .qr-fixed{ position: fixed; right: 0.5in; bottom: 0.5in; } }
    </style>`;

  const vendorsList = await fetchVendors();
  const rowsHtml = items.map((it, idx) => {
    const v = findVendorLoose(vendorsList, it.vendorName); const code = v?.code || '';
    const qty = 1;
    const unit = toMoneyNumber(it.price || 0);
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
            <img class="bgmark" src="assets/MiddletonsStoreFrontLogoBW.png" alt="">
            <div class="header">
              <div class="brand-wrap">
                <img src="assets/MiddletonsStoreFrontLogoBW.png" alt="Logo" width="96" height="96" style="border-radius:12px" />
                <div>
                  <div class="brand">Middleton's Antiques &amp; Uniques</div>
                  <div class="addr">1615 S 17th St, Lincoln, NE · 531-500-0135</div>
                </div>
              </div>
              <div class="title">Sales Invoice</div>
            </div>
            <div class="meta">
              <div><div class="label">Invoice #</div><div><strong>${escapeHtml(number)}</strong></div></div>
              <div><div class="label">Date</div><div><strong>${now.toLocaleString()}</strong></div></div>
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
              <div class="label">Tax (${(TAX_RATE * 100).toFixed(2)}%)</div><div class="val">$${money(tax)}</div>
              <div class="label grand">Total</div><div class="val grand">$${money(total)}</div>
            </div>

            <div class="socialQR">
              <img src="assets/url_qrcodecreator.com_09_16_06.png" alt="Facebook QR code">
              <div class="msg">Visit us on Facebook!! Like, Follow, Share</div>
            </div>
          </div>
        </div>
      </body>
    </html>`;

  // If paying cash, show a dismissible Bootstrap alert with change due,
  // then proceed to print after it is dismissed. Otherwise, proceed immediately.
  try {
    if ((payment || '') === 'Cash') {
      const cashEl = document.getElementById('cashReceived');
      const cash = toMoneyNumber(cashEl?.value || 0);
      const change = Math.max(0, toMoneyNumber(cash - total));

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
      const proceedOnce = () => { if (proceeded) return; proceeded = true; try { completePrintWithHtml(html); } catch (_) {} };
      try { alertEl.addEventListener('closed.bs.alert', proceedOnce, { once: true }); } catch (_) {}
      const closeBtn = alertEl.querySelector('.btn-close');
      if (closeBtn) closeBtn.addEventListener('click', () => setTimeout(proceedOnce, 0), { once: true });
      const okBtn = alertEl.querySelector('.btn.btn-primary');
      if (okBtn) okBtn.addEventListener('click', () => setTimeout(proceedOnce, 0), { once: true });
      return; // Wait for dismissal before printing
    }
  } catch (_) {}

  completePrintWithHtml(html);
}

function completePrintWithHtml(html) {
  const w = window.open('', '', 'width=960,height=900');
  if (w) { w.document.write(html); w.document.close(); }

  // Reset POS
  try {
    items = [];
    const cashierSelect = document.getElementById('cashierSelect');
    const paymentSelect = document.getElementById('paymentSelect');
    document.getElementById('itemName').value = '';
    document.getElementById('itemPrice').value = '';
    document.getElementById('itemVendor').value = '';
    renderTable();
    resetSelectToPlaceholder(cashierSelect);
    resetSelectToPlaceholder(paymentSelect);
    // Reset cash helpers
    const cashWrap = document.getElementById('cashFields');
    if (cashWrap) cashWrap.classList.add('d-none');
    const cashEl = document.getElementById('cashReceived');
    if (cashEl) cashEl.value = '';
    const changeEl = document.getElementById('changeDue');
    if (changeEl) changeEl.textContent = money(0);
  } catch (_) {}
}

function preparePaymentSelect(){ const sel=document.getElementById('paymentSelect'); if(!sel) return; ensurePlaceholder(sel); sel.value=''; }

// ---------- Cash change helpers ----------
function isCashPaymentSelected() {
  try { const sel = document.getElementById('paymentSelect'); return (sel?.value || '') === 'Cash'; } catch (_) { return false; }
}
function toggleCashFields() {
  const wrap = document.getElementById('cashFields');
  if (!wrap) return;
  const show = isCashPaymentSelected();
  wrap.classList.toggle('d-none', !show);
}
function updateCashChange() {
  const cashInput = document.getElementById('cashReceived');
  const changeEl = document.getElementById('changeDue');
  if (!cashInput || !changeEl) return;
  const cash = toMoneyNumber(cashInput.value || 0);
  const total = toMoneyNumber(__lastTotal || 0);
  const change = Math.max(0, toMoneyNumber(cash - total));
  changeEl.textContent = money(change);
}

// ---------- Init ----------
window.addEventListener('load', async () => {
  try { const s = await ipcRenderer.invoke('settings:load'); const tr = Number(s?.taxRate); if (!isNaN(tr) && tr >= 0 && tr <= 1) TAX_RATE = tr; } catch (_) {}
  await loadCashiersIntoSelect();
  preparePaymentSelect();
  setupEntryDiscountControls();
  await loadVendorsIntoDatalist();
  renderTable();
  updateTaxRateLabel();
  installNavigationGuards();

  const addrEl = document.getElementById('rcpt-address');
  if (addrEl) addrEl.textContent = '1615 S 17th St, Lincoln, NE 68502 · 531-500-0135';

  const itemVendorEl = document.getElementById('itemVendor');
  if (itemVendorEl) {
    function normalizeVendorLocal(el){
      try {
        const s = norm(el.value || '');
        if (!s) return;
        const list = Array.isArray(__vendorsCache) && __vendorsCache.length ? __vendorsCache : [];
        const v = bestVendorMatch(list, s) || findVendorLoose(list, s);
        if (v && v.code) el.value = v.code;
      } catch (_) {}
    }
    itemVendorEl.addEventListener('input', () => updateVendorDatalistForValue(itemVendorEl.value || ''));
    itemVendorEl.addEventListener('focus', () => updateVendorDatalistForValue(itemVendorEl.value || ''));
    itemVendorEl.addEventListener('change', () => normalizeVendorInput(itemVendorEl));
    itemVendorEl.addEventListener('blur', () => normalizeVendorInput(itemVendorEl));
    itemVendorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Enter') {
        // Synchronously pick the best match from cache so Tab completes to a code
        normalizeVendorLocal(itemVendorEl);
        // Also kick off async normalization as a fallback (no need to wait)
        try { normalizeVendorInput(itemVendorEl); } catch(_) {}
      }
    });
  }

  // Edit modal vendor field: mirror the same Tab/Enter completion behavior
  const editVendorEl = document.getElementById('edit_vendor');
  if (editVendorEl) {
    function normalizeEditVendorLocal(el){
      try {
        const s = norm(el.value || '');
        if (!s) return;
        const list = Array.isArray(__vendorsCache) && __vendorsCache.length ? __vendorsCache : [];
        const v = bestVendorMatch(list, s) || findVendorLoose(list, s);
        if (v && v.code) el.value = v.code;
      } catch (_) {}
    }
    editVendorEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Enter') {
        normalizeEditVendorLocal(editVendorEl);
      }
    });
  }

  const saveBtn = document.getElementById('edit_save_btn');
  if (saveBtn) saveBtn.addEventListener('click', saveEditFromModal);

  // Preload cash register sound for instant playback
  try {
    __cashAudio = new Audio('assets/cash-register-kaching-sound-effect-125042.mp3');
    __cashAudio.preload = 'auto';
    __cashAudio.volume = 0.8;
  } catch (_) {}

  // Cash helpers
  try {
    const paySel = document.getElementById('paymentSelect');
    if (paySel) paySel.addEventListener('change', () => { toggleCashFields(); updateCashChange(); });
    const cashEl = document.getElementById('cashReceived');
    if (cashEl) cashEl.addEventListener('input', updateCashChange);
    toggleCashFields();
    updateCashChange();
  } catch (_) {}
});

// live tax updates
try {
  ipcRenderer.on('settings:changed', (_evt, payload) => {
    const tr = Number(payload?.taxRate);
    if (!isNaN(tr) && tr >= 0 && tr <= 1) { TAX_RATE = tr; renderTable(); updateTaxRateLabel(); }
  });
} catch (_) {}

// Expose
window.addItem = addItem;
window.printReceipt = printReceipt;
window.openEditModal = openEditModal;

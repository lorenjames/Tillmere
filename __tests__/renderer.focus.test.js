jest.mock('electron');

const { ipcRenderer } = require('electron');

function setupPosDom() {
  document.body.innerHTML = `
    <button id="newSaleBtn">New Sale</button>
    <button id="cancelSaleBtn">Cancel</button>
    <ul id="saleTabs" class="nav nav-tabs"></ul>

    <select id="cashierSelect">
      <option value="">Select</option>
      <option value="Cashier">Cashier</option>
    </select>
    <select id="paymentSelect">
      <option value="">Select</option>
      <option value="Cash">Cash</option>
      <option value="Card">Card</option>
    </select>

    <div id="cashFields" class="d-none"></div>
    <input id="cashReceived" />
    <span id="changeDue"></span>

    <input id="itemName" />
    <input id="itemPrice" />
    <input id="itemQty" />
    <input id="itemVendor" />
    <input id="itemComment" />
    <select id="discountType">
      <option value="none">none</option>
      <option value="percent">percent</option>
      <option value="amount">amount</option>
    </select>
    <input id="discountValue" />
    <select id="discountReason">
      <option value="">Select...</option>
      <option value="Store Promo">Store Promo</option>
    </select>

    <input id="backdateDate" />
    <input type="checkbox" id="backdateToggle" />
    <div id="backdateWrap" class="d-none"></div>
    <input type="checkbox" id="noTaxToggle" />

    <table id="itemTable"><tbody></tbody></table>
    <span id="subtotal"></span>
    <span id="tax"></span>
    <span id="total"></span>
    <span id="taxRatePct"></span>

    <!-- Receipt preview elements used by printReceipt -->
    <span id="rcpt-number"></span>
    <span id="rcpt-date"></span>
    <span id="rcpt-cashier"></span>
    <span id="rcpt-payment"></span>
    <tbody id="receiptRows"></tbody>
    <span id="receiptSubtotal"></span>
    <span id="receiptTax"></span>
    <span id="receiptTotal"></span>
  `;
}

function dispatchLoad() {
  window.dispatchEvent(new Event('load'));
}

describe('POS focus and toast validations', () => {
  beforeEach(() => {
    jest.resetModules();
    setupPosDom();
    try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'vendors:load') return [{ name: 'Vendor A', code: 'V1' }];
      if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
      if (channel === 'settings:load') return { taxRate: 0.0725, silentPrint: true };
      if (channel === 'print:silent') return true;
      return undefined;
    });
    // Stub window.open used by print preview path
    global.window.open = jest.fn(() => ({ document: { write: jest.fn(), close: jest.fn() } }));
    require('../js/renderer.js');
    dispatchLoad();
  });

  test('addItem with missing name/price shows toast and focuses name', async () => {
    const { addItem } = require('../js/renderer.js');
    const nameEl = document.getElementById('itemName');
    const priceEl = document.getElementById('itemPrice');

    // Leave both blank to trigger validation
    nameEl.value = '';
    priceEl.value = '';

    await addItem();

    const host = document.getElementById('toast-host');
    const lastToast = host && host.lastElementChild;
    expect(lastToast).toBeTruthy();
    expect(lastToast.textContent).toContain('Enter a valid item name and price.');
    expect(document.activeElement).toBe(nameEl);
  });

  test('finalizing sale without items keeps focus on itemName', async () => {
    const { printReceipt } = require('../js/renderer.js');
    const nameEl = document.getElementById('itemName');

    await printReceipt();

    const host = document.getElementById('toast-host');
    const lastToast = host && host.lastElementChild;
    expect(lastToast).toBeTruthy();
    expect(lastToast.textContent).toContain('Please add at least one item before printing & saving.');
    expect(document.activeElement).toBe(nameEl);
  });

  test('finalizing sale without cashier focuses cashierSelect', async () => {
    const { addItem, printReceipt } = require('../js/renderer.js');
    const cashierSelect = document.getElementById('cashierSelect');
    const nameEl = document.getElementById('itemName');
    const priceEl = document.getElementById('itemPrice');
    const vendorEl = document.getElementById('itemVendor');

    // Add a valid item so we get past the "no items" check
    nameEl.value = 'Item';
    priceEl.value = '10';
    vendorEl.value = 'Vendor A';
    await addItem();

    // Leave cashier empty
    cashierSelect.value = '';

    await printReceipt();

    const host = document.getElementById('toast-host');
    const lastToast = host && host.lastElementChild;
    expect(lastToast).toBeTruthy();
    expect(lastToast.textContent).toContain('Please select a cashier.');
    expect(document.activeElement).toBe(cashierSelect);
  });

  test('finalizing sale without payment focuses paymentSelect', async () => {
    const { addItem, printReceipt } = require('../js/renderer.js');
    const cashierSelect = document.getElementById('cashierSelect');
    const paymentSelect = document.getElementById('paymentSelect');
    const nameEl = document.getElementById('itemName');
    const priceEl = document.getElementById('itemPrice');
    const vendorEl = document.getElementById('itemVendor');

    // Add a valid item
    nameEl.value = 'Item';
    priceEl.value = '10';
    vendorEl.value = 'Vendor A';
    await addItem();

    cashierSelect.value = 'Cashier';
    paymentSelect.value = '';

    await printReceipt();

    const host = document.getElementById('toast-host');
    const lastToast = host && host.lastElementChild;
    expect(lastToast).toBeTruthy();
    expect(lastToast.textContent).toContain('Please select a payment type.');
    expect(document.activeElement).toBe(paymentSelect);
  });
});


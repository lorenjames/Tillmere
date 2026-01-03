jest.mock('electron');

const { ipcRenderer } = require('electron');

// Track and clean up window 'load' listeners between tests to avoid stacking
const _origAdd = global.addEventListener.bind(global);
const _origRemove = global.removeEventListener.bind(global);
let _loadListeners = [];

function setupTabsDom() {
  document.body.innerHTML = `
    <div>
      <button id="newSaleBtn">New Sale</button>
      <button id="cancelSaleBtn">Cancel</button>
      <ul id="saleTabs" class="nav nav-tabs"></ul>

      <!-- Minimal POS DOM required by renderer.js -->
      <select id="cashierSelect"><option value="">Select</option><option value="Cashier">Cashier</option></select>
      <select id="paymentSelect"><option value="">Select</option><option value="Cash">Cash</option><option value="Card">Card</option></select>
      <div id="cashFields" class="d-none"></div>
      <input id="cashReceived" />
      <span id="changeDue"></span>

      <input id="itemName" />
      <input id="itemPrice" />
      <input id="itemQty" />
      <input id="itemVendor" />
      <input id="itemComment" />
      <select id="discountType"><option value="none">none</option><option value="percent">percent</option><option value="amount">amount</option></select>
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

      <!-- Cancel Sale Modal scaffold -->
      <div class="modal fade" id="cancelSaleModal">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-body">
              <button id="cancelSaleConfirmBtn" type="button">Confirm Cancel</button>
              <button type="button" data-role="cancel">Keep</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function dispatchLoad() {
  window.dispatchEvent(new Event('load'));
}

function tick() { return new Promise(r => setTimeout(r, 0)); }
async function waitForTabsAtLeast(n, timeoutMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const cnt = document.querySelectorAll('#saleTabs button').length;
    if (cnt >= n) return cnt;
    await tick();
  }
  throw new Error(`Timeout waiting for at least ${n} tabs`);
}

describe('multi-sale tabs', () => {
  beforeEach(() => {
    jest.resetModules();
    _loadListeners = [];
    // Wrap addEventListener to record 'load' listeners so we can remove them after each test
    global.addEventListener = (type, listener, options) => {
      if (type === 'load') _loadListeners.push(listener);
      return _origAdd(type, listener, options);
    };
    // Fresh DOM and storage for each test
    setupTabsDom();
    try { localStorage.clear(); sessionStorage.clear(); } catch (_) {}
    // Default mocks
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'vendors:load') return [{ name: 'Vendor A', code: 'V1' }];
      if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
      if (channel === 'settings:load') return { taxRate: 0.0725, silentPrint: true };
      if (channel === 'print:silent') return true;
      return undefined;
    });
    // Stub window.open used by print preview path to avoid jsdom not implemented error
    global.window.open = jest.fn(() => ({ document: { write: jest.fn(), close: jest.fn() } }));
  });

  afterEach(() => {
    try {
      _loadListeners.forEach(fn => { try { _origRemove('load', fn); } catch (_) {} });
    } finally {
      global.addEventListener = _origAdd;
    }
  });

  test('initializes with one Sale tab on load', async () => {
    require('../js/renderer.js');
    dispatchLoad();
    await waitForTabsAtLeast(1);
    const tabs = Array.from(document.querySelectorAll('#saleTabs button'));
    expect(tabs.length).toBe(1);
    expect(tabs[0].textContent).toMatch(/Sale 1/);
    expect(tabs[0].className).toMatch(/active/);
    // With only one tab, cancel should be available to clear it
    expect(document.getElementById('cancelSaleBtn').disabled).toBe(false);
  });

  test('New Sale creates a tab and state is isolated per tab', async () => {
    const { addItem } = require('../js/renderer.js');
    dispatchLoad();
    await waitForTabsAtLeast(1);

    // Tab 1: add an item
    document.getElementById('itemName').value = 'Item A';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();

    // Create new tab
    document.getElementById('newSaleBtn').click();
    await tick();

    // Now active should be Sale 2 and totals should be zero (isolated)
    let tabs = Array.from(document.querySelectorAll('#saleTabs button'));
    expect(tabs.length).toBe(2);
    const active = tabs.find(b => /active/.test(b.className));
    expect(active).toBeTruthy();
    expect(active.textContent).toMatch(/Sale 2/);
    expect(document.getElementById('subtotal').textContent).toBe('0.00');
    expect(document.getElementById('total').textContent).toBe('0.00');
    // With two tabs, cancel should be enabled
    expect(document.getElementById('cancelSaleBtn').disabled).toBe(false);

    // Add an item to tab 2
    document.getElementById('itemName').value = 'Item B';
    document.getElementById('itemPrice').value = '5';
    document.getElementById('itemQty').value = '2';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();

    // Switch back to tab 1 and verify totals still reflect only its items
    const tab1 = tabs.find(b => /Sale 1/.test(b.textContent));
    tab1.click();
    expect(document.getElementById('subtotal').textContent).toBe('10.00');
    // 10 + 7.25% tax = 10.73
    expect(document.getElementById('total').textContent).toBe('10.73');

    // Switch to tab 2 and verify its totals
    const tab2 = document.querySelectorAll('#saleTabs button')[1];
    tab2.click();
    expect(document.getElementById('subtotal').textContent).toBe('10.00');
    expect(document.getElementById('total').textContent).toBe('10.73');

    // Draft form state should be per-tab
    document.getElementById('itemName').value = 'DraftOnly';
    tab1.click();
    expect(document.getElementById('itemName').value).not.toBe('DraftOnly');
    tab2.click();
    expect(document.getElementById('itemName').value).toBe('DraftOnly');
  });

  test('Cancel on empty tab closes that tab and returns to previous', async () => {
    require('../js/renderer.js');
    dispatchLoad();
    await waitForTabsAtLeast(1);

    // Create a second tab (empty)
    document.getElementById('newSaleBtn').click();
    await tick();
    let tabs = Array.from(document.querySelectorAll('#saleTabs button'));
    expect(tabs.length).toBe(2);
    // empty -> no confirm dialog expected
    const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
    document.getElementById('cancelSaleBtn').click();
    tabs = Array.from(document.querySelectorAll('#saleTabs button'));
    // Should close Sale 2 and return to Sale 1
    expect(tabs.length).toBe(1);
    expect(tabs[0].textContent).toMatch(/Sale 1/);
    expect(document.getElementById('cancelSaleBtn').disabled).toBe(false);
    confirmSpy.mockRestore();
  });

  test('Cancel on single populated tab uses in-app modal and resets to Sale 1', async () => {
    const showMock = jest.fn();
    const hideMock = jest.fn();
    // Provide a minimal bootstrap.Modal shim so renderer prefers the app modal over window.confirm
    global.window.bootstrap = {
      Modal: jest.fn(() => ({ show: showMock, hide: hideMock }))
    };
    const { addItem } = require('../js/renderer.js');
    dispatchLoad();
    await waitForTabsAtLeast(1);

    // Populate tab so cancel flow asks for confirmation
    document.getElementById('itemName').value = 'Cancelable Item';
    document.getElementById('itemPrice').value = '3';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();

    const confirmSpy = jest.spyOn(window, 'confirm');
    document.getElementById('cancelSaleBtn').click();
    // App modal should be shown instead of native confirm
    expect(showMock).toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();

    // Approve cancellation via modal button
    document.getElementById('cancelSaleConfirmBtn').click();
    await tick();

    const tabs = Array.from(document.querySelectorAll('#saleTabs button'));
    expect(tabs.length).toBe(1);
    expect(tabs[0].textContent).toMatch(/Sale 1/);
    expect(document.getElementById('subtotal').textContent).toBe('0.00');
    confirmSpy.mockRestore();
    delete global.window.bootstrap;
  });

  test('Completing a sale closes its tab and switches to next with items', async () => {
    const { addItem, printReceipt } = require('../js/renderer.js');
    dispatchLoad();
    await waitForTabsAtLeast(1);

    // Tab 1 with an item
    document.getElementById('itemName').value = 'Item A';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();

    // Create tab 2 and add an item there as well
    document.getElementById('newSaleBtn').click();
    await tick();
    document.getElementById('itemName').value = 'Item B';
    document.getElementById('itemPrice').value = '2';
    document.getElementById('itemQty').value = '3';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();

    // Switch back to tab 1 to complete its sale
    const tab1 = Array.from(document.querySelectorAll('#saleTabs button')).find(b => /Sale 1/.test(b.textContent));
    tab1.click();
    // Set cashier/payment to allow printing
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Card';

    await printReceipt();
    // wait for tab closing and switching
    const _ = await waitForTabsAtLeast(1);

    // Expect tab 1 to be closed; only the pending tab remains and is active
    const labels = Array.from(document.querySelectorAll('#saleTabs button')).map(b => b.textContent.trim());
    expect(labels.length).toBe(1);
    const active = Array.from(document.querySelectorAll('#saleTabs button')).find(b => /active/.test(b.className));
    expect(active).toBeTruthy();
    // With one remaining tab, cancel stays enabled for clearing
    expect(document.getElementById('cancelSaleBtn').disabled).toBe(false);
    // The active tab should have the totals for Item B (2*3=6; total ~ 6.44 with 7.25% tax)
    expect(document.getElementById('subtotal').textContent).toBe('6.00');
    expect(['6.43','6.44']).toContain(document.getElementById('total').textContent);
  });
});


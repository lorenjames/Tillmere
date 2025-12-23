jest.mock('electron');
const { ipcRenderer } = require('electron');

const {
  addItem,
  __test,
} = require('../js/renderer.js');

function setupPrintDom() {
  document.body.innerHTML = `
    <div>
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
      <table id="itemTable"><tbody></tbody></table>
      <span id="subtotal"></span>
      <span id="tax"></span>
      <span id="total"></span>
      <span id="taxRatePct"></span>
      <span id="taxExemptNote" class="d-none"></span>
      <div id="cardFeeRow" class="d-none"><span id="cardFeeAmount"></span></div>
      <select id="cashierSelect"><option value="">Select...</option><option value="Cashier">Cashier</option></select>
      <select id="paymentSelect">
        <option value="">Select...</option>
        <option value="Cash">Cash</option>
        <option value="Card">Card</option>
        <option value="Gift Card">Gift Card</option>
      </select>
      <div id="cashFields" class="d-none"></div>
      <input id="cashReceived" />
      <input id="giftCardNumber" />
      <input id="giftCardAmount" />
      <input type="checkbox" id="splitTenderToggle" />
      <select id="splitTenderType"><option value="">Select...</option><option value="Cash">Cash</option><option value="Card">Card</option></select>
      <input id="splitTenderAmount" />

      <!-- receipt elements used by printReceipt -->
      <span id="rcpt-number"></span>
      <span id="rcpt-date"></span>
      <span id="rcpt-cashier"></span>
      <span id="rcpt-payment"></span>
      <tbody id="receiptRows"></tbody>
      <span id="receiptSubtotal"></span>
      <span id="receiptTax"></span>
      <span id="receiptTotal"></span>
    </div>`;
}

describe('printReceipt validations and save', () => {
  beforeEach(() => {
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'vendors:load') return [{ name: 'Vendor A', code: 'V1' }, { name: 'Store Gift Cards', code: 'STORE-GC' }];
      if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
      if (channel === 'giftcards:redeem') return { ok: true };
      if (channel === 'print:silent') return true;
      if (channel === 'receipts:add') return true;
      if (channel === 'settings:load') return { taxRate: 0.0725, silentPrint: true };
      return undefined;
    });
    __test.resetCart();
    __test.setTaxRate(0.0725);
    __test.setTaxExempt(false);
    setupPrintDom();
  });

  test('blocks when cart empty', async () => {
    const { printReceipt } = require('../js/renderer.js');
    await printReceipt();
    // Should not attempt to save a receipt
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('receipts:add', expect.anything());
  });

  test('blocks when cash payment but no cash received', async () => {
    const { printReceipt } = require('../js/renderer.js');
    // add an item
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    // set selections but leave cashReceived empty
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Cash';
    await printReceipt();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('receipts:add', expect.anything());
  });

  test('blocks when split tender enabled but missing second tender type', async () => {
    const { printReceipt } = require('../js/renderer.js');
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Card';
    document.getElementById('splitTenderToggle').checked = true;
    document.getElementById('splitTenderAmount').value = '5';
    await printReceipt();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('receipts:add', expect.anything());
  });

  test('blocks when split tender enabled but missing second amount', async () => {
    const { printReceipt } = require('../js/renderer.js');
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Card';
    document.getElementById('splitTenderToggle').checked = true;
    document.getElementById('splitTenderType').value = 'Cash';
    await printReceipt();
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('receipts:add', expect.anything());
  });

  test('saves receipt with gift card split tender amounts', async () => {
    const { printReceipt } = require('../js/renderer.js');
    __test.setTaxExempt(true);
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Gift Card';
    document.getElementById('giftCardNumber').value = 'GC-123';
    document.getElementById('giftCardAmount').value = '6';
    document.getElementById('splitTenderToggle').checked = true;
    document.getElementById('splitTenderType').value = 'Cash';
    document.getElementById('splitTenderAmount').value = '4';
    await printReceipt();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('receipts:add', expect.objectContaining({
      payment: 'Gift Card',
      giftCardAmount: 6,
      splitTenderEnabled: true,
      splitTenderType: 'Cash',
      splitTenderAmount: 4
    }));
  });

  test('saves receipt in happy path', async () => {
    const { printReceipt } = require('../js/renderer.js');
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Card';
    await printReceipt();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('receipts:add', expect.objectContaining({
      subtotal: expect.any(Number),
      total: expect.any(Number),
      payment: 'Card',
      cashier: 'Cashier',
      items: expect.any(Array)
    }));
  });

  test('falls back to preview when silent print fails', async () => {
    const { printReceipt } = require('../js/renderer.js');
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'vendors:load') return [{ name: 'Vendor A', code: 'V1' }];
      if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
      if (channel === 'print:silent') return false;
      if (channel === 'receipts:add') return true;
      if (channel === 'settings:load') return { taxRate: 0.0725, silentPrint: true };
      return undefined;
    });
    const openSpy = jest.spyOn(window, 'open').mockReturnValue({ document: { write: jest.fn(), close: jest.fn() } });
    // add an item to allow print
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '10';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Card';
    await printReceipt();
    expect(openSpy).toHaveBeenCalled();
    openSpy.mockRestore();
  });

  test('gift card sales are non-taxable and add card fee when paying by card', async () => {
    const { printReceipt } = require('../js/renderer.js');
    document.getElementById('itemName').value = 'Gift Card Sale';
    document.getElementById('itemPrice').value = '100';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'STORE-GC';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Card';
    await printReceipt();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('receipts:add', expect.objectContaining({
      subtotal: 100,
      tax: 0,
      total: 103
    }));
  });

  test('gift card sales are excluded from tax when paying cash', async () => {
    const { printReceipt } = require('../js/renderer.js');
    document.getElementById('itemName').value = 'Gift Card Sale';
    document.getElementById('itemPrice').value = '50';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'STORE-GC';
    await addItem();
    document.getElementById('cashierSelect').value = 'Cashier';
    document.getElementById('paymentSelect').value = 'Cash';
    document.getElementById('cashReceived').value = '50';
    await printReceipt();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('receipts:add', expect.objectContaining({
      subtotal: 50,
      tax: 0,
      total: 50
    }));
  });
});

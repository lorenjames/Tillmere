jest.mock('electron');
const { ipcRenderer } = require('electron');

const {
  addItem,
  __test,
} = require('../renderer.js');

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
      <input id="discountReason" />
      <table id="itemTable"><tbody></tbody></table>
      <span id="subtotal"></span>
      <span id="tax"></span>
      <span id="total"></span>
      <span id="taxRatePct"></span>
      <span id="taxExemptNote" class="d-none"></span>
      <select id="cashierSelect"><option value="">Select...</option><option value="Cashier">Cashier</option></select>
      <select id="paymentSelect"><option value="">Select...</option><option value="Cash">Cash</option><option value="Card">Card</option></select>
      <div id="cashFields" class="d-none"></div>
      <input id="cashReceived" />

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
      if (channel === 'vendors:load') return [{ name: 'Vendor A', code: 'V1' }];
      if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
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
    const { printReceipt } = require('../renderer.js');
    await printReceipt();
    // Should not attempt to save a receipt
    expect(ipcRenderer.invoke).not.toHaveBeenCalledWith('receipts:add', expect.anything());
  });

  test('blocks when cash payment but no cash received', async () => {
    const { printReceipt } = require('../renderer.js');
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

  test('saves receipt in happy path', async () => {
    const { printReceipt } = require('../renderer.js');
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
    const { printReceipt } = require('../renderer.js');
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
});

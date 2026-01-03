jest.mock('electron');
let electron;
let ipcRenderer;

function setupCustomerDom() {
  document.body.innerHTML = `
    <div>
      <input id="itemName" />
      <input id="itemPrice" />
      <input id="itemQty" value="1" />
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
      <table id="itemTable"><tbody></tbody></table>
      <span id="subtotal"></span>
      <span id="tax"></span>
      <span id="total"></span>
      <select id="paymentSelect">
        <option value="Card" selected>Card</option>
        <option value="Cash">Cash</option>
      </select>
      <div id="cashFields" class="d-none"></div>
      <input id="cashReceived" />
      <select id="cashierSelect">
        <option value="">Select</option>
        <option value="Cashier">Cashier</option>
      </select>
    </div>`;
}

describe('customer cart sync', () => {
  beforeEach(() => {
    jest.resetModules();
    electron = require('electron');
    ipcRenderer = electron.ipcRenderer;
    document.body.innerHTML = '';
    setupCustomerDom();
    ipcRenderer.invoke.mockReset();
    ipcRenderer.send.mockReset();
    ipcRenderer.invoke.mockImplementation((channel) => {
      if (channel === 'vendors:load') return Promise.resolve([{ name: 'Vendor A', code: 'V1' }]);
      if (channel === 'cashiers:load') return Promise.resolve([{ name: 'Cashier' }]);
      return Promise.resolve(undefined);
    });
  });

  test('sends change due and cash received when payment is cash', async () => {
    const renderer = require('../js/renderer.js');
    const { addItem, renderTable, __test } = renderer;
    __test.resetCart();
    __test.setTaxRate(0.0725);
    __test.setTaxExempt(false);
    ipcRenderer.send.mockClear();

    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '100';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    document.getElementById('paymentSelect').value = 'Cash';

    await addItem();
    document.getElementById('cashReceived').value = '150';
    renderTable();

    expect(ipcRenderer.send).toHaveBeenCalled();
    const [, payload] = ipcRenderer.send.mock.calls.slice(-1)[0];
    expect(payload.payment).toBe('Cash');
    expect(payload.cashReceived).toBe('150');
    expect(payload.changeDue).toBeCloseTo(42.75, 2);
  });

  test('rendering after payment type changes resends customer cart state', async () => {
    const renderer = require('../js/renderer.js');
    const { addItem, renderTable, __test } = renderer;
    __test.resetCart();
    __test.setTaxRate(0.0725);
    __test.setTaxExempt(false);

    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '100';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    document.getElementById('paymentSelect').value = 'Card';

    await addItem();
    ipcRenderer.send.mockClear();

    const paySel = document.getElementById('paymentSelect');
    paySel.value = 'Cash';
    renderTable();

    expect(ipcRenderer.send).toHaveBeenCalled();
    const payload = ipcRenderer.send.mock.calls.slice(-1)[0][1];
    expect(payload.payment).toBe('Cash');
  });
});

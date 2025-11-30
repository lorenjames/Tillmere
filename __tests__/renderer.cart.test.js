jest.mock('electron');
const { ipcRenderer } = require('electron');

const {
  addItem,
  removeItem,
  renderTable,
  updateTaxRateLabel,
  __test,
} = require('../renderer.js');

function setupPosDom() {
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
      <select id="paymentSelect"><option value="Cash">Cash</option><option value="Card">Card</option></select>
      <div id="cashFields" class="d-none"></div>
      <input id="cashReceived" />
    </div>`;
  updateTaxRateLabel();
}

describe('POS cart and totals', () => {
  beforeEach(() => {
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'vendors:load') return [{ name: 'Vendor A', code: 'V1' }];
      if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
      return undefined;
    });
    __test.resetCart();
    __test.setTaxRate(0.0725);
    __test.setTaxExempt(false);
    setupPosDom();
  });

  test('addItem pushes to cart and updates totals', async () => {
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '100';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();

    renderTable();
    expect(document.getElementById('subtotal').textContent).toBe('100.00');
    expect(document.getElementById('tax').textContent).toBe('7.25');
    expect(document.getElementById('total').textContent).toBe('107.25');
  });

  test('removeItem updates totals to zero', async () => {
    document.getElementById('itemName').value = 'Lamp';
    document.getElementById('itemPrice').value = '50';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    removeItem(0);
    renderTable();
    expect(document.getElementById('subtotal').textContent).toBe('0.00');
    expect(document.getElementById('total').textContent).toBe('0.00');
  });

  test('tax exempt sets tax to zero', async () => {
    document.getElementById('itemName').value = 'Chair';
    document.getElementById('itemPrice').value = '80';
    document.getElementById('itemQty').value = '1';
    document.getElementById('itemVendor').value = 'V1';
    await addItem();
    __test.setTaxExempt(true);
    renderTable();
    expect(document.getElementById('tax').textContent).toBe('0.00');
    expect(document.getElementById('total').textContent).toBe('80.00');
  });

  test('clearItemEntry resets entry form fields', async () => {
    const { clearItemEntry } = require('../renderer.js');
    // Seed fields with values
    document.getElementById('itemName').value = 'Chair';
    document.getElementById('itemPrice').value = '80';
    document.getElementById('itemQty').value = '3';
    document.getElementById('itemVendor').value = 'V1';
    document.getElementById('itemComment').value = 'Nice';
    document.getElementById('discountType').value = 'percent';
    document.getElementById('discountValue').disabled = false;
    document.getElementById('discountValue').value = '10';
    document.getElementById('discountReason').value = 'Store Promo';

    clearItemEntry();

    expect(document.getElementById('itemName').value).toBe('');
    expect(document.getElementById('itemPrice').value).toBe('');
    expect(document.getElementById('itemQty').value).toBe('1');
    expect(document.getElementById('itemVendor').value).toBe('');
    expect(document.getElementById('itemComment').value).toBe('');
    expect(document.getElementById('discountType').value).toBe('none');
    expect(document.getElementById('discountValue').value).toBe('');
    expect(document.getElementById('discountValue').disabled).toBe(true);
    expect(document.getElementById('discountReason').value).toBe('');
    expect(document.getElementById('discountReason').disabled).toBe(true);
  });
});

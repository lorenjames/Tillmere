jest.mock('electron');

function setupModalDom() {
  document.body.innerHTML = `
    <div id="returnModal">
      <input id="returnReceiptId">
      <div id="returnReceiptSummary"></div>
      <div id="returnItemsList"></div>
      <textarea id="returnReasonInput"></textarea>
      <select id="returnCashierSelect">
        <option value="Alice">Alice</option>
        <option value="Bob">Bob</option>
      </select>
      <div id="returnModalHint" data-default=""></div>
      <input type="checkbox" id="returnEntireCheckbox">
      <button id="returnConfirmBtn" disabled>Return</button>
    </div>
  `;
}

describe('return modal rendering', () => {
  beforeEach(() => {
    jest.resetModules();
    setupModalDom();
    const electron = require('electron');
    electron.ipcRenderer.invoke.mockReset();
    electron.ipcRenderer.invoke.mockImplementation(async (channel, id) => {
      if (channel === 'receipts:get') {
        if (id === 'R-with-return') {
          return {
            id,
            number: id,
            total: 50,
            returned: true,
            returnInfo: {
              reason: 'Damaged',
              user: 'Alice',
              when: '2025-11-22T10:00:00Z',
              items: [{ name: 'Lamp', quantity: 1, price: 10, vendorCode: 'V1' }]
            },
            items: [{ name: 'Lamp', quantity: 1, price: 10, vendorCode: 'V1' }]
          };
        }
        if (id === 'R-partial') {
          return {
            id,
            number: id,
            total: 60,
            returned: true,
            returnInfo: {
              reason: 'Partial',
              user: 'Bob',
              when: '2025-11-23T10:00:00Z',
              items: [{ name: 'Table', quantity: 1, price: 20, vendorCode: 'V3' }]
            },
            items: [{ name: 'Table', quantity: 3, price: 20, vendorCode: 'V3' }]
          };
        }
        return {
          id,
          number: id,
          total: 100,
          returned: false,
          items: [{ name: 'Chair', quantity: 2, price: 25, vendorCode: 'V2' }]
        };
      }
      return undefined;
    });
    global.alert = jest.fn();
  });

  test('shows existing return data when editing a return', async () => {
    const { loadReturnReceipt } = require('../js/receipts.js');
    await loadReturnReceipt('R-with-return');

    const mockIpc = require('electron').ipcRenderer;
    expect(mockIpc.invoke).toHaveBeenCalledWith('receipts:get', 'R-with-return');
    expect(document.getElementById('returnReasonInput').value).toBe('Damaged');
    const summary = document.getElementById('returnReceiptSummary').textContent;
    expect(summary).toMatch(/Existing return/);

    const qtyInput = document.getElementById('returnItemQty-0');
    expect(qtyInput.value).toBe('0');
    const chk = document.getElementById('returnItemChk-0');
    expect(chk.checked).toBe(false); // defaults to unchecked even when returned
    expect(chk.disabled).toBe(true);
    const badgeText = document.getElementById('returnItemsList').innerHTML;
    expect(badgeText).toContain('Returned 1');
  });

  test('fresh return loads items without preselecting them', async () => {
    const { loadReturnReceipt } = require('../js/receipts.js');
    await loadReturnReceipt('R-new');

    const mockIpc = require('electron').ipcRenderer;
    expect(mockIpc.invoke).toHaveBeenCalledWith('receipts:get', 'R-new');
    const qtyInput = document.getElementById('returnItemQty-0');
    expect(qtyInput.value).toBe('2'); // defaults to sale quantity
    const chk = document.getElementById('returnItemChk-0');
    expect(chk.checked).toBe(false); // not auto-selected
    expect(document.getElementById('returnItemsList').innerHTML).not.toContain('Returned');
  });

  test('partially returned item keeps remaining qty enabled and capped', async () => {
    const { loadReturnReceipt } = require('../js/receipts.js');
    await loadReturnReceipt('R-partial');
    const qtyInput = document.getElementById('returnItemQty-0');
    const chk = document.getElementById('returnItemChk-0');
    // 3 sold, 1 returned -> remaining 2, checkbox enabled but unchecked
    expect(chk.disabled).toBe(false);
    expect(chk.checked).toBe(false);
    expect(qtyInput.max).toBe('2');
    expect(qtyInput.value).toBe('2');
    const html = document.getElementById('returnItemsList').innerHTML;
    expect(html).toContain('Returned 1 of 3');
  });

  test('new return shows Return Items label and stays disabled until selection', async () => {
    const receipts = require('../js/receipts.js');
    const { loadReturnReceipt, updateReturnButtonState } = receipts;
    const btn = document.getElementById('returnConfirmBtn');
    expect(btn.textContent).toBe('Return'); // initial
    await loadReturnReceipt('R-new');
    expect(btn.textContent).toBe('Return Items');
    expect(btn.disabled).toBe(true);
    // selecting entire receipt enables it
    document.getElementById('returnEntireCheckbox').checked = true;
    updateReturnButtonState();
    expect(btn.disabled).toBe(false);
  });

  test('editing existing return shows Update Return label but disables with no selection', async () => {
    const { loadReturnReceipt } = require('../js/receipts.js');
    await loadReturnReceipt('R-with-return');
    const btn = document.getElementById('returnConfirmBtn');
    expect(btn.textContent).toBe('Update Return');
    expect(btn.disabled).toBe(true);
  });
});



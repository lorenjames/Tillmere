jest.mock('electron');

describe('receipts page view action', () => {
  let win;
  let electron;
  const sampleReceipt = {
    id: 'R1',
    number: 'R1',
    datetime: '2025-11-22T10:00:00Z',
    displayDate: '11/22/2025',
    cashier: 'Bob',
    payment: 'Card',
    subtotal: 50,
    taxRate: 0.1,
    tax: 5,
    total: 55,
    returned: true,
    returnInfo: {
      reason: 'Damaged',
      user: 'Alice',
      when: '2025-11-23T10:00:00Z',
      items: [{ name: 'Lamp', price: 50, quantity: 1, vendorCode: 'V1' }]
    },
    items: [{ name: 'Lamp', price: 50, quantity: 1, vendorCode: 'V1' }]
  };

  beforeEach(() => {
    jest.resetModules();
    electron = require('electron');
    electron.ipcRenderer.invoke.mockReset();
    electron.ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'receipts:get') return sampleReceipt;
      if (channel === 'vendors:load') return [{ code: 'V1', name: 'Vendor A' }];
      return undefined;
    });
    global.alert = jest.fn();
    // stub window.open to capture written HTML
    win = { document: { write: jest.fn(), close: jest.fn() }, close: jest.fn() };
    global.window.open = jest.fn(() => win);
    // preload vendor cache to avoid extra fetch paths
    global.window.__vendorsCache = [{ code: 'V1', name: 'Vendor A' }];
    require('../receipts.js'); // registers window.__onReceiptAction
  });

  test('view action renders return details in receipt window', async () => {
    await global.window.__onReceiptAction({}, 'view', 'R1');
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('receipts:get', 'R1');
    expect(global.window.open).toHaveBeenCalled();
    const html = win.document.write.mock.calls[0][0];
    expect(html).toContain('Return Subtotal');
    expect(html).toContain('Return Total');
    expect(html).toContain('Net Total');
    expect(html).toContain('Returned 1'); // returned note shown
  });
});

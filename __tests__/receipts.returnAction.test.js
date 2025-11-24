jest.mock('electron');

const { ipcRenderer } = require('electron');

describe('return action flow', () => {
  beforeEach(() => {
    jest.resetModules();
    ipcRenderer.invoke.mockReset();
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'receipts:return') return true;
      if (channel === 'receipts:get') return { id: 'R1' };
      return undefined;
    });
    global.alert = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('editing a return triggers save and refresh', async () => {
    const receipts = require('../receipts.js');
    let hookPayload = null;
    global.window.__onReturnTestHook = (p) => { hookPayload = p; };
    // override module bindings to bypass modal and heavy logic
    global.window.__askReturnInfoOverride = jest.fn().mockResolvedValue({
      receiptId: 'R1',
      reason: 'Edit return',
      user: 'Bob',
      cashier: { name: 'Bob' },
      items: [{ name: 'Lamp', quantity: 1, price: 10, vendor: 'V1' }]
    });
    receipts.loadAll = jest.fn().mockResolvedValue();
    receipts.applyFilters = jest.fn();

    const btn = document.createElement('button');
    btn.textContent = 'Return';
    const evt = { currentTarget: btn };

    await global.window.__onReceiptAction(evt, 'return', 'R1');

    expect(global.window.__askReturnInfoOverride).toHaveBeenCalled();
    expect(hookPayload).toMatchObject({
      id: 'R1',
      reason: 'Edit return',
      user: 'Bob',
      userObj: { name: 'Bob' },
      items: [{ name: 'Lamp', quantity: 1, price: 10, vendor: 'V1' }]
    });
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Return');
  });

  test('saves updates to an existing return when user adds items', async () => {
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'receipts:return') return { ok: true };
      if (channel === 'receipts:get') return { id: 'R2' };
      return undefined;
    });
    const receipts = require('../receipts.js');
    global.window.__onReturnTestHook = jest.fn((p) => { hookPayload = p; ipcRenderer.invoke('receipts:return', p); });
    global.window.__askReturnInfoOverride = jest.fn().mockResolvedValue({
      receiptId: 'R2',
      reason: 'Add more items',
      user: 'Chris',
      cashier: { name: 'Chris' },
      items: [
        { name: 'Lamp', quantity: 1, price: 10, vendor: 'V1' },
        { name: 'Chair', quantity: 2, price: 15, vendor: 'V2' }
      ]
    });
    receipts.loadAll = jest.fn().mockResolvedValue();
    receipts.applyFilters = jest.fn();

    const btn = document.createElement('button');
    btn.textContent = 'Return';
    await global.window.__onReceiptAction({ currentTarget: btn }, 'return', 'R2');

    expect(global.window.__askReturnInfoOverride).toHaveBeenCalled();
    expect(global.window.__onReturnTestHook).toHaveBeenCalled();
    const payload = global.window.__onReturnTestHook.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: 'R2',
      reason: 'Add more items',
      user: 'Chris',
      userObj: { name: 'Chris' }
    });
    expect(payload.items).toHaveLength(2);
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('receipts:return', expect.objectContaining({ id: 'R2' }));
  });

  test('edit existing return with multi-qty items adds another item and calls return', async () => {
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'receipts:return') return { ok: true };
      if (channel === 'receipts:get') return { id: 'R3' };
      return undefined;
    });
    const receipts = require('../receipts.js');
    let captured = null;
    global.window.__onReturnTestHook = (p) => { captured = p; ipcRenderer.invoke('receipts:return', p); };
    global.window.__askReturnInfoOverride = jest.fn().mockResolvedValue({
      receiptId: 'R3',
      reason: 'Add couch',
      user: 'Dana',
      cashier: { name: 'Dana' },
      items: [
        { name: 'Lamp', quantity: 1, price: 10, vendor: 'V1' },   // already returned before
        { name: 'Couch', quantity: 2, price: 100, vendor: 'V5' }  // newly selected multi-qty item
      ]
    });
    receipts.loadAll = jest.fn().mockResolvedValue();
    receipts.applyFilters = jest.fn();

    const btn = document.createElement('button');
    btn.textContent = 'Return';
    await global.window.__onReceiptAction({ currentTarget: btn }, 'return', 'R3');

    expect(global.window.__askReturnInfoOverride).toHaveBeenCalled();
    expect(captured).toMatchObject({
      id: 'R3',
      reason: 'Add couch',
      user: 'Dana',
      userObj: { name: 'Dana' }
    });
    expect(captured.items).toHaveLength(2);
    const couch = captured.items.find(i => i.name === 'Couch');
    expect(couch).toMatchObject({ quantity: 2, price: 100, vendor: 'V5' });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('receipts:return', expect.objectContaining({ id: 'R3' }));
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Return');
  });
});

jest.mock('electron');

const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getHandler(channel) {
  return ipcMain.__handlers.get(channel);
}

describe('main receipts lifecycle handlers', () => {
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-receipts-'));
    app.getPath.mockReturnValue(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'receipts.json'), JSON.stringify([], null, 2));
    jest.isolateModules(() => { require('../main.js'); });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('add -> void -> update receipt maintains IDs', async () => {
    const add = getHandler('receipts:add');
    const get = getHandler('receipts:get');
    const voidReceipt = getHandler('receipts:void');
    const update = getHandler('receipts:update');
    expect(add && get && voidReceipt && update).toBeTruthy();

    const added = await add({}, { number: '', id: '', items: [{ name: 'Lamp', price: 10 }], datetime: '2025-01-01T00:00:00Z' });
    expect(added.id).toBeTruthy();
    expect(added.number).toBeTruthy();

    const voided = await voidReceipt({}, { id: added.id, reason: 'Test', user: 'me' });
    expect(voided.voided).toBe(true);
    expect(voided.voidInfo.reason).toBe('Test');

    const updated = await update({}, { id: added.id, total: 20 });
    expect(updated.id).toBe(added.id);
    expect(updated.total).toBe(20);
  });

  test('return receipt marks returned with items', async () => {
    const add = getHandler('receipts:add');
    const returnReceipt = getHandler('receipts:return');
    expect(add && returnReceipt).toBeTruthy();
    const added = await add({}, { number: 'R-1', items: [{ name: 'Chair', price: 50 }], datetime: '2025-01-02T00:00:00Z' });
    const ret = await returnReceipt({}, { id: added.id, reason: 'Broken', items: [{ name: 'Chair', quantity: 1, price: 50 }] });
    expect(ret.returned).toBe(true);
    expect(ret.returnInfo.reason).toBe('Broken');
  });
});

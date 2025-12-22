jest.mock('electron');

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('gift card handlers', () => {
  let tmpDir;
  let currentIpcMain;
  let currentApp;

  const getHandler = (channel) => currentIpcMain.__handlers.get(channel);

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-giftcards-'));
    const electron = require('electron');
    currentIpcMain = electron.ipcMain;
    currentApp = electron.app;
    currentApp.getPath.mockReturnValue(tmpDir);
    jest.isolateModules(() => {
      require('../main.js');
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('addBook generates cards with prefix and padding', () => {
    const addBook = getHandler('giftcards:addBook');
    const load = getHandler('giftcards:load');

    const resp = addBook({}, {
      label: 'Holiday 2025',
      prefix: 'GC-',
      start: 1,
      end: 3,
      pad: 4
    });
    expect(resp.ok).toBe(true);
    expect(resp.added).toBe(3);

    const data = load();
    const numbers = data.cards.map(c => c.number);
    expect(numbers).toEqual(['GC-0001', 'GC-0002', 'GC-0003']);
    data.cards.forEach(card => {
      expect(card.status).toBe('available');
      expect(card.balance).toBe(0);
    });
  });

  test('addBook prevents duplicate card numbers', () => {
    const addBook = getHandler('giftcards:addBook');
    addBook({}, { prefix: 'GC-', start: 1, end: 2 });
    expect(() => addBook({}, { prefix: 'GC-', start: 1, end: 2 })).toThrow(/already exist/i);
  });

  test('sell and redeem update balances with transaction history', () => {
    const addBook = getHandler('giftcards:addBook');
    const sell = getHandler('giftcards:sell');
    const redeem = getHandler('giftcards:redeem');
    const lookup = getHandler('giftcards:lookup');

    addBook({}, { prefix: 'GC-', start: 1, end: 1, pad: 4 });
    const sellResp = sell({}, {
      number: 'GC-0001',
      amount: 25,
      cashier: 'Alice',
      receiptNumber: 'R-1'
    });
    expect(sellResp.ok).toBe(true);
    expect(sellResp.card.status).toBe('active');
    expect(sellResp.card.balance).toBe(25);

    const redeemResp = redeem({}, {
      number: 'GC-0001',
      amount: 10,
      cashier: 'Alice',
      receiptNumber: 'R-2'
    });
    expect(redeemResp.ok).toBe(true);
    expect(redeemResp.card.balance).toBe(15);
    expect(redeemResp.card.status).toBe('active');

    const finalResp = redeem({}, {
      number: 'GC-0001',
      amount: 15,
      cashier: 'Alice',
      receiptNumber: 'R-3'
    });
    expect(finalResp.card.balance).toBe(0);
    expect(finalResp.card.status).toBe('redeemed');

    const lookupResp = lookup({}, { number: 'GC-0001' });
    expect(lookupResp.card.balance).toBe(0);
    const types = lookupResp.transactions.map(t => t.type);
    expect(types).toEqual(['sale', 'redeem', 'redeem']);
  });

  test('redeem throws when balance is insufficient', () => {
    const addBook = getHandler('giftcards:addBook');
    const sell = getHandler('giftcards:sell');
    const redeem = getHandler('giftcards:redeem');

    addBook({}, { prefix: 'GC-', start: 1, end: 1, pad: 4 });
    sell({}, { number: 'GC-0001', amount: 5, cashier: 'Alice' });
    expect(() => redeem({}, { number: 'GC-0001', amount: 10, cashier: 'Alice' })).toThrow(/balance is too low/i);
  });
});

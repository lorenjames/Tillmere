jest.mock('electron');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  normalizeCounts,
  drawerTotal,
  computeDrawerStatus,
  sanitizeDrawer,
} = require('../main.js');

describe('drawer helpers', () => {
  test('normalizeCounts coerces/floors and includes all denominations', () => {
    const counts = normalizeCounts({ 100: '2', 20: 3.9, 0.25: -5, extra: 10 });
    const keys = Object.keys(counts).sort((a, b) => Number(a) - Number(b));
    expect(keys).toEqual(['0.01','0.05','0.1','0.25','1','5','10','20','50','100']);
    expect(counts['100']).toBe(2);
    expect(counts['20']).toBe(3); // floored
    expect(counts['0.25']).toBe(0); // negative coerced to 0
  });

  test('drawerTotal sums denominations with cents correctly', () => {
    const total = drawerTotal({ 100: 1, 10: 2, 0.25: 4, 0.01: 3 });
    expect(total).toBeCloseTo(100 + 20 + 1 + 0.03, 2);
  });

  test('computeDrawerStatus moves through lifecycle', () => {
    expect(computeDrawerStatus({})).toBe('none');
    expect(computeDrawerStatus({ opening: {} })).toBe('opening-draft');
    expect(computeDrawerStatus({ opening: { submitted: true } })).toBe('opening-submitted');
    expect(computeDrawerStatus({ closing: {} })).toBe('closing-draft');
    expect(computeDrawerStatus({ closing: { submitted: true } })).toBe('closing-submitted');
    expect(computeDrawerStatus({ approved: { ts: 'x' } })).toBe('approved');
  });

  test('sanitizeDrawer preserves totals/status and hides internals', () => {
    const rec = sanitizeDrawer({
      date: '2024-01-01',
      opening: { cashier: 'Alice', ts: 't1', counts: { 1: 1 }, total: 1.0, submitted: true },
      closing: { cashier: 'Bob', ts: 't2', counts: { 1: 2 }, total: 2.0, submitted: true },
      approved: { by: 'manager', ts: 't3' },
      variance: 1,
    });
    expect(rec.status).toBe('approved');
    expect(rec.opening.cashier).toBe('Alice');
    expect(rec.closing.total).toBe(2.0);
    expect(rec.approved.ts).toBe('t3');
  });
});

const getHandler = (channel) => ipcMain.__handlers.get(channel);

describe('drawer lifecycle handlers', () => {
  let tmpDir;
  let currentIpcMain;
  let currentApp;
  const cashierName = 'Alice';
  const cashierPin = '1234';
  const cashierSalt = 'test-salt';
  const cashierHash = crypto.createHash('sha256').update(`${cashierSalt}:${cashierPin}`).digest('hex');
  const drawerFile = () => path.join(tmpDir, 'drawer-sessions.json');

  const getHandler = (channel) => currentIpcMain.__handlers.get(channel);

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-drawer-'));
    const electron = require('electron');
    currentIpcMain = electron.ipcMain;
    currentApp = electron.app;
    currentApp.getPath.mockReturnValue(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'cashiers.json'), JSON.stringify([{
      name: cashierName,
      pinSalt: cashierSalt,
      pinHash: cashierHash,
      active: true
    }], null, 2));
    jest.isolateModules(() => {
      require('../main.js');
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  const closingPayload = () => ({
    cashier: cashierName,
    pin: cashierPin,
    counts: { 100: 1 },
    note: 'Closing amounts',
    floatAmount: 0,
    depositAmount: 0,
    depositCounts: {},
    needChange: false
  });

  test('saveOpening and saveClosing persist counts and status', async () => {
    const saveOpening = getHandler('drawer:saveOpening');
    const saveClosing = getHandler('drawer:saveClosing');
    const openingResult = await saveOpening({}, {
      cashier: cashierName,
      pin: cashierPin,
      counts: { 100: 1 },
      note: 'Opening note'
    });
    expect(openingResult.opening.total).toBe(100);
    expect(openingResult.status).toBe('opening-submitted');

    const closingResult = await saveClosing({}, closingPayload());
    expect(closingResult.closing.total).toBe(100);
    expect(closingResult.status).toBe('closing-submitted');

    const saved = JSON.parse(fs.readFileSync(drawerFile(), 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].closing.total).toBe(100);
    expect(saved[0].status).toBe('closing-submitted');
  });

  async function prepareClosing() {
    const saveOpening = getHandler('drawer:saveOpening');
    const saveClosing = getHandler('drawer:saveClosing');
    await saveOpening({}, {
      cashier: cashierName,
      pin: cashierPin,
      counts: { 100: 1 },
      note: 'Opening note'
    });
    return saveClosing({}, closingPayload());
  }

  test('drawer:approve locks the day and prevents repeat submissions', async () => {
    await prepareClosing();
    const approve = getHandler('drawer:approve');
    const approved = await approve({}, { date: '', by: cashierName });
    expect(approved.approved).toBeDefined();
    expect(approved.approved.by).toBe(cashierName);

    const stored = JSON.parse(fs.readFileSync(drawerFile(), 'utf-8'));
    expect(stored[0].approved).toBeDefined();

    expect(() => approve({}, { date: '' })).toThrow(/already submitted/i);
  });
});

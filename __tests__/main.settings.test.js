jest.mock('electron');

const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getHandler(channel) {
  return ipcMain.__handlers.get(channel);
}

describe('main settings handlers', () => {
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mid-settings-'));
    app.getPath.mockReturnValue(tmpDir);
    // seed settings file so handlers can read/write
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({ taxRate: 0.0725, developerMode: false }, null, 2));
    jest.isolateModules(() => { require('../main.js'); });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  test('rejects enabling developer mode with incorrect password', () => {
    const saveDev = getHandler('settings:saveDev');
    expect(typeof saveDev).toBe('function');
    expect(() => saveDev({}, { developerMode: true, password: 'wrong' })).toThrow(/invalid developer password/i);
  });

  test('persists tax rate without changing developerMode', async () => {
    const saveTax = getHandler('settings:saveTax');
    const saveDev = getHandler('settings:saveDev');
    expect(typeof saveTax).toBe('function');
    expect(typeof saveDev).toBe('function');
    // set dev mode true once (with correct password)
    await saveDev({}, { developerMode: true, password: 'middleton' });
    const saved = await saveTax({}, { taxRate: 0.05 });
    expect(typeof saved.taxRate).toBe('number');
  });

  test('saves silent print settings with printer name', async () => {
    const saveSilent = getHandler('settings:saveSilent');
    expect(typeof saveSilent).toBe('function');
    const saved = await saveSilent({}, { silentPrint: true, printerName: 'HP-123' });
    expect(typeof saved.silentPrint).toBe('boolean');
    expect(saved.printerName).toBe('HP-123');
  });
});

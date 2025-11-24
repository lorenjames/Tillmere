// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;
let splashWindow;

const userDir = app.getPath('userData');
const VENDOR_FILE = path.join(userDir, 'vendors.json');
const CASHIER_FILE = path.join(userDir, 'cashiers.json');
const RECEIPTS_FILE = path.join(userDir, 'receipts.json');
const SETTINGS_FILE = path.join(userDir, 'settings.json');
const APP_CONFIG_FILE = path.join(__dirname, 'config', 'app-config.json');
const BRANDING_DIR = path.join(userDir, 'branding');

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        return data ?? fallback;
    } catch (e) {
        console.error('Failed reading', file, e);
        return fallback;
    }
}
function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error('Failed writing', file, e);
        return false;
    }
}

function readSettings() {
    const def = {
        taxRate: 0.0725,
        developerMode: false,
        backupDir: '',
        silentPrint: true,
        printerName: '',
        // Branding defaults (match existing hard-coded UI)
        bizName: "Middleton's Antiques & Uniques",
        bizAddress: '1615 S 17th St, Lincoln, NE 68502',
        bizPhone: '531-500-0135',
        logoPath: ''
    };
    try {
        const cur = readJson(SETTINGS_FILE, def);
        // Ensure defaults for missing keys without dropping extras
        return { ...def, ...(cur || {}) };
    } catch (_) { return def; }
}
function readAppConfig() {
    const def = { developerPassword: 'middleton' };
    try {
        const cur = readJson(APP_CONFIG_FILE, def);
        return { ...def, ...(cur || {}) };
    } catch (_) { return def; }
}
function saveSettings(patch) {
    try {
        const cur = readSettings();
        const next = { ...cur, ...(patch || {}) };
        writeJson(SETTINGS_FILE, next);
        return next;
    } catch (e) { console.error('Failed to save settings', e); return readSettings(); }
}

// Ensure data directory and JSON files exist on first run
function ensureDataFiles() {
    try {
        fs.mkdirSync(path.dirname(VENDOR_FILE), { recursive: true });
    } catch (_) { }
    if (!fs.existsSync(VENDOR_FILE)) writeJson(VENDOR_FILE, []);
    if (!fs.existsSync(CASHIER_FILE)) writeJson(CASHIER_FILE, []);
    if (!fs.existsSync(RECEIPTS_FILE)) writeJson(RECEIPTS_FILE, []);
    if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, { taxRate: 0.0725 });
}

// ---------- Helpers for robust receipt IDs ----------
function normId(x) { return String(x ?? '').trim(); }
function migrateReceipts(list) {
    let changed = false;
    const out = (Array.isArray(list) ? list : []).map(r => {
        const id = normId(r.id);
        const num = normId(r.number);
        const chosenNumber = num || id || `MID-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const chosenId = id || chosenNumber;
        if (r.id !== chosenId || r.number !== chosenNumber) changed = true;
        return { ...r, id: chosenId, number: chosenNumber };
    });
    return { out, changed };
}

// ---------- Vendors ----------
ipcMain.handle('vendors:load', () => readJson(VENDOR_FILE, []));
ipcMain.handle('vendors:save', (_evt, vendors) => {
    const norm = (vendors || []).map(v => ({
        name: String(v?.name || '').trim(),
        phone: String(v?.phone || '').trim(),
        code: String(v?.code || '').trim()
    }));
    writeJson(VENDOR_FILE, norm);
    return norm;
});

// ---------- Bootstrap state (vendors, cashiers, receipts) ----------
ipcMain.handle('state:bootstrap', () => {
    const vendors = readJson(VENDOR_FILE, []);
    const cashiers = readJson(CASHIER_FILE, []);
    const rawReceipts = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(rawReceipts);
    const receipts = out.slice().sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
    if (changed) writeJson(RECEIPTS_FILE, receipts);
    return { vendors, cashiers, receipts };
});

// ---------- Cashiers ----------
ipcMain.handle('cashiers:load', () => readJson(CASHIER_FILE, []));
ipcMain.handle('cashiers:save', (_evt, cashiers) => {
    const norm = (cashiers || []).map(c => ({ name: String(c?.name || '').trim() })).filter(c => c.name);
    writeJson(CASHIER_FILE, norm);
    return norm;
});

// ---------- Receipts (robust, stores void userObj) ----------
ipcMain.handle('receipts:load', () => {
    const raw = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(raw);
    if (changed) writeJson(RECEIPTS_FILE, out);
    out.sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
    return out;
});

ipcMain.handle('receipts:add', (_evt, receipt) => {
    const all = readJson(RECEIPTS_FILE, []);
    const baseNumber = normId(receipt?.number) || `MID-${Date.now()}`;
    const baseId = normId(receipt?.id) || baseNumber;
    const toSave = { ...receipt, id: baseId, number: baseNumber };
    all.push(toSave);
    const { out } = migrateReceipts(all);
    writeJson(RECEIPTS_FILE, out);
    return toSave;
});

ipcMain.handle('receipts:get', (_evt, idIn) => {
    const id = normId(idIn);
    const all = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(all);
    if (changed) writeJson(RECEIPTS_FILE, out);
    return out.find(r => normId(r.id) === id || normId(r.number) === id) || null;
});

ipcMain.handle('receipts:void', (_evt, { id: idIn, reason, user, userObj }) => {
    const id = normId(idIn);
    const all = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(all);
    const arr = changed ? out : all;

    const idx = arr.findIndex(r => normId(r.id) === id || normId(r.number) === id);
    if (idx === -1) return null;

    const now = new Date().toISOString();
    arr[idx].voided = true;
    arr[idx].voidInfo = {
        reason: String(reason || ''),
        user: String(user || 'system'),
        userObj: userObj || null,   // <-- full cashier object saved
        when: now
    };

    writeJson(RECEIPTS_FILE, arr);
    return arr[idx];
});

ipcMain.handle('receipts:return', (_evt, { id: idIn, reason, user, userObj, items }) => {
    const id = normId(idIn);
    const all = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(all);
    const arr = changed ? out : all;

    const idx = arr.findIndex(r => normId(r.id) === id || normId(r.number) === id);
    if (idx === -1) return null;
    if (arr[idx].voided) return null;

    const now = new Date().toISOString();
    arr[idx].returned = true;
    const safeItems = Array.isArray(items) ? items.map(it => ({
        name: String(it?.name || '').trim(),
        quantity: Math.max(1, parseInt(it?.quantity || 1, 10)),
        price: Number(it?.price || 0),
        vendor: String(it?.vendor || '').trim(),
        comment: String(it?.comment || '').trim()
    })) : null;

    arr[idx].returnInfo = {
        reason: String(reason || ''),
        user: String(user || 'system'),
        userObj: userObj || null,
        when: now,
        items: safeItems
    };

    writeJson(RECEIPTS_FILE, arr);
    return arr[idx];
});

ipcMain.handle('receipts:update', (_evt, updated) => {
    const all = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(all);
    const arr = changed ? out : all;

    const id = normId(updated?.id) || normId(updated?.number);
    const idx = arr.findIndex(r => normId(r.id) === id || normId(r.number) === id);
    if (idx === -1) return null;

    arr[idx] = { ...arr[idx], ...updated };
    writeJson(RECEIPTS_FILE, arr);
    return arr[idx];
});

ipcMain.handle('receipts:reindex', () => {
    const all = readJson(RECEIPTS_FILE, []);
    const { out, changed } = migrateReceipts(all);
    if (changed) writeJson(RECEIPTS_FILE, out);
    return { changed, count: out.length };
});

// Optional debug
ipcMain.handle('debug:info', () => {
    const all = readJson(RECEIPTS_FILE, []);
    return {
        receiptsPath: RECEIPTS_FILE,
        count: Array.isArray(all) ? all.length : 0,
        sampleIds: (all || []).slice(0, 5).map(r => ({ id: r.id, number: r.number }))
    };
});

// ---------- Settings ----------
ipcMain.handle('settings:load', () => readSettings());
ipcMain.handle('settings:save', (_evt, incoming) => {
    const safe = {
        taxRate: Math.max(0, Math.min(1, Number(incoming?.taxRate ?? 0.0725))),
        developerMode: !!incoming?.developerMode
    };
    const saved = saveSettings(safe);
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// Save business branding (name/address/phone) and optional logo file
ipcMain.handle('settings:saveBranding', async (_evt, incoming) => {
    const current = readSettings();

    let logoPath = String(current.logoPath || '').trim();
    try {
        const rawPath = String(incoming?.logoFilePath || '').trim();
        if (rawPath) {
            const src = rawPath;
            try { fs.mkdirSync(BRANDING_DIR, { recursive: true }); } catch (_) { }
            const ext = path.extname(src) || '.png';
            const destFsPath = path.join(BRANDING_DIR, `logo${ext.toLowerCase()}`);
            fs.copyFileSync(src, destFsPath);
            const fileUrl = encodeURI('file://' + destFsPath.replace(/\\/g, '/'));
            logoPath = fileUrl;
        }
    } catch (e) {
        console.error('Failed to copy branding logo', e);
    }

    const safe = {
        bizName: String(incoming?.bizName ?? current.bizName ?? '').trim(),
        bizAddress: String(incoming?.bizAddress ?? current.bizAddress ?? '').trim(),
        bizPhone: String(incoming?.bizPhone ?? current.bizPhone ?? '').trim(),
        logoPath
    };

    const saved = saveSettings(safe);
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// Save only tax rate
ipcMain.handle('settings:saveTax', (_evt, incoming) => {
    const current = readSettings();
    const safe = {
        taxRate: Math.max(0, Math.min(1, Number(incoming?.taxRate ?? current.taxRate ?? 0.0725))),
        developerMode: !!current.developerMode
    };
    const saved = saveSettings(safe);
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// Save only developer mode
ipcMain.handle('settings:saveDev', (_evt, incoming) => {
      const config = readAppConfig();
      const desired = !!incoming?.developerMode;
      if (desired) {
          const attempt = String(incoming?.password || '');
          const expected = String(config?.developerPassword || '');
          if (!attempt || attempt !== expected) {
              const err = new Error('Invalid developer password');
              err.code = 'INVALID_DEV_PASSWORD';
              throw err;
          }
      }
      const current = readSettings();
      const safe = {
          taxRate: Math.max(0, Math.min(1, Number(current?.taxRate ?? 0.0725))),
          developerMode: desired
      };
      const saved = saveSettings(safe);
      try {
          const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// (auth handlers removed - rollback per request)

// ---------- Silent Printing ----------
// Prints provided HTML to the default printer without showing a dialog/preview.
ipcMain.handle('print:silent', async (_evt, html) => {
    const win = new BrowserWindow({ show: false });
    try {
        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(String(html || ''));
        // Provide a base path so relative assets like ./assets/* resolve when using a data: URL
        const baseForData = 'file://' + path.join(__dirname, '/');
        await win.loadURL(dataUrl, { baseURLForDataURL: baseForData });
        return await new Promise((resolve, reject) => {
            try {
                const s = readSettings();
                const deviceName = String(s?.printerName || '').trim();
                const opts = { silent: true, printBackground: true };
                if (deviceName) opts.deviceName = deviceName;
                win.webContents.print(opts, (success, failureReason) => {
                    try { win.destroy(); } catch (_) { }
                    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); } catch (_) { }
                    if (!success) return reject(new Error(failureReason || 'Silent print failed'));
                    resolve(true);
                });
            } catch (e) {
                try { win.destroy(); } catch (_) { }
                try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); } catch (_) { }
                reject(e);
            }
        });
    } catch (e) {
        try { win.destroy(); } catch (_) { }
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); } catch (_) { }
        throw e;
    }
});

// Save only silent printing toggle
ipcMain.handle('settings:saveSilent', (_evt, incoming) => {
    const current = readSettings();
    const safe = {
        taxRate: Number(current?.taxRate ?? 0.0725),
        developerMode: !!current?.developerMode,
        backupDir: String(current?.backupDir || ''),
        silentPrint: !!incoming?.silentPrint,
        printerName: String((incoming?.printerName ?? current?.printerName) || '')
    };
    const saved = saveSettings(safe);
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// List available printers (from any existing window)
ipcMain.handle('print:listPrinters', async () => {
    try {
        const { BrowserWindow } = require('electron');
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || !win.webContents) return [];
        const wc = win.webContents;
        if (typeof wc.getPrintersAsync === 'function') {
            return await wc.getPrintersAsync();
        }
        return wc.getPrinters();
    } catch (e) {
        return [];
    }
});

// ---------- Backup/Restore Data ----------
function formatLocalDate(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function nextAvailablePath(dir, baseNameNoExt) {
    const base = path.join(dir, `${baseNameNoExt}.json`);
    if (!fs.existsSync(base)) return base;
    let i = 1;
    while (true) {
        const candidate = path.join(dir, `${baseNameNoExt}-${String(i).padStart(2, '0')}.json`);
        if (!fs.existsSync(candidate)) return candidate;
        i++;
    }
}

ipcMain.handle('data:export', async () => {
    try {
        const defaultPath = `middletons-backup-${formatLocalDate()}.json`;
        const current = readSettings();
        const { canceled, filePath } = await dialog.showSaveDialog({
            title: 'Save Backup',
            defaultPath: current?.backupDir ? path.join(current.backupDir, defaultPath) : defaultPath,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (canceled || !filePath) return { ok: false, canceled: true };

        const data = {
            vendors: readJson(VENDOR_FILE, []),
            cashiers: readJson(CASHIER_FILE, []),
            receipts: readJson(RECEIPTS_FILE, [])
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        try { saveSettings({ backupDir: path.dirname(filePath) }); } catch (_) { }
        return { ok: true, path: filePath, counts: { vendors: data.vendors.length || 0, cashiers: data.cashiers.length || 0, receipts: data.receipts.length || 0 } };
    } catch (e) {
        console.error('Export failed', e);
        return { ok: false, error: e?.message || String(e) };
    }
});

ipcMain.handle('data:import', async () => {
    try {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Import Backup',
            properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
        const file = filePaths[0];
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        const vendors = Array.isArray(parsed?.vendors) ? parsed.vendors : [];
        const cashiers = Array.isArray(parsed?.cashiers) ? parsed.cashiers : [];
        const receiptsIn = Array.isArray(parsed?.receipts) ? parsed.receipts : [];
        // normalize receipts and write
        const { out } = migrateReceipts(receiptsIn);
        writeJson(VENDOR_FILE, vendors);
        writeJson(CASHIER_FILE, cashiers);
        writeJson(RECEIPTS_FILE, out);
        return { ok: true, counts: { vendors: vendors.length, cashiers: cashiers.length, receipts: out.length } };
    } catch (e) {
        console.error('Import failed', e);
        return { ok: false, error: e?.message || String(e) };
    }
});

// ---------- Auto-backup on close ----------
function performAutoBackup() {
    try {
        const data = {
            vendors: readJson(VENDOR_FILE, []),
            cashiers: readJson(CASHIER_FILE, []),
            receipts: readJson(RECEIPTS_FILE, [])
        };
        const s = readSettings();
        let backupDir = String(s?.backupDir || '').trim();
        if (!backupDir) backupDir = path.join(userDir, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        // Overwrite same filename each time
        const latestPath = path.join(backupDir, 'middletons-backup-latest.json');
        fs.writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf-8');
        // Also write a dated snapshot using local date; do not overwrite existing files
        try {
            const baseName = `middletons-backup-${formatLocalDate()}`;
            const datedPath = nextAvailablePath(backupDir, baseName);
            fs.writeFileSync(datedPath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (_) { }
        return true;
    } catch (e) {
        console.error('Auto-backup failed', e);
        return false;
    }
}

// ---------- Window ----------
function createWindow() {
    // Splash screen (simple image + progress)
    splashWindow = new BrowserWindow({
        width: 460,
        height: 360,
        resizable: false,
        frame: false,
        show: true,
        transparent: false,
        icon: path.join(__dirname, 'assets', 'MiddletonsAppIcon.png'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    splashWindow.loadFile('splash.html');

    // Main window (hidden until ready)
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        fullscreen: false,
        backgroundColor: '#f1efea',
        icon: path.join(__dirname, 'assets', 'MiddletonsAppIcon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => {
        const MIN_SPLASH_MS = 3000; // keep splash visible for 3 seconds
        setTimeout(() => {
            try { if (splashWindow) splashWindow.close(); } catch (_) { }
            splashWindow = null;
            mainWindow.maximize();
            mainWindow.show();
        }, MIN_SPLASH_MS);
    });
    mainWindow.on('closed', () => (mainWindow = null));
}

// Create an additional sale window (no splash)
function createSaleWindow(cartId) {
    const w = new BrowserWindow({
        width: 1200,
        height: 800,
        show: true,
        fullscreen: false,
        backgroundColor: '#f1efea',
        icon: path.join(__dirname, 'assets', 'MiddletonsAppIcon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });
    try {
        const target = cartId ? `index.html?cartId=${encodeURIComponent(String(cartId))}` : 'index.html';
        w.loadFile('index.html', cartId ? { query: { cartId: String(cartId) } } : undefined);
    } catch (_) {
        // Fallback for environments that don't support the query option
        try { w.loadFile('index.html'); } catch (_) { }
    }
    try { w.maximize(); } catch (_) { }
    return w;
}
// Avoid side effects during tests where Electron may be mocked
try {
  const isTest = !!process.env.JEST_WORKER_ID;
  if (!isTest && app && typeof app.whenReady === 'function') {
    const p = app.whenReady();
    if (p && typeof p.then === 'function') {
      p.then(() => { ensureDataFiles(); createWindow(); });
    }
  }
} catch (_) { }

// Expose app version to renderers
ipcMain.handle('app:getVersion', () => {
    try { return app.getVersion(); } catch (_) { return ''; }
});

// Focus the main window on request (helps recover after hidden windows/dialogs)
ipcMain.handle('app:focus', () => {
    try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.focus(); return true; } } catch (_) { }
    return false;
});

// Open a new sale window on demand
ipcMain.handle('sale:new', () => {
    try {
        const id = `C-${Date.now()}`;
        createSaleWindow(id);
        return { cartId: id };
    } catch (e) {
        return { error: String(e?.message || e) };
    }
});

// Allow splash to request window resize to fit logo exactly
ipcMain.handle('splash:resize', (_evt, size) => {
    try {
        if (!splashWindow || splashWindow.isDestroyed()) return false;
        const w = Math.max(200, Math.floor(Number(size?.width || 0)));
        const h = Math.max(120, Math.floor(Number(size?.height || 0)));
        splashWindow.setContentSize(w, h, true);
        try { splashWindow.center(); } catch (_) { }
        return true;
    } catch (_) { return false; }
});
try {
  if (app && typeof app.on === 'function') {
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    app.on('before-quit', () => {
      try {
        // Inform renderers to clear tab persistence for next session
        BrowserWindow.getAllWindows().forEach(w => {
          try { w.webContents.send('app:prepareQuit'); } catch (_) { }
        });
      } catch (_) { }
      try { performAutoBackup(); } catch (_) { }
    });
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  }
} catch (_) { }

// Test-friendly exports of pure helpers only (no window/app side effects)
try {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = {
      migrateReceipts,
      // expose small helpers used in tests if needed later
      // formatLocalDate, nextAvailablePath
    };
  }
} catch (_) { }

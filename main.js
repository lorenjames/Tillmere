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
    const def = { taxRate: 0.0725, developerMode: false, backupDir: '' };
    try {
        const cur = readJson(SETTINGS_FILE, def);
        // Ensure defaults for missing keys without dropping extras
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
    const current = readSettings();
    const safe = {
        taxRate: Math.max(0, Math.min(1, Number(current?.taxRate ?? 0.0725))),
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

// (auth handlers removed - rollback per request)

// ---------- Backup/Restore Data ----------
ipcMain.handle('data:export', async () => {
    try {
        const defaultPath = `middletons-backup-${new Date().toISOString().slice(0,10)}.json`;
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
        try { saveSettings({ backupDir: path.dirname(filePath) }); } catch (_) {}
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
        // Also write a dated snapshot (optional, non-blocking)
        try {
            const dated = `middletons-backup-${new Date().toISOString().slice(0,10)}.json`;
            const datedPath = path.join(backupDir, dated);
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
        icon: path.join(__dirname, 'assets', 'MiddletonsAppIcon.png'),
        webPreferences: { nodeIntegration: true, contextIsolation: false }
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
app.whenReady().then(() => { ensureDataFiles(); createWindow(); });

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
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => { try { performAutoBackup(); } catch (_) {} });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

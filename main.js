// main.js
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let mainWindow;
let splashWindow;

const userDir = app.getPath('userData');
const VENDOR_FILE = path.join(userDir, 'vendors.json');
const CASHIER_FILE = path.join(userDir, 'cashiers.json');
const RECEIPTS_FILE = path.join(userDir, 'receipts.json');
const SETTINGS_FILE = path.join(userDir, 'settings.json');
const DRAWER_FILE = path.join(userDir, 'drawer-sessions.json');
const APP_CONFIG_FILE = path.join(__dirname, 'config', 'app-config.json');
const APP_RESET_TOKEN = path.join(__dirname, 'config', 'reset-token.txt');
const BRANDING_DIR = path.join(userDir, 'branding');
const DEFAULT_VENDOR_PROMOTIONS = [];
const DEFAULT_DISCOUNT_REASONS = [
    'Store Promo',
    'Vendor Promo',
    'Dolly Purrton Promo',
    'Vendor Approved',
    'Store Approved'
];
const DRAWER_DENOMS = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];
const MODE_TIMEOUT_MS = 20 * 60 * 1000;

function defaultDenominationTargets() {
    const safe = {};
    DRAWER_DENOMS.forEach(denom => { safe[String(denom)] = 0; });
    return safe;
}

function ensureNonOverlappingPromos(promos) {
    const byVendor = new Map();
    (Array.isArray(promos) ? promos : []).forEach(p => {
        const key = String(p.vendorCode || '').trim().toLowerCase();
        if (!key) return;
        if (!byVendor.has(key)) byVendor.set(key, []);
        byVendor.get(key).push(p);
    });
    const result = [];
    byVendor.forEach(list => {
        const sorted = list.slice().sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
        let lastEnd = -Infinity;
        sorted.forEach(p => {
            if (Number.isFinite(p.startTs) && Number.isFinite(p.endTs) && p.startTs > lastEnd) {
                result.push(p);
                lastEnd = p.endTs;
            }
        });
    });
    return result;
}
function normalizeVendorPromotions(list) {
    const arr = Array.isArray(list) ? list : [];
    const normalized = arr
        .map((p) => {
            const vendorCode = String(p?.vendorCode || '').trim();
            const vendorName = String(p?.vendorName || '').trim();
            const type = p?.type === 'amount' ? 'amount' : 'percent';
            const rawValue = Number(p?.value || 0);
            const value = type === 'percent'
                ? Math.max(0, Math.min(100, rawValue))
                : Math.max(0, rawValue);
            const startDate = String(p?.startDate || '').trim();
            const endDate = String(p?.endDate || '').trim();
            const startTs = Date.parse(`${startDate}T00:00:00`);
            const endTs = Date.parse(`${endDate}T23:59:59`);
            if (!vendorCode || !startDate || !endDate) return null;
            if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null;
            if (value <= 0) return null;
            const swap = startTs > endTs;
            const id = String(p?.id || `promo-${Date.now()}-${Math.floor(Math.random() * 1000)}`);
            return {
                id,
                vendorCode,
                vendorName,
                type,
                value,
                startDate: swap ? endDate : startDate,
                endDate: swap ? startDate : endDate,
                startTs: swap ? endTs : startTs,
                endTs: swap ? startTs : endTs
            };
        })
        .filter(Boolean);
    const nonOverlap = ensureNonOverlappingPromos(normalized);
    return nonOverlap.map(p => ({
        id: p.id,
        vendorCode: p.vendorCode,
        vendorName: p.vendorName,
        type: p.type,
        value: p.value,
        startDate: p.startDate,
        endDate: p.endDate
    }));
}

// ---------- Cashier PIN helpers ----------
function hashPin(pin, salt) {
    try {
        const cleanPin = String(pin || '');
        const cleanSalt = String(salt || '');
        return crypto.createHash('sha256').update(`${cleanSalt}:${cleanPin}`).digest('hex');
    } catch (_) {
        return '';
    }
}
function generateSalt() {
    try { return crypto.randomBytes(8).toString('hex'); } catch (_) { return `${Date.now()}`; }
}
function normalizeCashierRecord(c) {
    return {
        name: String(c?.name || '').trim(),
        pinHash: String(c?.pinHash || ''),
        pinSalt: String(c?.pinSalt || ''),
        active: c?.active !== false
    };
}
function sanitizeCashierForClient(c) {
    return { name: c.name, active: c.active !== false, pinSet: !!c.pinHash };
}
function findCashierByName(list, name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return null;
    return (Array.isArray(list) ? list : []).find(c => String(c?.name || '').trim().toLowerCase() === target) || null;
}
function verifyCashierPin(name, pin, listIn) {
    const list = Array.isArray(listIn) ? listIn : readJson(CASHIER_FILE, []);
    const match = findCashierByName(list, name);
    if (!match || !match.pinHash) return false;
    const salt = String(match.pinSalt || '');
    const computed = hashPin(pin, salt);
    return computed && computed === match.pinHash;
}

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
        logoPath: '',
        dailyDrawerTotal: 0,
        drawerDenominationTargets: defaultDenominationTargets(),
        discountReasons: DEFAULT_DISCOUNT_REASONS,
        vendorPromotions: DEFAULT_VENDOR_PROMOTIONS,
        developerModeExpiresAt: 0
    };
    try {
        const cur = readJson(SETTINGS_FILE, def);
        const merged = { ...def, ...(cur || {}) };
        merged.vendorPromotions = normalizeVendorPromotions(merged.vendorPromotions || []);
        merged.drawerDenominationTargets = normalizeCounts(merged.drawerDenominationTargets || {});
        return merged;
    } catch (_) { return def; }
}
function canEncryptConfig() {
    try {
        if (app && typeof app.isReady === 'function' && !app.isReady()) return false;
        return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());
    }
    catch (_) { return false; }
}
function readAppConfig() {
    const def = { developerPassword: 'middleton', managerPassword: 'middleton' };
    try {
        if (!fs.existsSync(APP_CONFIG_FILE)) return def;
        const raw = fs.readFileSync(APP_CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        const hasEnvelope = parsed && typeof parsed.encrypted === 'string';
        if (hasEnvelope) {
            if (!canEncryptConfig()) {
                console.warn('App config is encrypted but encryption is unavailable; falling back to defaults.');
                return def;
            }
            try {
                const decrypted = safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64'));
                const data = JSON.parse(decrypted);
                return { ...def, ...(data || {}) };
            } catch (e) {
                console.error('Failed to decrypt app config; falling back to defaults.', e);
                return def;
            }
        }
        return { ...def, ...(parsed || {}) };
    } catch (e) {
        console.error('Failed reading app config', e);
        return def;
    }
}
function writeAppConfig(data) {
    try {
        fs.mkdirSync(path.dirname(APP_CONFIG_FILE), { recursive: true });
        const merged = { ...data };
        if (canEncryptConfig()) {
            try {
                const payload = JSON.stringify(merged);
                const encrypted = safeStorage.encryptString(payload).toString('base64');
                fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify({ encrypted, version: 1 }, null, 2), 'utf-8');
                return true;
            } catch (e) {
                console.error('Failed to encrypt app config, writing plain JSON.', e);
            }
        }
        fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error('Failed writing app config', e);
        return false;
    }
}
function saveAppConfig(patch) {
    const current = readAppConfig();
    const next = { ...current, ...(patch || {}) };
    if (!next.managerPassword) next.managerPassword = next.developerPassword;
    writeAppConfig(next);
    return next;
}
function performStartupPasswordReset() {
    try {
        if (process.env.JEST_WORKER_ID) return null; // avoid test side effects
        const reasons = [];
        const hasFlag = !!(app?.commandLine?.hasSwitch && app.commandLine.hasSwitch('reset-passwords'));
        const envReset = ['RESET_MIDDLETONS_PASSWORDS', 'MIDDLETON_RESET_PASSWORDS'].some(k => String(process.env[k] || '') === '1');
        const tokenExists = fs.existsSync(APP_RESET_TOKEN);
        if (hasFlag) reasons.push('--reset-passwords flag');
        if (envReset) reasons.push('reset env var');
        if (tokenExists) reasons.push('reset-token file');
        if (!reasons.length) return null;
        const saved = saveAppConfig({ developerPassword: 'middleton', managerPassword: 'middleton' });
        try { if (tokenExists) fs.unlinkSync(APP_RESET_TOKEN); } catch (_) { }
        console.warn('[app-config] Passwords reset to defaults via', reasons.join(', '), '-> developer/manager:', saved.developerPassword ? '(set)' : '(empty)');
        return { reset: true, reasons };
    } catch (e) {
        console.error('Failed to perform startup password reset', e);
        return null;
    }
}
function getAppConfigStatus() {
    try {
        const exists = fs.existsSync(APP_CONFIG_FILE);
        if (!exists) return { exists: false, encrypted: false, encryptionAvailable: canEncryptConfig() };
        const raw = fs.readFileSync(APP_CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        const encrypted = !!(parsed && typeof parsed.encrypted === 'string');
        return { exists: true, encrypted, encryptionAvailable: canEncryptConfig() };
    } catch (_) {
        return { exists: false, encrypted: false, encryptionAvailable: canEncryptConfig() };
    }
}
function saveSettings(patch) {
    try {
        const cur = readSettings();
        const next = { ...cur, ...(patch || {}) };
        try {
            next.vendorPromotions = normalizeVendorPromotions(next.vendorPromotions || cur.vendorPromotions || []);
        } catch (_) {
            next.vendorPromotions = [];
        }
        next.drawerDenominationTargets = normalizeCounts(next.drawerDenominationTargets || {});
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
    if (!fs.existsSync(SETTINGS_FILE)) {
        writeJson(SETTINGS_FILE, {
            taxRate: 0.0725,
            dailyDrawerTotal: 0,
            drawerDenominationTargets: defaultDenominationTargets()
        });
    }
    if (!fs.existsSync(DRAWER_FILE)) writeJson(DRAWER_FILE, []);
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

// ---------- Drawer helpers ----------
function todayYmd() { return formatLocalDate(new Date()); }
function normalizeCounts(counts) {
    const safe = {};
    DRAWER_DENOMS.forEach(d => {
        const key = String(d);
        const raw = counts && (counts[key] ?? counts[d]);
        const num = Math.max(0, Math.floor(Number(raw || 0)));
        safe[key] = Number.isFinite(num) ? num : 0;
    });
    return safe;
}
function drawerTotal(counts) {
    let total = 0;
    Object.keys(counts || {}).forEach(k => {
        const denom = Number(k);
        const qty = Math.max(0, Math.floor(Number((counts || {})[k] || 0)));
        if (Number.isFinite(denom) && Number.isFinite(qty)) {
            total += denom * qty;
        }
    });
    return Math.round(total * 100) / 100;
}
function readDrawerList() {
    return (readJson(DRAWER_FILE, []) || []).map(d => ({
        date: String(d?.date || '').trim(),
        denominations: Array.isArray(d?.denominations) && d.denominations.length ? d.denominations : DRAWER_DENOMS,
        opening: d?.opening || null,
        closing: d?.closing || null,
        approved: d?.approved || null,
        status: d?.status || 'none',
        variance: Number(d?.variance || 0)
    }));
}
function writeDrawerList(list) { writeJson(DRAWER_FILE, list); }
function computeDrawerStatus(rec) {
    if (rec?.approved) return 'approved';
    if (rec?.closing && rec.closing.submitted) return 'closing-submitted';
    if (rec?.closing) return 'closing-draft';
    if (rec?.opening && rec.opening.submitted) return 'opening-submitted';
    if (rec?.opening) return 'opening-draft';
    return 'none';
}
function sanitizeDrawer(rec) {
    const opening = rec?.opening ? {
        cashier: rec.opening.cashier || '',
        ts: rec.opening.ts || '',
        counts: rec.opening.counts || {},
        total: Number(rec.opening.total || 0),
        submitted: !!rec.opening.submitted,
        note: String(rec.opening.note || '')
    } : null;
    const closing = rec?.closing ? {
        cashier: rec.closing.cashier || '',
        ts: rec.closing.ts || '',
        counts: rec.closing.counts || {},
        total: Number(rec.closing.total || 0),
        submitted: !!rec.closing.submitted,
        note: String(rec.closing.note || ''),
        floatAmount: Number(rec.closing.floatAmount || 0),
        deposit: rec.closing.deposit ? {
            amount: Number(rec.closing.deposit.amount || 0),
            counts: normalizeCounts(rec.closing.deposit.counts || {}),
            number: String(rec.closing.deposit.number || '')
        } : null,
        needChange: !!rec.closing.needChange
    } : null;
    const variance = Number(rec?.variance || 0);
    return {
        date: rec?.date || todayYmd(),
        denominations: rec?.denominations || DRAWER_DENOMS,
        opening,
        closing,
        approved: rec?.approved || null,
        status: computeDrawerStatus({ ...rec, opening, closing }),
        variance
    };
}
function upsertDrawer(date, patch) {
    const ymd = String(date || todayYmd()).trim() || todayYmd();
    const list = readDrawerList();
    let rec = list.find(r => String(r.date || '').trim() === ymd);
    if (!rec) {
        rec = { date: ymd, denominations: DRAWER_DENOMS, opening: null, closing: null, approved: null, status: 'none', variance: 0 };
        list.push(rec);
    }
    const next = { ...rec, ...(patch || {}) };
    next.status = computeDrawerStatus(next);
    next.variance = Number(next?.closing?.total || 0) - Number(next?.opening?.total || 0);
    const idx = list.findIndex(r => String(r.date || '').trim() === ymd);
    list[idx] = next;
    writeDrawerList(list);
    return sanitizeDrawer(next);
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
ipcMain.handle('cashiers:load', () => {
    const raw = readJson(CASHIER_FILE, []);
    const norm = (Array.isArray(raw) ? raw : []).map(normalizeCashierRecord).filter(c => c.name);
    return norm.map(sanitizeCashierForClient);
});
ipcMain.handle('cashiers:save', (_evt, cashiers) => {
    const incoming = (cashiers || [])
        .map(c => ({ name: String(c?.name || '').trim(), active: c?.active !== false }))
        .filter(c => c.name);
    const existing = (readJson(CASHIER_FILE, []) || []).map(normalizeCashierRecord);
    const merged = [];
    const seen = new Set();
    incoming.forEach(c => {
        const key = c.name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const match = findCashierByName(existing, c.name);
        if (match) {
            merged.push({ ...match, name: c.name, active: c.active });
        } else {
            merged.push({ name: c.name, active: c.active, pinHash: '', pinSalt: '' });
        }
    });
    writeJson(CASHIER_FILE, merged);
    return merged.map(sanitizeCashierForClient);
});
ipcMain.handle('cashiers:setPin', (_evt, { name, pin, currentPin }) => {
    const cashierName = String(name || '').trim();
    const newPin = String(pin || '').trim();
    const curPin = String(currentPin || '').trim();
    if (!cashierName || !newPin) {
        const err = new Error('Cashier name and new PIN are required.');
        err.code = 'INVALID_PIN';
        throw err;
    }
    const list = (readJson(CASHIER_FILE, []) || []).map(normalizeCashierRecord);
    const match = findCashierByName(list, cashierName);
    if (!match) {
        const err = new Error('Cashier not found.');
        err.code = 'CASHIER_NOT_FOUND';
        throw err;
    }
    if (match.pinHash) {
        const ok = verifyCashierPin(cashierName, curPin, list);
        if (!ok) {
            const err = new Error('Current PIN is incorrect.');
            err.code = 'INVALID_CURRENT_PIN';
            throw err;
        }
    }
    const salt = generateSalt();
    const pinHash = hashPin(newPin, salt);
    const updated = list.map(c => c.name.toLowerCase() === cashierName.toLowerCase() ? { ...c, pinSalt: salt, pinHash } : c);
    writeJson(CASHIER_FILE, updated);
    return { ok: true, pinSet: true };
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

// ---------- Cash Drawer ----------
ipcMain.handle('drawer:get', (_evt, date) => {
    const ymd = String(date || todayYmd()).trim() || todayYmd();
    const list = readDrawerList();
    const rec = list.find(r => String(r.date || '').trim() === ymd);
    if (rec) return sanitizeDrawer(rec);
    const created = upsertDrawer(ymd, {});
    return sanitizeDrawer(created);
});

ipcMain.handle('drawer:saveOpening', (_evt, payload) => {
    const ymd = String(payload?.date || todayYmd()).trim() || todayYmd();
    const cashier = String(payload?.cashier || '').trim();
    const pin = String(payload?.pin || '').trim();
    const counts = normalizeCounts(payload?.counts || {});
    const note = String(payload?.note || '').trim();
    if (!cashier) { const err = new Error('Cashier is required.'); err.code = 'NO_CASHIER'; throw err; }
    if (!pin) { const err = new Error('PIN is required.'); err.code = 'NO_PIN'; throw err; }
    const list = (readJson(CASHIER_FILE, []) || []).map(normalizeCashierRecord);
    if (!findCashierByName(list, cashier)) { const err = new Error('Cashier not found.'); err.code = 'CASHIER_NOT_FOUND'; throw err; }
    if (!verifyCashierPin(cashier, pin, list)) { const err = new Error('Invalid PIN.'); err.code = 'INVALID_PIN'; throw err; }
    const currentList = readDrawerList();
    const current = currentList.find(r => String(r.date || '').trim() === ymd) || null;
    if (current && current.approved) { const err = new Error('Drawer already approved for this day.'); err.code = 'APPROVED'; throw err; }
    const total = drawerTotal(counts);
    return upsertDrawer(ymd, {
        opening: {
            cashier,
            ts: new Date().toISOString(),
            counts,
            total,
            submitted: true,
            note
        }
    });
});

ipcMain.handle('drawer:saveClosing', (_evt, payload) => {
    const ymd = String(payload?.date || todayYmd()).trim() || todayYmd();
    const cashier = String(payload?.cashier || '').trim();
    const pin = String(payload?.pin || '').trim();
    const counts = normalizeCounts(payload?.counts || {});
    const note = String(payload?.note || '').trim();
    const floatAmount = Math.round(Math.max(0, Number(payload?.floatAmount || 0)) * 100) / 100;
    const depositAmount = Math.round(Math.max(0, Number(payload?.depositAmount || 0)) * 100) / 100;
    const depositCounts = normalizeCounts(payload?.depositCounts || {});
    const depositNumber = String(payload?.depositNumber || '').trim();
    const needChange = !!payload?.needChange;
    if (!cashier) { const err = new Error('Cashier is required.'); err.code = 'NO_CASHIER'; throw err; }
    if (!pin) { const err = new Error('PIN is required.'); err.code = 'NO_PIN'; throw err; }
    const list = (readJson(CASHIER_FILE, []) || []).map(normalizeCashierRecord);
    if (!findCashierByName(list, cashier)) { const err = new Error('Cashier not found.'); err.code = 'CASHIER_NOT_FOUND'; throw err; }
    if (!verifyCashierPin(cashier, pin, list)) { const err = new Error('Invalid PIN.'); err.code = 'INVALID_PIN'; throw err; }
    const currentList = readDrawerList();
    const current = currentList.find(r => String(r.date || '').trim() === ymd) || null;
    if (current && current.approved) { const err = new Error('Drawer already approved for this day.'); err.code = 'APPROVED'; throw err; }
    if (!current || !current.opening) { const err = new Error('Opening must be completed before closing.'); err.code = 'NO_OPENING'; throw err; }
    const total = drawerTotal(counts);
    return upsertDrawer(ymd, {
        closing: {
            cashier,
            ts: new Date().toISOString(),
            counts,
            total,
            submitted: true,
            note,
            floatAmount,
            deposit: {
                amount: depositAmount,
                counts: depositCounts,
                number: depositNumber
            },
            needChange
        }
    });
});

ipcMain.handle('drawer:approve', (_evt, payload) => {
    const ymd = String(payload?.date || todayYmd()).trim() || todayYmd();
    const list = readDrawerList();
    const current = list.find(r => String(r.date || '').trim() === ymd);
    if (!current || !current.closing) {
        const err = new Error('Closing counts must be submitted before approval.');
        err.code = 'NO_CLOSING';
        throw err;
    }
    if (current.approved) {
        const err = new Error('Daily totals already submitted for this day.');
        err.code = 'APPROVED';
        throw err;
    }
    const approvedBy = String(payload?.by || current.closing.cashier || 'Cashier');
    return upsertDrawer(ymd, {
        approved: {
            by: approvedBy,
            ts: new Date().toISOString()
        }
    });
});

ipcMain.handle('drawer:list', (_evt, payload) => {
    const start = String(payload?.startDate || '').trim();
    const end = String(payload?.endDate || '').trim();
    const list = readDrawerList().map(sanitizeDrawer);
    const filtered = list.filter(rec => {
        const d = String(rec?.date || '');
        const afterStart = start ? d >= start : true;
        const beforeEnd = end ? d <= end : true;
        return afterStart && beforeEnd;
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return filtered;
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

ipcMain.handle('settings:saveDrawerTotal', (_evt, incoming) => {
    const current = readSettings();
    const target = Math.max(0, Number(incoming?.dailyDrawerTotal ?? current.dailyDrawerTotal ?? 0));
    const saved = saveSettings({ dailyDrawerTotal: target });
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

ipcMain.handle('settings:saveDenominationTargets', (_evt, incoming) => {
    const targets = normalizeCounts(incoming?.denominationTargets || incoming?.drawerDenominationTargets || {});
    const drawerTargetTotal = drawerTotal(targets);
    const saved = saveSettings({ drawerDenominationTargets: targets, dailyDrawerTotal: drawerTargetTotal });
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// Save discount reasons (array of strings)
ipcMain.handle('settings:saveDiscountReasons', (_evt, incoming) => {
    const list = Array.isArray(incoming?.discountReasons) ? incoming.discountReasons : [];
    const cleaned = list
        .map(r => String(r || '').trim())
        .filter(r => r)
        .filter((r, idx, arr) => arr.findIndex(x => x.toLowerCase() === r.toLowerCase()) === idx);
    const fallback = DEFAULT_DISCOUNT_REASONS;
    const safe = { discountReasons: cleaned.length ? cleaned : fallback };
    const saved = saveSettings(safe);
    try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach(w => {
            try { w.webContents.send('settings:changed', saved); } catch (_) { }
        });
    } catch (_) { }
    return saved;
});

// Save vendor promotions (vendor-level discounts with date windows)
ipcMain.handle('settings:saveVendorPromotions', (_evt, incoming) => {
    const list = normalizeVendorPromotions(incoming?.vendorPromotions ?? incoming);
    const safe = { vendorPromotions: list };
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
      const modeTimeout = desired ? Math.max(Number(incoming?.expiresAt || 0), Date.now() + MODE_TIMEOUT_MS) : 0;
      const safe = {
          taxRate: Math.max(0, Math.min(1, Number(current?.taxRate ?? 0.0725))),
          developerMode: desired,
          developerModeExpiresAt: modeTimeout
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

ipcMain.handle('settings:disableDev', () => {
    const current = readSettings();
    const safe = {
        taxRate: Math.max(0, Math.min(1, Number(current?.taxRate ?? 0.0725))),
        developerMode: false,
        developerModeExpiresAt: 0
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

// Manager Mode: simple password check (UI-only gate on settings page)
ipcMain.handle('settings:enableManagerMode', (_evt, incoming) => {
    const config = readAppConfig();
    const attempt = String(incoming?.password || '');
    const expected = String(config?.managerPassword || config?.developerPassword || '');
    if (!attempt || !expected || attempt !== expected) {
        const err = new Error('Invalid manager password');
        err.code = 'INVALID_MANAGER_PASSWORD';
        throw err;
    }
    return { ok: true };
});

// Change developer/manager passwords + surface encryption status
ipcMain.handle('appConfig:status', () => getAppConfigStatus());
ipcMain.handle('appConfig:changePasswords', (_evt, incoming) => {
    const current = readAppConfig();
    const desired = incoming || {};
    const patch = {};
    const updated = [];

    const newDev = String(desired.newDeveloper || '').trim();
    const newMgr = String(desired.newManager || '').trim();
    const curDev = String(desired.currentDeveloper || '').trim();
    const curMgr = String(desired.currentManager || '').trim();

    if (newDev) {
        const expected = String(current.developerPassword || '');
        if (!curDev || curDev !== expected) {
            const err = new Error('Current developer password is incorrect.');
            err.code = 'INVALID_CURRENT_DEV_PASSWORD';
            throw err;
        }
        patch.developerPassword = newDev;
        // Keep manager in sync if it previously matched dev and manager wasn't explicitly provided
        if (!current.managerPassword || current.managerPassword === expected) {
            patch.managerPassword = current.managerPassword === expected ? newDev : current.managerPassword;
        }
        updated.push('developer');
    }
    if (newMgr) {
        const expectedMgr = String(current.managerPassword || current.developerPassword || '');
        if (!curMgr || curMgr !== expectedMgr) {
            const err = new Error('Current manager password is incorrect.');
            err.code = 'INVALID_CURRENT_MANAGER_PASSWORD';
            throw err;
        }
        patch.managerPassword = newMgr;
        updated.push('manager');
    }
    if (!updated.length) {
        return { ok: false, updated: [], message: 'No password changes provided.' };
    }
    const saved = saveAppConfig(patch);
    return { ok: true, updated, encryption: getAppConfigStatus(), config: { hasManagerPassword: !!saved.managerPassword } };
});

// Apply optional startup reset (flag/env/token)
try { performStartupPasswordReset(); } catch (_) { }

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
      // drawer helpers
      normalizeCounts,
      drawerTotal,
      computeDrawerStatus,
      sanitizeDrawer,
      // expose small helpers used in tests if needed later
      // formatLocalDate, nextAvailablePath
    };
  }
} catch (_) { }

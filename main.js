// main.js
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let mainWindow;
let splashWindow;
let calendarWindow;

const userDir = app.getPath('userData');
const VENDOR_FILE = path.join(userDir, 'vendors.json');
const CASHIER_FILE = path.join(userDir, 'cashiers.json');
const RECEIPTS_FILE = path.join(userDir, 'receipts.json');
const SETTINGS_FILE = path.join(userDir, 'settings.json');
const DRAWER_FILE = path.join(userDir, 'drawer-sessions.json');
const APP_CONFIG_FILE = path.join(__dirname, 'config', 'app-config.json');
const APP_RESET_TOKEN = path.join(__dirname, 'config', 'reset-token.txt');
const BRANDING_DIR = path.join(userDir, 'branding');
const ACTIVITY_LOG_DIR = path.join(userDir, 'logs');
const ACTIVITY_LOG_FILE = path.join(ACTIVITY_LOG_DIR, 'activity.log');
const AUTO_BACKUP_DIR = path.join(userDir, 'backups');
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
const RECEIPTS_DB_FILE = path.join(userDir, 'receipts.sqlite3');
const SCHEDULE_FILE = path.join(userDir, 'schedule.json');
const DEFAULT_STORE_HOURS = { start: '10:00', end: '18:00' };
const DEFAULT_BASE_SHIFTS = [
    { name: 'Morning Shift', start: '10:00', end: '14:00' },
    { name: 'Afternoon Shift', start: '14:00', end: '18:00' }
];
const DEFAULT_BASE_HOURS = {
    '0': { start: '13:00', end: '16:00' }, // Sunday
    '3': { start: '11:00', end: '17:30' }, // Wednesday
    '4': { start: '11:00', end: '17:30' }, // Thursday
    '5': { start: '11:00', end: '17:30' }, // Friday
    '6': { start: '10:00', end: '16:00' }  // Saturday
};
let BetterSqlite3 = null;
try {
    BetterSqlite3 = require('better-sqlite3');
} catch (err) {
    console.warn('[storage] better-sqlite3 not available; receipts will use JSON storage fallback.', err?.message || err);
}

function defaultDenominationTargets() {
    const safe = {};
    DRAWER_DENOMS.forEach(denom => { safe[String(denom)] = 0; });
    return safe;
}

function ensureActivityLogDir() {
    try {
        fs.mkdirSync(ACTIVITY_LOG_DIR, { recursive: true });
    } catch (_) { }
}

function ensureDirectory(dir) {
    if (!dir) return '';
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (_) { }
    return dir;
}

function truncateString(str, maxLen = 120) {
    const clean = String(str || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    return `${clean.slice(0, maxLen)}…`;
}

function formatLogValue(value, depth = 0, seen = new Set()) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${truncateString(value)}"`;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (value instanceof Error) return `"${truncateString(value.message)}"`;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
        if (depth >= 2) return '[Array]';
        const items = value.slice(0, 5).map(v => formatLogValue(v, depth + 1, seen));
        return `[${items.join(',')}${value.length > 5 ? ',…' : ''}]`;
    }
    if (typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        if (depth >= 2) return '[Object]';
        seen.add(value);
        const keys = Object.keys(value).filter(k => typeof value[k] !== 'function');
        const entries = keys.slice(0, 4).map(k => `${k}:${formatLogValue(value[k], depth + 1, seen)}`);
        if (keys.length > 4) entries.push('…');
        seen.delete(value);
        return `{${entries.join(',')}}`;
    }
    return `[${typeof value}]`;
}

function logActivity(type, meta = {}) {
    try {
        ensureActivityLogDir();
        const timestamp = new Date().toISOString();
        const entries = [];
        const payload = meta?.payload;
        Object.entries(meta || {}).forEach(([key, value]) => {
            if (key === 'payload' || value === undefined || value === null) return;
            entries.push(`${key}=${formatLogValue(value)}`);
        });
        if (payload !== undefined && payload !== null) {
            entries.push(`payload=${formatLogValue(payload)}`);
        }
        const entry = `${timestamp} [${type}] ${entries.join(' ')}${os.EOL}`;
        fs.appendFileSync(ACTIVITY_LOG_FILE, entry, 'utf-8');
    } catch (error) {
        console.error('[activity-log] failed to write log', error);
    }
}

const _originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
    const wrapped = async (event, ...args) => {
        logActivity('ipc:request', {
            channel,
            argsCount: args.length,
            payload: args.length ? args[0] : null
        });
        try {
            const result = await listener(event, ...args);
            logActivity('ipc:response', { channel, success: true });
            return result;
        } catch (error) {
            logActivity('ipc:response', {
                channel,
                success: false,
                error: String(error?.message || error)
            });
            throw error;
        }
    };
    const registered = _originalIpcHandle(channel, wrapped);
    if (ipcMain.__handlers && typeof ipcMain.__handlers.set === 'function') {
        try {
            ipcMain.__handlers.set(channel, listener);
        } catch (_) { }
    }
    return registered;
};

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

function sanitizeTimeString(value, fallback = '') {
    const candidate = String(value || '').trim();
    const match = /^(\d{2}):(\d{2})$/.exec(candidate);
    if (!match) return fallback;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
function normalizeStoreHours(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        start: sanitizeTimeString(source.start, DEFAULT_STORE_HOURS.start),
        end: sanitizeTimeString(source.end, DEFAULT_STORE_HOURS.end)
    };
}
function normalizeBaseShifts(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const normalized = arr.map((shift, index) => {
        const source = shift && typeof shift === 'object' ? shift : {};
        const name = String(source.name || `Shift ${index + 1}`).trim();
        const start = sanitizeTimeString(source.start, DEFAULT_STORE_HOURS.start);
        const end = sanitizeTimeString(source.end, DEFAULT_STORE_HOURS.end);
        if (!name || !start || !end) return null;
        return { name, start, end };
    }).filter(Boolean);
    if (normalized.length) return normalized;
    return DEFAULT_BASE_SHIFTS.map(shift => ({ ...shift }));
}
function normalizeSpecialHours(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const cleaned = arr.map(entry => {
        const source = entry && typeof entry === 'object' ? entry : {};
        const date = String(source.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const start = sanitizeTimeString(source.start, '');
        const end = sanitizeTimeString(source.end, '');
        if (!start || !end) return null;
        return {
            date,
            start,
            end,
            label: String(source.label || '').trim()
        };
    }).filter(Boolean);
    cleaned.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return cleaned;
}
function normalizeBaseHours(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    const result = {};
    if (source) {
        Object.entries(source).forEach(([key, value]) => {
            const day = String(key || '').trim();
            if (!/^[0-6]$/.test(day)) return;
            const start = sanitizeTimeString(value?.start, '');
            const end = sanitizeTimeString(value?.end, '');
            if (!start || !end) return;
            result[day] = { start, end };
        });
    }
    if (Object.keys(result).length) return result;
    if (source) return {};
    const clone = {};
    Object.entries(DEFAULT_BASE_HOURS).forEach(([key, val]) => {
        clone[key] = { start: val.start, end: val.end };
    });
    return clone;
}
function normalizeAssignments(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const result = {};
    Object.entries(raw).forEach(([date, shifts]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '').trim())) return;
        if (!shifts || typeof shifts !== 'object') return;
        const day = {};
        Object.entries(shifts).forEach(([shiftName, cashier]) => {
            const cleanShift = String(shiftName || '').trim();
            const cleanCashier = String(cashier || '').trim();
            if (!cleanShift || !cleanCashier) return;
            day[cleanShift] = cleanCashier;
        });
        if (Object.keys(day).length) result[date] = day;
    });
    return result;
}
function normalizeSchedule(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        storeHours: normalizeStoreHours(source.storeHours),
        baseShifts: normalizeBaseShifts(source.baseShifts),
        specialHours: normalizeSpecialHours(source.specialHours),
        baseHours: normalizeBaseHours(source.baseHours),
        assignments: normalizeAssignments(source.assignments)
    };
}
function readScheduleData() {
    const raw = readJson(SCHEDULE_FILE, null);
    return normalizeSchedule(raw);
}
function saveScheduleData(patch) {
    const current = readScheduleData();
    const source = patch && typeof patch === 'object' ? patch : {};
    const next = {
        storeHours: Object.prototype.hasOwnProperty.call(source, 'storeHours')
            ? normalizeStoreHours(source.storeHours)
            : current.storeHours,
        baseShifts: Object.prototype.hasOwnProperty.call(source, 'baseShifts')
            ? normalizeBaseShifts(source.baseShifts)
            : current.baseShifts,
        specialHours: Object.prototype.hasOwnProperty.call(source, 'specialHours')
            ? normalizeSpecialHours(source.specialHours)
            : current.specialHours,
        baseHours: Object.prototype.hasOwnProperty.call(source, 'baseHours')
            ? normalizeBaseHours(source.baseHours)
            : current.baseHours,
        assignments: Object.prototype.hasOwnProperty.call(source, 'assignments')
            ? normalizeAssignments(source.assignments)
            : current.assignments
    };
    writeJson(SCHEDULE_FILE, next);
    return next;
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

function safeJsonString(value, fallback = 'null') {
    if (value === undefined) return fallback;
    try {
        return JSON.stringify(value);
    } catch (_) {
        return fallback;
    }
}
function safeParseJson(value, fallback = null) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}
function normalizeNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
}
function sanitizeReturnItems(items) {
    if (!Array.isArray(items)) return null;
    return items.map(it => ({
        name: String(it?.name || '').trim(),
        quantity: Math.max(1, parseInt(it?.quantity ?? it?.qty ?? 1, 10)),
        price: Number(it?.price || 0),
        vendor: String(it?.vendor || '').trim(),
        comment: String(it?.comment || '').trim()
    }));
}
function buildDbRecord(receipt, opts = {}) {
    const now = opts.now || new Date().toISOString();
    const createdAt = opts.createdAt || receipt.createdAt || now;
    const updatedAt = opts.updatedAt || now;
    return {
        id: String(receipt.id || '').trim(),
        number: String(receipt.number || '').trim(),
        datetime: receipt.datetime || '',
        displayDate: String(receipt.displayDate || '').trim(),
        cashier: String(receipt.cashier || '').trim(),
        payment: String(receipt.payment || '').trim(),
        subtotal: normalizeNumber(receipt.subtotal),
        tax: normalizeNumber(receipt.tax),
        total: normalizeNumber(receipt.total),
        taxRate: normalizeNumber(receipt.taxRate),
        taxExempt: receipt.taxExempt ? 1 : 0,
        taxExemptId: String(receipt.taxExemptId || '').trim(),
        taxExemptName: String(receipt.taxExemptName || '').trim(),
        items: safeJsonString(Array.isArray(receipt.items) ? receipt.items : [], '[]'),
        voided: receipt.voided ? 1 : 0,
        voidInfo: safeJsonString(receipt.voidInfo, 'null'),
        returned: receipt.returned ? 1 : 0,
        returnInfo: safeJsonString(receipt.returnInfo, 'null'),
        backdated: receipt.backdated ? 1 : 0,
        createdAt,
        updatedAt
    };
}
function mapDbRow(row) {
    if (!row) return null;
    const items = safeParseJson(row.items, []);
    return {
        id: row.id || '',
        number: row.number || '',
        datetime: row.datetime || '',
        displayDate: row.displayDate || '',
        cashier: row.cashier || '',
        payment: row.payment || '',
        subtotal: normalizeNumber(row.subtotal),
        tax: normalizeNumber(row.tax),
        total: normalizeNumber(row.total),
        taxRate: normalizeNumber(row.taxRate),
        taxExempt: !!row.taxExempt,
        taxExemptId: row.taxExemptId || '',
        taxExemptName: row.taxExemptName || '',
        items: Array.isArray(items) ? items : [],
        voided: !!row.voided,
        voidInfo: safeParseJson(row.voidInfo),
        returned: !!row.returned,
        returnInfo: safeParseJson(row.returnInfo),
        backdated: !!row.backdated,
        createdAt: row.createdAt || '',
        updatedAt: row.updatedAt || ''
    };
}
function createSqliteReceiptsStore() {
    if (!BetterSqlite3) throw new Error('SQLite storage unavailable');
    fs.mkdirSync(path.dirname(RECEIPTS_DB_FILE), { recursive: true });
    const db = new BetterSqlite3(RECEIPTS_DB_FILE);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS receipts (
            id TEXT PRIMARY KEY,
            number TEXT NOT NULL,
            datetime TEXT,
            displayDate TEXT,
            cashier TEXT,
            payment TEXT,
            subtotal REAL DEFAULT 0,
            tax REAL DEFAULT 0,
            total REAL DEFAULT 0,
            taxRate REAL DEFAULT 0,
            taxExempt INTEGER DEFAULT 0,
            taxExemptId TEXT,
            taxExemptName TEXT,
            items TEXT,
            voided INTEGER DEFAULT 0,
            voidInfo TEXT,
            returned INTEGER DEFAULT 0,
            returnInfo TEXT,
            backdated INTEGER DEFAULT 0,
            createdAt TEXT,
            updatedAt TEXT
        );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_datetime ON receipts(datetime);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_cashier ON receipts(cashier);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_receipts_payment ON receipts(payment);');
    const columns = [
        'id', 'number', 'datetime', 'displayDate', 'cashier', 'payment',
        'subtotal', 'tax', 'total', 'taxRate', 'taxExempt',
        'taxExemptId', 'taxExemptName', 'items', 'voided',
        'voidInfo', 'returned', 'returnInfo', 'backdated', 'createdAt', 'updatedAt'
    ];
    const insertSql = `INSERT OR REPLACE INTO receipts (${columns.join(',')}) VALUES (${columns.map(c => '@' + c).join(',')});`;
    const updateSql = `UPDATE receipts SET ${columns.map(c => `${c} = @${c}`).join(',')} WHERE id = @oldId;`;
    const insertStmt = db.prepare(insertSql);
    const updateStmt = db.prepare(updateSql);
    const selectAllStmt = db.prepare('SELECT * FROM receipts ORDER BY COALESCE(datetime, \'\') DESC, COALESCE(createdAt, \'\') DESC, id DESC;');
    const selectOneStmt = db.prepare('SELECT * FROM receipts WHERE id = @needle OR number = @needle LIMIT 1;');
    const countStmt = db.prepare('SELECT COUNT(1) as count FROM receipts;');
    const deleteAllStmt = db.prepare('DELETE FROM receipts;');
    const voidStmt = db.prepare('UPDATE receipts SET voided = @voided, voidInfo = @voidInfo, updatedAt = @updatedAt WHERE id = @id;');
    const returnStmt = db.prepare('UPDATE receipts SET returned = @returned, returnInfo = @returnInfo, updatedAt = @updatedAt WHERE id = @id;');
    function importLegacyReceipts() {
        if (!fs.existsSync(RECEIPTS_FILE)) return;
        const raw = readJson(RECEIPTS_FILE, []);
        if (!Array.isArray(raw) || !raw.length) return;
        const { count } = countStmt.get();
        if (count > 0) return;
        const { out } = migrateReceipts(raw);
        if (!out.length) return;
        const now = new Date().toISOString();
        const rows = out.map(r => buildDbRecord(r, { now, createdAt: r.createdAt || now }));
        const importer = db.transaction(batch => {
            batch.forEach(row => insertStmt.run(row));
        });
        importer(rows);
    }
    importLegacyReceipts();
    return {
        type: 'sqlite',
        path: RECEIPTS_DB_FILE,
        list() {
            return selectAllStmt.all().map(mapDbRow);
        },
        get(id) {
            const needle = normId(id);
            if (!needle) return null;
            return mapDbRow(selectOneStmt.get({ needle }));
        },
        add(payload) {
            const { out } = migrateReceipts([payload]);
            const receipt = out[0];
            if (!receipt) return null;
            const now = new Date().toISOString();
            const record = buildDbRecord(receipt, { now, createdAt: now, updatedAt: now });
            insertStmt.run(record);
            return mapDbRow(selectOneStmt.get({ needle: receipt.id }));
        },
        update(payload) {
            const key = normId(payload?.id || payload?.number);
            if (!key) return null;
            const existing = this.get(key);
            if (!existing) return null;
            const newId = normId(payload?.id) || existing.id;
            const newNumber = normId(payload?.number) || existing.number;
            const merged = { ...existing, ...payload, id: newId, number: newNumber };
            const now = new Date().toISOString();
            const record = buildDbRecord(merged, { now, createdAt: existing.createdAt || now });
            updateStmt.run({ ...record, oldId: existing.id });
            return mapDbRow(selectOneStmt.get({ needle: record.id }));
        },
        markVoid(payload) {
            const key = normId(payload?.id);
            if (!key) return null;
            const existing = this.get(key);
            if (!existing) return null;
            const voidInfo = {
                reason: String(payload?.reason || '').trim(),
                user: String(payload?.user || 'system'),
                userObj: payload?.userObj || null,
                when: new Date().toISOString()
            };
            const now = new Date().toISOString();
            voidStmt.run({ id: existing.id, voided: 1, voidInfo: safeJsonString(voidInfo, 'null'), updatedAt: now });
            return this.get(existing.id);
        },
        markReturn(payload) {
            const key = normId(payload?.id);
            if (!key) return null;
            const existing = this.get(key);
            if (!existing || existing.voided) return null;
            const info = {
                reason: String(payload?.reason || '').trim(),
                user: String(payload?.user || 'system'),
                userObj: payload?.userObj || null,
                when: new Date().toISOString(),
                items: sanitizeReturnItems(payload?.items)
            };
            const now = new Date().toISOString();
            returnStmt.run({ id: existing.id, returned: 1, returnInfo: safeJsonString(info, 'null'), updatedAt: now });
            return this.get(existing.id);
        },
        reindex() {
            const rawRows = db.prepare('SELECT * FROM receipts ORDER BY COALESCE(createdAt, \'\') ASC, id ASC;').all();
            const receipts = rawRows.map(mapDbRow);
            const { out, changed } = migrateReceipts(receipts);
            if (!changed) return { changed: false, count: receipts.length };
            const now = new Date().toISOString();
            const payloads = out.map((r, idx) => ({
                record: buildDbRecord(r, { now, createdAt: receipts[idx]?.createdAt || now }),
                oldId: rawRows[idx]?.id
            }));
            const updater = db.transaction(rows => {
                rows.forEach(r => updateStmt.run({ ...r.record, oldId: r.oldId }));
            });
            updater(payloads);
            return { changed: true, count: out.length };
        },
        replaceAll(receipts) {
            const { out } = migrateReceipts(receipts);
            const now = new Date().toISOString();
            const rows = out.map(r => buildDbRecord(r, { now, createdAt: r.createdAt || now }));
            const worker = db.transaction(batch => {
                deleteAllStmt.run();
                batch.forEach(row => insertStmt.run(row));
            });
            worker(rows);
            return out;
        }
    };
}
function createJsonReceiptsStore() {
    function readAll() {
        const raw = readJson(RECEIPTS_FILE, []);
        const { out, changed } = migrateReceipts(raw);
        if (changed) writeJson(RECEIPTS_FILE, out);
        return out;
    }
    function writeAll(list) {
        writeJson(RECEIPTS_FILE, list);
    }
    return {
        type: 'json',
        path: RECEIPTS_FILE,
        list() {
            const all = readAll();
            return all.slice().sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
        },
        get(id) {
            const needle = normId(id);
            if (!needle) return null;
            return readAll().find(r => normId(r.id) === needle || normId(r.number) === needle) || null;
        },
        add(payload) {
            const { out } = migrateReceipts([payload]);
            const receipt = out[0];
            if (!receipt) return null;
            const all = readAll();
            all.push(receipt);
            const { out: refreshed } = migrateReceipts(all);
            writeAll(refreshed);
            return receipt;
        },
        update(payload) {
            const needle = normId(payload?.id || payload?.number);
            if (!needle) return null;
            const all = readAll();
            const idx = all.findIndex(r => normId(r.id) === needle || normId(r.number) === needle);
            if (idx === -1) return null;
            const existing = all[idx];
            const newId = normId(payload?.id) || existing.id;
            const newNumber = normId(payload?.number) || existing.number;
            const merged = { ...existing, ...payload, id: newId, number: newNumber };
            all[idx] = merged;
            const { out } = migrateReceipts(all);
            writeAll(out);
            return merged;
        },
        markVoid(payload) {
            const needle = normId(payload?.id);
            if (!needle) return null;
            const all = readAll();
            const idx = all.findIndex(r => normId(r.id) === needle || normId(r.number) === needle);
            if (idx === -1) return null;
            const now = new Date().toISOString();
            all[idx].voided = true;
            all[idx].voidInfo = {
                reason: String(payload?.reason || '').trim(),
                user: String(payload?.user || 'system'),
                userObj: payload?.userObj || null,
                when: now
            };
            writeAll(all);
            return all[idx];
        },
        markReturn(payload) {
            const needle = normId(payload?.id);
            if (!needle) return null;
            const all = readAll();
            const idx = all.findIndex(r => normId(r.id) === needle || normId(r.number) === needle);
            if (idx === -1 || all[idx].voided) return null;
            const now = new Date().toISOString();
            all[idx].returned = true;
            all[idx].returnInfo = {
                reason: String(payload?.reason || '').trim(),
                user: String(payload?.user || 'system'),
                userObj: payload?.userObj || null,
                when: now,
                items: sanitizeReturnItems(payload?.items)
            };
            writeAll(all);
            return all[idx];
        },
        reindex() {
            const all = readAll();
            const { out, changed } = migrateReceipts(all);
            if (changed) writeAll(out);
            return { changed, count: out.length };
        },
        replaceAll(list) {
            const { out } = migrateReceipts(list);
            writeAll(out);
            return out;
        }
    };
}
function buildReceiptsStore() {
    if (BetterSqlite3) {
        try {
            return createSqliteReceiptsStore();
        } catch (error) {
            console.error('[storage] Failed to initialize SQLite receipts store, falling back to JSON.', error?.message || error);
        }
    }
    return createJsonReceiptsStore();
}
const receiptsStore = buildReceiptsStore();
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
        code: String(v?.code || '').trim(),
        email: String(v?.email || '').trim()
    }));
    writeJson(VENDOR_FILE, norm);
    return norm;
});

ipcMain.handle('schedule:load', () => readScheduleData());
ipcMain.handle('schedule:save', (_evt, patch) => saveScheduleData(patch));

// ---------- Bootstrap state (vendors, cashiers, receipts) ----------
ipcMain.handle('state:bootstrap', () => {
    const vendors = readJson(VENDOR_FILE, []);
    const cashiers = readJson(CASHIER_FILE, []);
    const receipts = receiptsStore.list();
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
ipcMain.handle('cashiers:resetPin', (_evt, { name }) => {
    const cashierName = String(name || '').trim();
    if (!cashierName) {
        const err = new Error('Cashier name is required.');
        err.code = 'INVALID_INPUT';
        throw err;
    }
    const currentSettings = readSettings();
    if (!currentSettings.developerMode) {
        const err = new Error('Developer Mode must be enabled to reset PINs.');
        err.code = 'DEV_MODE_REQUIRED';
        logActivity('developer:cashier-reset', { name: cashierName, success: false, reason: 'developer-mode-required' });
        throw err;
    }
    const list = (readJson(CASHIER_FILE, []) || []).map(normalizeCashierRecord);
    const match = findCashierByName(list, cashierName);
    if (!match) {
        const err = new Error('Cashier not found.');
        err.code = 'CASHIER_NOT_FOUND';
        throw err;
    }
    if (!match.pinHash) {
        logActivity('developer:cashier-reset', { name: cashierName, success: true, reason: 'no-pin' });
        return { ok: true, pinSet: false };
    }
    const updated = list.map(c => c.name.toLowerCase() === cashierName.toLowerCase() ? { ...c, pinSalt: '', pinHash: '' } : c);
    writeJson(CASHIER_FILE, updated);
    logActivity('developer:cashier-reset', { name: cashierName, success: true, reason: 'cleared' });
    return { ok: true, pinSet: false };
});

// ---------- Receipts (robust, stores void userObj) ----------
ipcMain.handle('receipts:load', () => receiptsStore.list());

ipcMain.handle('receipts:add', (_evt, receipt) => {
    const saved = receiptsStore.add(receipt || {});
    if (!saved) {
        const err = new Error('Invalid receipt payload.');
        err.code = 'INVALID_RECEIPT';
        throw err;
    }
    logActivity('sale', {
        cashier: String(saved?.cashier || receipt?.cashier || 'unknown'),
        receiptId: saved?.id,
        timestamp: String(saved?.datetime || new Date().toISOString())
    });
    return saved;
});

ipcMain.handle('receipts:get', (_evt, idIn) => {
    const id = normId(idIn);
    if (!id) return null;
    return receiptsStore.get(id);
});

ipcMain.handle('receipts:void', (_evt, { id: idIn, reason, user, userObj }) => {
    const response = receiptsStore.markVoid({ id: idIn, reason, user, userObj });
    if (!response) return null;
    const now = response.voidInfo?.when || new Date().toISOString();
    logActivity('sale:void', {
        cashier: String(response?.voidInfo?.user || user || 'system'),
        receiptId: response?.id,
        timestamp: now,
        reason: String(reason || '')
    });
    return response;
});

ipcMain.handle('receipts:return', (_evt, { id: idIn, reason, user, userObj, items }) => {
    const response = receiptsStore.markReturn({ id: idIn, reason, user, userObj, items });
    if (!response) return null;
    const now = response.returnInfo?.when || new Date().toISOString();
    logActivity('sale:return', {
        cashier: String(response?.returnInfo?.user || user || 'system'),
        receiptId: response?.id,
        timestamp: now,
        reason: String(reason || '')
    });
    return response;
});

ipcMain.handle('receipts:update', (_evt, updated) => {
    const response = receiptsStore.update(updated || {});
    if (!response) return null;
    logActivity('sale:update', {
        cashier: String(response?.cashier || updated?.cashier || 'unknown'),
        receiptId: response?.id,
        timestamp: new Date().toISOString(),
        changes: updated ? Object.keys(updated).join(',') : ''
    });
    return response;
});

ipcMain.handle('receipts:reindex', () => receiptsStore.reindex());

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
    const list = receiptsStore.list();
    return {
        storageType: receiptsStore.type,
        storagePath: receiptsStore.path,
        count: list.length,
        sampleIds: list.slice(0, 5).map(r => ({ id: r.id, number: r.number }))
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
    let modeTimeout = 0;
    try {
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
        modeTimeout = desired ? Math.max(Number(incoming?.expiresAt || 0), Date.now() + MODE_TIMEOUT_MS) : 0;
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
        logActivity('developer:mode', { action: desired ? 'enable' : 'disable', success: true, expiresAt: modeTimeout });
        return saved;
    } catch (error) {
        logActivity('developer:mode', { action: desired ? 'enable' : 'disable', success: false, error: String(error?.message || error) });
        throw error;
    }
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
    logActivity('developer:mode', { action: 'disable', success: true });
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
        logActivity('manager:mode', { action: 'enable', success: false, error: String(err.message) });
        throw err;
    }
    logActivity('manager:mode', { action: 'enable', success: true });
    return { ok: true };
});

// Change developer/manager passwords + surface encryption status
ipcMain.handle('appConfig:status', () => getAppConfigStatus());
ipcMain.handle('appConfig:changePasswords', (_evt, incoming) => {
    const current = readAppConfig();
    const desired = incoming || {};
    const patch = {};
    const updated = [];
    try {
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
            logActivity('security:password-change', { success: false, message: 'No password changes provided.' });
            return { ok: false, updated: [], message: 'No password changes provided.' };
        }
        const saved = saveAppConfig(patch);
        logActivity('security:password-change', { success: true, updated });
        return { ok: true, updated, encryption: getAppConfigStatus(), config: { hasManagerPassword: !!saved.managerPassword } };
    } catch (error) {
        logActivity('security:password-change', { success: false, error: String(error?.message || error) });
        throw error;
    }
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
function resolveBackupDir(requested) {
    const candidate = String(requested || '').trim();
    if (candidate) {
        ensureDirectory(candidate);
        return candidate;
    }
    return ensureDirectory(AUTO_BACKUP_DIR);
}
function formatLocalDate(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
ipcMain.handle('data:export', async () => {
    try {
        const defaultName = `middletons-backup-${formatLocalDate()}.json`;
        const current = readSettings();
        const backupDir = resolveBackupDir(current?.backupDir);
        const { canceled, filePath } = await dialog.showSaveDialog({
            title: 'Save Backup',
            defaultPath: path.join(backupDir, defaultName),
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });
        if (canceled || !filePath) return { ok: false, canceled: true };

        const receipts = receiptsStore.list();
        const data = {
            vendors: readJson(VENDOR_FILE, []),
            cashiers: readJson(CASHIER_FILE, []),
            receipts
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        try { saveSettings({ backupDir: path.dirname(filePath) }); } catch (_) { }
        return {
            ok: true,
            path: filePath,
            counts: {
                vendors: data.vendors.length || 0,
                cashiers: data.cashiers.length || 0,
                receipts: receipts.length
            }
        };
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
        const imported = receiptsStore.replaceAll(receiptsIn);
        writeJson(VENDOR_FILE, vendors);
        writeJson(CASHIER_FILE, cashiers);
        return { ok: true, counts: { vendors: vendors.length, cashiers: cashiers.length, receipts: imported.length } };
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
            receipts: receiptsStore.list()
        };
        const backupDir = ensureDirectory(AUTO_BACKUP_DIR);
        // Overwrite same filename each time
        const latestPath = path.join(backupDir, 'middletons-backup-latest.json');
        fs.writeFileSync(latestPath, JSON.stringify(data, null, 2), 'utf-8');
        // Also write a dated snapshot for the current day (overwrites same-day files)
        try {
            const datedPath = path.join(backupDir, `middletons-backup-${formatLocalDate()}.json`);
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
    logActivity('app:event', { event: 'window:main-created' });
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
    logActivity('app:event', { event: 'window:sale-created', cartId: cartId || null });
    return w;
}

function createCalendarWindow(payload = {}) {
    if (calendarWindow && !calendarWindow.isDestroyed()) {
        calendarWindow.close();
        calendarWindow = null;
    }
    const query = {};
    if (Number.isFinite(payload.month)) {
        query.month = String(Math.max(0, Math.min(11, payload.month)));
    }
    if (Number.isFinite(payload.year)) {
        query.year = String(payload.year);
    }
    calendarWindow = new BrowserWindow({
        width: 940,
        height: 1200,
        show: false,
        backgroundColor: '#ffffff',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false
        }
    });
    calendarWindow.removeMenu();
    calendarWindow.once('ready-to-show', () => { try { calendarWindow?.show(); } catch (_) { } });
    calendarWindow.on('closed', () => { calendarWindow = null; });
    calendarWindow.loadFile('calendar.html', { query: query });
    calendarWindow.webContents.once('did-finish-load', () => {
        try {
            calendarWindow?.webContents.send('calendar:data', payload);
        } catch (_) { }
    });
    return calendarWindow;
}

ipcMain.handle('calendar:open', (_evt, payload = {}) => {
    try {
        createCalendarWindow(payload);
        return { ok: true };
    } catch (error) {
        console.error('Failed to open calendar window', error);
        return { ok: false, error: String(error) };
    }
});

ipcMain.handle('calendar:print', () => {
    if (!calendarWindow || calendarWindow.isDestroyed()) {
        return { ok: false, error: 'Calendar window is not open.' };
    }
    calendarWindow.webContents.print({ silent: false, printBackground: true });
    return { ok: true };
});
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
      // formatLocalDate
    };
  }
} catch (_) { }

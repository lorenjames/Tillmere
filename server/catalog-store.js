const crypto = require('crypto');
const { getPool } = require('./db');
const { validateDeveloperPassword } = require('./app-config');
const { readVendors, readCashiers, readSettings, writeVendors, writeCashiers, writeSettings } = require('./storage');

const DRAWER_DENOMS = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];

function parseData(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return null; }
    }
    return null;
}

function normalizeVendor(raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    return {
        code: String(v.code || '').trim(),
        name: String(v.name || '').trim(),
        phone: String(v.phone || '').trim(),
        email: String(v.email || '').trim()
    };
}

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

function normalizeTaxExemptOrgs(list) {
    const incoming = Array.isArray(list) ? list : [];
    const cleaned = [];
    const seen = new Set();
    incoming.forEach((org) => {
        const name = String(org?.name || '').trim();
        const id = String(org?.id || org?.taxId || '').trim();
        if (!name || !id) return;
        const key = `${name.toLowerCase()}|${id.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        cleaned.push({ name, id });
    });
    return cleaned.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
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

function verifyCashierPin(name, pin, listIn) {
    const list = Array.isArray(listIn) ? listIn : readCashiers().map(normalizeCashierRecord);
    const match = findCashierByName(list, name);
    if (!match || !match.pinHash) return false;
    const salt = String(match.pinSalt || '');
    const computed = hashPin(pin, salt);
    return computed && computed === match.pinHash;
}

function hashRecord(record) {
    return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function vendorToRow(vendor) {
    return {
        code: vendor.code,
        name: vendor.name,
        phone: vendor.phone,
        email: vendor.email,
        active: 1,
        importKey: hashRecord(vendor),
        data: JSON.stringify(vendor)
    };
}

function cashierToRow(cashier) {
    const record = normalizeCashierRecord(cashier);
    return {
        name: record.name,
        active: record.active !== false ? 1 : 0,
        pinHash: record.pinHash,
        pinSalt: record.pinSalt,
        importKey: hashRecord(record),
        data: JSON.stringify(record)
    };
}

function createError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

async function listVendors() {
    const pool = getPool();
    if (!pool) return readVendors();
    const [rows] = await pool.query('SELECT data FROM vendors ORDER BY name ASC, code ASC;');
    return (rows || []).map(r => parseData(r.data)).filter(Boolean);
}

async function createVendor(vendor) {
    const safe = normalizeVendor(vendor);
    if (!safe.code) throw createError(400, 'Vendor code is required.');
    if (!safe.name) throw createError(400, 'Vendor name is required.');
    const pool = getPool();
    if (!pool) {
        const list = readVendors();
        const exists = (Array.isArray(list) ? list : []).some(
            v => String(v?.code || '').trim().toLowerCase() === safe.code.toLowerCase()
        );
        if (exists) throw createError(409, 'Vendor code must be unique.');
        const next = Array.isArray(list) ? list.slice() : [];
        next.push(safe);
        writeVendors(next);
        return safe;
    }
    try {
        await pool.query(
            'INSERT INTO vendors (code, name, phone, email, active, importKey, data) VALUES (:code, :name, :phone, :email, :active, :importKey, :data);',
            vendorToRow(safe)
        );
        return safe;
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
            throw createError(409, 'Vendor code must be unique.');
        }
        throw error;
    }
}

async function updateVendor(previousCode, vendor) {
    const safe = normalizeVendor(vendor);
    const target = String(previousCode || '').trim();
    if (!target) throw createError(400, 'Previous vendor code is required.');
    if (!safe.code) throw createError(400, 'Vendor code is required.');
    if (!safe.name) throw createError(400, 'Vendor name is required.');
    const pool = getPool();
    if (!pool) {
        const list = readVendors();
        const safeList = Array.isArray(list) ? list.slice() : [];
        const idx = safeList.findIndex(
            v => String(v?.code || '').trim().toLowerCase() === target.toLowerCase()
        );
        if (idx < 0) throw createError(404, 'Vendor not found.');
        const conflict = safeList.some(
            (v, i) => i !== idx && String(v?.code || '').trim().toLowerCase() === safe.code.toLowerCase()
        );
        if (conflict) throw createError(409, 'Vendor code must be unique.');
        safeList[idx] = safe;
        writeVendors(safeList);
        return safe;
    }
    try {
        const [result] = await pool.query(
            'UPDATE vendors SET code = :code, name = :name, phone = :phone, email = :email, active = :active, importKey = :importKey, data = :data WHERE LOWER(code) = LOWER(:previousCode) LIMIT 1;',
            { ...vendorToRow(safe), previousCode: target }
        );
        const affected = Number(result?.affectedRows || 0);
        if (!affected) throw createError(404, 'Vendor not found.');
        return safe;
    } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') {
            throw createError(409, 'Vendor code must be unique.');
        }
        throw error;
    }
}

async function deleteVendor(code) {
    const target = String(code || '').trim();
    if (!target) throw createError(400, 'Vendor code is required.');
    const pool = getPool();
    if (!pool) {
        const list = readVendors();
        const safeList = Array.isArray(list) ? list.slice() : [];
        const next = safeList.filter(
            v => String(v?.code || '').trim().toLowerCase() !== target.toLowerCase()
        );
        if (next.length === safeList.length) throw createError(404, 'Vendor not found.');
        writeVendors(next);
        return true;
    }
    const [result] = await pool.query(
        'DELETE FROM vendors WHERE LOWER(code) = LOWER(:code) LIMIT 1;',
        { code: target }
    );
    const affected = Number(result?.affectedRows || 0);
    if (!affected) throw createError(404, 'Vendor not found.');
    return true;
}

async function listCashiers() {
    const pool = getPool();
    if (!pool) return readCashiers().map(normalizeCashierRecord).filter(c => c.name).map(sanitizeCashierForClient);
    const [rows] = await pool.query('SELECT data FROM cashiers ORDER BY name ASC;');
    return (rows || [])
        .map(r => normalizeCashierRecord(parseData(r.data)))
        .filter(c => c.name)
        .map(sanitizeCashierForClient);
}

async function saveCashiers(cashiers) {
    const incoming = (cashiers || [])
        .map(c => ({ name: String(c?.name || '').trim(), active: c?.active !== false }))
        .filter(c => c.name);
    const unique = [];
    const seen = new Set();
    incoming.forEach(c => {
        const key = c.name.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(c);
    });
    const pool = getPool();
    if (!pool) {
        const existing = (readCashiers() || []).map(normalizeCashierRecord);
        const merged = unique.map(c => {
            const match = findCashierByName(existing, c.name);
            if (match) return { ...match, name: c.name, active: c.active };
            return { name: c.name, active: c.active, pinHash: '', pinSalt: '' };
        });
        writeCashiers(merged);
        return merged.map(sanitizeCashierForClient);
    }
    const [rows] = await pool.query('SELECT data FROM cashiers;');
    const existing = (rows || [])
        .map(r => normalizeCashierRecord(parseData(r.data)))
        .filter(c => c.name);
    const merged = unique.map(c => {
        const match = findCashierByName(existing, c.name);
        if (match) return { ...match, name: c.name, active: c.active };
        return { name: c.name, active: c.active, pinHash: '', pinSalt: '' };
    });
    for (const cashier of merged) {
        await pool.query(
            `INSERT INTO cashiers (name, active, pinHash, pinSalt, importKey, data)
             VALUES (:name, :active, :pinHash, :pinSalt, :importKey, :data)
             ON DUPLICATE KEY UPDATE
               active = VALUES(active),
               pinHash = VALUES(pinHash),
               pinSalt = VALUES(pinSalt),
               importKey = VALUES(importKey),
               data = VALUES(data);`,
            cashierToRow(cashier)
        );
    }
    if (!merged.length) {
        await pool.query('DELETE FROM cashiers;');
    } else {
        const placeholders = merged.map((_, i) => `:name${i}`).join(', ');
        const params = {};
        merged.forEach((c, i) => { params[`name${i}`] = c.name; });
        await pool.query(`DELETE FROM cashiers WHERE name NOT IN (${placeholders});`, params);
    }
    return merged.map(sanitizeCashierForClient);
}

async function setCashierPin(name, pin, currentPin) {
    const cashierName = String(name || '').trim();
    const newPin = String(pin || '').trim();
    const curPin = String(currentPin || '').trim();
    if (!cashierName || !newPin) throw createError(400, 'Cashier name and new PIN are required.');
    const pool = getPool();
    if (!pool) {
        const list = (readCashiers() || []).map(normalizeCashierRecord);
        const match = findCashierByName(list, cashierName);
        if (!match) throw createError(404, 'Cashier not found.');
        if (match.pinHash) {
            const ok = verifyCashierPin(cashierName, curPin, list);
            if (!ok) throw createError(409, 'Current PIN is incorrect.');
        }
        const salt = generateSalt();
        const pinHash = hashPin(newPin, salt);
        const updated = list.map(c => c.name.toLowerCase() === cashierName.toLowerCase()
            ? { ...c, pinSalt: salt, pinHash }
            : c);
        writeCashiers(updated);
        return { ok: true, pinSet: true };
    }
    const [rows] = await pool.query(
        'SELECT name, active, pinHash, pinSalt, data FROM cashiers WHERE LOWER(name) = LOWER(:name) LIMIT 1;',
        { name: cashierName }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw createError(404, 'Cashier not found.');
    const parsed = parseData(row.data) || {
        name: row.name,
        active: row.active !== 0,
        pinHash: row.pinHash || '',
        pinSalt: row.pinSalt || ''
    };
    const record = normalizeCashierRecord(parsed);
    if (record.pinHash) {
        const ok = verifyCashierPin(cashierName, curPin, [record]);
        if (!ok) throw createError(409, 'Current PIN is incorrect.');
    }
    const salt = generateSalt();
    const pinHash = hashPin(newPin, salt);
    const updated = { ...record, pinSalt: salt, pinHash };
    await pool.query(
        'UPDATE cashiers SET pinHash = :pinHash, pinSalt = :pinSalt, importKey = :importKey, data = :data WHERE LOWER(name) = LOWER(:name) LIMIT 1;',
        { pinHash, pinSalt: salt, importKey: hashRecord(updated), data: JSON.stringify(updated), name: cashierName }
    );
    return { ok: true, pinSet: true };
}

async function resetCashierPin(name) {
    const cashierName = String(name || '').trim();
    if (!cashierName) throw createError(400, 'Cashier name is required.');
    const currentSettings = await loadSettings();
    if (!currentSettings.developerMode) throw createError(403, 'Developer Mode must be enabled to reset PINs.');
    const pool = getPool();
    if (!pool) {
        const list = (readCashiers() || []).map(normalizeCashierRecord);
        const match = findCashierByName(list, cashierName);
        if (!match) throw createError(404, 'Cashier not found.');
        const updated = list.map(c => c.name.toLowerCase() === cashierName.toLowerCase()
            ? { ...c, pinHash: '', pinSalt: '' }
            : c);
        writeCashiers(updated);
        return { ok: true };
    }
    const [rows] = await pool.query(
        'SELECT name, active, pinHash, pinSalt, data FROM cashiers WHERE LOWER(name) = LOWER(:name) LIMIT 1;',
        { name: cashierName }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw createError(404, 'Cashier not found.');
    const parsed = parseData(row.data) || {
        name: row.name,
        active: row.active !== 0,
        pinHash: row.pinHash || '',
        pinSalt: row.pinSalt || ''
    };
    const record = normalizeCashierRecord(parsed);
    const updated = { ...record, pinHash: '', pinSalt: '' };
    await pool.query(
        'UPDATE cashiers SET pinHash = "", pinSalt = "", importKey = :importKey, data = :data WHERE LOWER(name) = LOWER(:name) LIMIT 1;',
        { importKey: hashRecord(updated), data: JSON.stringify(updated), name: cashierName }
    );
    return { ok: true };
}

async function loadSettings() {
    const pool = getPool();
    if (!pool) return readSettings();
    const [rows] = await pool.query('SELECT data FROM settings WHERE id = 1 LIMIT 1;');
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? (parseData(row.data) || {}) : readSettings();
}

async function saveSettingsPatch(patch) {
    const current = await loadSettings();
    const next = { ...current, ...(patch || {}) };
    try {
        next.vendorPromotions = normalizeVendorPromotions(next.vendorPromotions || current.vendorPromotions || []);
    } catch (_) {
        next.vendorPromotions = [];
    }
    next.drawerDenominationTargets = normalizeCounts(next.drawerDenominationTargets || current.drawerDenominationTargets || {});
    next.taxExemptOrgs = normalizeTaxExemptOrgs(next.taxExemptOrgs || current.taxExemptOrgs || []);
    const pool = getPool();
    if (!pool) {
        writeSettings(next);
        return next;
    }
    await pool.query(
        'INSERT INTO settings (id, data, updatedAt) VALUES (1, :data, NOW()) ON DUPLICATE KEY UPDATE data = VALUES(data), updatedAt = NOW();',
        { data: JSON.stringify(next) }
    );
    return next;
}

function clampRate(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
}

async function saveTaxSettings(rate) {
    return saveSettingsPatch({ taxRate: clampRate(rate) });
}

async function saveGiftCardSurcharge(rate) {
    return saveSettingsPatch({ giftCardSurchargeRate: clampRate(rate) });
}

async function saveSilentSettings(payload) {
    return saveSettingsPatch({
        silentPrint: !!payload?.silentPrint,
        printerName: String(payload?.printerName || ''),
        greyscalePrint: !!payload?.greyscalePrint
    });
}

async function saveBrandingSettings(payload) {
    const current = await loadSettings();
    const hasLogoPath = Object.prototype.hasOwnProperty.call(payload || {}, 'logoPath');
    const hasLogoFilePath = Object.prototype.hasOwnProperty.call(payload || {}, 'logoFilePath');
    const logoPath = hasLogoPath
        ? String(payload?.logoPath || '')
        : hasLogoFilePath
            ? String(payload?.logoFilePath || '')
            : String(current?.logoPath || '');
    return saveSettingsPatch({
        bizName: String(payload?.bizName ?? current?.bizName ?? '').trim(),
        bizAddress: String(payload?.bizAddress ?? current?.bizAddress ?? '').trim(),
        bizPhone: String(payload?.bizPhone ?? current?.bizPhone ?? '').trim(),
        logoPath
    });
}

async function saveDiscountReasons(reasons) {
    const list = Array.isArray(reasons) ? reasons : [];
    const cleaned = list.map(r => String(r || '').trim()).filter(Boolean);
    return saveSettingsPatch({ discountReasons: cleaned });
}

async function saveDenominationTargets(targets) {
    const normalized = normalizeCounts(targets || {});
    return saveSettingsPatch({ drawerDenominationTargets: normalized });
}

async function saveTaxExemptOrgs(orgs) {
    return saveSettingsPatch({ taxExemptOrgs: normalizeTaxExemptOrgs(orgs || []) });
}

async function saveVendorPromotions(promos) {
    return saveSettingsPatch({ vendorPromotions: normalizeVendorPromotions(promos || []) });
}

async function saveDeveloperMode(payload) {
    const enabled = !!payload?.developerMode;
    if (enabled) {
        const ok = validateDeveloperPassword(payload?.password || '');
        if (!ok) throw createError(403, 'Invalid developer password.');
    }
    const expiresAt = enabled ? Number(payload?.expiresAt || Date.now()) : 0;
    return saveSettingsPatch({
        developerMode: enabled,
        developerModeExpiresAt: enabled ? expiresAt : 0
    });
}

module.exports = {
    listVendors,
    createVendor,
    updateVendor,
    deleteVendor,
    listCashiers,
    saveCashiers,
    setCashierPin,
    resetCashierPin,
    loadSettings,
    saveSettingsPatch,
    saveTaxSettings,
    saveGiftCardSurcharge,
    saveSilentSettings,
    saveBrandingSettings,
    saveDiscountReasons,
    saveDenominationTargets,
    saveTaxExemptOrgs,
    saveVendorPromotions,
    saveDeveloperMode
};

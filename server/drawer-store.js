const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');
const { resolveDataDir, readCashiers } = require('./storage');

const DRAWER_DENOMS = [100, 50, 20, 10, 5, 1, 0.25, 0.1, 0.05, 0.01];

function drawerFile() {
    return path.join(resolveDataDir(), 'drawer-sessions.json');
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        return data ?? fallback;
    } catch (_) {
        return fallback;
    }
}

function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (_) {
        return false;
    }
}

function formatLocalDate(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function todayYmd() {
    return formatLocalDate(new Date());
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
    return (readJson(drawerFile(), []) || []).map(d => ({
        date: String(d?.date || '').trim(),
        denominations: Array.isArray(d?.denominations) && d.denominations.length ? d.denominations : DRAWER_DENOMS,
        opening: d?.opening || null,
        closing: d?.closing || null,
        approved: d?.approved || null,
        status: d?.status || 'none',
        variance: Number(d?.variance || 0)
    }));
}

function writeDrawerList(list) {
    writeJson(drawerFile(), list);
}

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

function normalizeCashierRecord(c) {
    return {
        name: String(c?.name || '').trim(),
        pinHash: String(c?.pinHash || ''),
        pinSalt: String(c?.pinSalt || ''),
        active: c?.active !== false
    };
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

async function loadCashierRecord(name) {
    const cashierName = String(name || '').trim();
    if (!cashierName) return null;
    const pool = getPool();
    if (!pool) {
        const list = (readCashiers() || []).map(normalizeCashierRecord);
        return findCashierByName(list, cashierName);
    }
    const [rows] = await pool.query(
        'SELECT name, active, pinHash, pinSalt, data FROM cashiers WHERE LOWER(name) = LOWER(:name) LIMIT 1;',
        { name: cashierName }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    let parsed = null;
    try {
        parsed = row.data ? JSON.parse(row.data) : null;
    } catch (_) {
        parsed = null;
    }
    const candidate = parsed && typeof parsed === 'object' ? parsed : row;
    return normalizeCashierRecord(candidate);
}

async function verifyCashierPin(name, pin) {
    const record = await loadCashierRecord(name);
    if (!record || !record.pinHash) return false;
    const computed = hashPin(pin, record.pinSalt || '');
    return computed && computed === record.pinHash;
}

function createError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

async function getDrawer(date) {
    const ymd = String(date || todayYmd()).trim() || todayYmd();
    const list = readDrawerList();
    const rec = list.find(r => String(r.date || '').trim() === ymd);
    if (rec) return sanitizeDrawer(rec);
    const created = upsertDrawer(ymd, {});
    return sanitizeDrawer(created);
}

async function saveOpening(payload) {
    const ymd = String(payload?.date || todayYmd()).trim() || todayYmd();
    const cashier = String(payload?.cashier || '').trim();
    const pin = String(payload?.pin || '').trim();
    const counts = normalizeCounts(payload?.counts || {});
    const note = String(payload?.note || '').trim();
    if (!cashier) throw createError(400, 'Cashier is required.');
    if (!pin) throw createError(400, 'PIN is required.');
    const cashierRecord = await loadCashierRecord(cashier);
    if (!cashierRecord) throw createError(404, 'Cashier not found.');
    const ok = await verifyCashierPin(cashier, pin);
    if (!ok) throw createError(403, 'Invalid PIN.');
    const currentList = readDrawerList();
    const current = currentList.find(r => String(r.date || '').trim() === ymd) || null;
    if (current && current.approved) throw createError(409, 'Drawer already approved for this day.');
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
}

async function saveClosing(payload) {
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
    if (!cashier) throw createError(400, 'Cashier is required.');
    if (!pin) throw createError(400, 'PIN is required.');
    const cashierRecord = await loadCashierRecord(cashier);
    if (!cashierRecord) throw createError(404, 'Cashier not found.');
    const ok = await verifyCashierPin(cashier, pin);
    if (!ok) throw createError(403, 'Invalid PIN.');
    const currentList = readDrawerList();
    const current = currentList.find(r => String(r.date || '').trim() === ymd) || null;
    if (current && current.approved) throw createError(409, 'Drawer already approved for this day.');
    if (!current || !current.opening) throw createError(409, 'Opening must be completed before closing.');
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
}

async function approveDrawer(payload) {
    const ymd = String(payload?.date || todayYmd()).trim() || todayYmd();
    const list = readDrawerList();
    const current = list.find(r => String(r.date || '').trim() === ymd);
    if (!current || !current.closing) {
        throw createError(409, 'Closing counts must be submitted before approval.');
    }
    if (current.approved) {
        throw createError(409, 'Daily totals already submitted for this day.');
    }
    const approvedBy = String(payload?.by || current.closing.cashier || 'Cashier');
    return upsertDrawer(ymd, {
        approved: {
            by: approvedBy,
            ts: new Date().toISOString()
        }
    });
}

async function listDrawers(payload) {
    const start = String(payload?.startDate || '').trim();
    const end = String(payload?.endDate || '').trim();
    const list = readDrawerList().map(sanitizeDrawer);
    return list.filter(rec => {
        const d = String(rec?.date || '');
        const afterStart = start ? d >= start : true;
        const beforeEnd = end ? d <= end : true;
        return afterStart && beforeEnd;
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

module.exports = {
    getDrawer,
    saveOpening,
    saveClosing,
    approveDrawer,
    listDrawers
};

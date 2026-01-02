const crypto = require('crypto');
const { getPool } = require('./db');
const { readReceipts, writeReceipts, resolveDataDir } = require('./storage');

function parseData(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return null; }
    }
    return null;
}

function normId(value) {
    return String(value ?? '').trim();
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

function toDateString(value) {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeReceipt(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const id = String(r.id || r.number || '').trim();
    if (!id) return null;
    const number = String(r.number || r.id || '').trim();
    const datetime = toDateString(r.datetime || r.dateTime || r.createdAt || r.updatedAt || null);
    const cashier = String(r.cashier || '').trim();
    const payment = String(r.payment || '').trim();
    const subtotal = Number.isFinite(Number(r.subtotal)) ? Number(r.subtotal) : null;
    const tax = Number.isFinite(Number(r.tax)) ? Number(r.tax) : null;
    const total = Number.isFinite(Number(r.total)) ? Number(r.total) : null;
    const voided = r.voided ? 1 : 0;
    const returned = r.returned ? 1 : 0;
    const createdAt = toDateString(r.createdAt || r.datetime || null);
    const updatedAt = toDateString(r.updatedAt || r.datetime || null);
    const data = JSON.stringify(r);
    const importKey = crypto.createHash('sha256').update(data).digest('hex');
    return {
        id,
        number,
        datetime,
        cashier,
        payment,
        subtotal,
        tax,
        total,
        voided,
        returned,
        createdAt,
        updatedAt,
        importKey,
        data
    };
}

async function listReceipts() {
    const pool = getPool();
    if (!pool) return readReceipts();
    const [rows] = await pool.query(
        'SELECT data FROM receipts ORDER BY datetime DESC, createdAt DESC, pk DESC;'
    );
    return (rows || [])
        .map(row => parseData(row.data))
        .filter(Boolean);
}

async function countReceipts() {
    const pool = getPool();
    if (!pool) {
        const receipts = readReceipts();
        return Array.isArray(receipts) ? receipts.length : 0;
    }
    const [rows] = await pool.query('SELECT COUNT(*) as count FROM receipts;');
    const count = Array.isArray(rows) && rows[0] ? Number(rows[0].count || 0) : 0;
    return Number.isFinite(count) ? count : 0;
}

async function getReceiptById(id) {
    const pool = getPool();
    if (!pool) {
        const receipts = readReceipts();
        return receipts.find(r => String(r?.id || '').trim() === id || String(r?.number || '').trim() === id) || null;
    }
    const [rows] = await pool.query(
        'SELECT data FROM receipts WHERE id = :id OR number = :id ORDER BY datetime DESC, pk DESC LIMIT 1;',
        { id }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return row ? parseData(row.data) : null;
}

async function addReceipt(payload) {
    const { out } = migrateReceipts([payload || {}]);
    const receipt = out[0];
    if (!receipt) return null;
    const now = new Date().toISOString();
    const withDates = {
        ...receipt,
        createdAt: receipt.createdAt || now,
        updatedAt: now,
        datetime: receipt.datetime || now
    };
    const pool = getPool();
    if (!pool) {
        const list = readReceipts();
        const { out: normalized } = migrateReceipts(list);
        normalized.push(withDates);
        writeReceipts(normalized);
        return withDates;
    }
    const row = normalizeReceipt(withDates);
    if (!row) return null;
    await pool.query(
        `INSERT INTO receipts
            (id, number, datetime, cashier, payment, subtotal, tax, total, voided, returned, createdAt, updatedAt, importKey, data)
         VALUES
            (:id, :number, :datetime, :cashier, :payment, :subtotal, :tax, :total, :voided, :returned, :createdAt, :updatedAt, :importKey, :data)
         ON DUPLICATE KEY UPDATE
            number = VALUES(number),
            datetime = VALUES(datetime),
            cashier = VALUES(cashier),
            payment = VALUES(payment),
            subtotal = VALUES(subtotal),
            tax = VALUES(tax),
            total = VALUES(total),
            voided = VALUES(voided),
            returned = VALUES(returned),
            createdAt = VALUES(createdAt),
            updatedAt = VALUES(updatedAt),
            importKey = VALUES(importKey),
            data = VALUES(data);`,
        row
    );
    return withDates;
}

async function markVoid(payload) {
    const key = normId(payload?.id);
    if (!key) return null;
    const pool = getPool();
    if (!pool) {
        const all = readReceipts();
        const { out } = migrateReceipts(all);
        const idx = out.findIndex(r => normId(r.id) === key || normId(r.number) === key);
        if (idx === -1) return null;
        const now = new Date().toISOString();
        out[idx].voided = true;
        out[idx].voidInfo = {
            reason: String(payload?.reason || '').trim(),
            user: String(payload?.user || 'system'),
            userObj: payload?.userObj || null,
            when: now
        };
        out[idx].updatedAt = now;
        writeReceipts(out);
        return out[idx];
    }
    const existing = await getReceiptById(key);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated = {
        ...existing,
        voided: true,
        voidInfo: {
            reason: String(payload?.reason || '').trim(),
            user: String(payload?.user || 'system'),
            userObj: payload?.userObj || null,
            when: now
        },
        updatedAt: now
    };
    const row = normalizeReceipt(updated);
    if (!row) return null;
    await pool.query(
        `UPDATE receipts
         SET id = :id, number = :number, datetime = :datetime, cashier = :cashier, payment = :payment,
             subtotal = :subtotal, tax = :tax, total = :total, voided = :voided, returned = :returned,
             createdAt = :createdAt, updatedAt = :updatedAt, importKey = :importKey, data = :data
         WHERE id = :oldId OR number = :oldId
         LIMIT 1;`,
        { ...row, oldId: key }
    );
    return updated;
}

async function markReturn(payload) {
    const key = normId(payload?.id);
    if (!key) return null;
    const pool = getPool();
    if (!pool) {
        const all = readReceipts();
        const { out } = migrateReceipts(all);
        const idx = out.findIndex(r => normId(r.id) === key || normId(r.number) === key);
        if (idx === -1 || out[idx].voided) return null;
        const now = new Date().toISOString();
        out[idx].returned = true;
        out[idx].returnInfo = {
            reason: String(payload?.reason || '').trim(),
            user: String(payload?.user || 'system'),
            userObj: payload?.userObj || null,
            when: now,
            items: sanitizeReturnItems(payload?.items)
        };
        out[idx].updatedAt = now;
        writeReceipts(out);
        return out[idx];
    }
    const existing = await getReceiptById(key);
    if (!existing || existing.voided) return null;
    const now = new Date().toISOString();
    const updated = {
        ...existing,
        returned: true,
        returnInfo: {
            reason: String(payload?.reason || '').trim(),
            user: String(payload?.user || 'system'),
            userObj: payload?.userObj || null,
            when: now,
            items: sanitizeReturnItems(payload?.items)
        },
        updatedAt: now
    };
    const row = normalizeReceipt(updated);
    if (!row) return null;
    await pool.query(
        `UPDATE receipts
         SET id = :id, number = :number, datetime = :datetime, cashier = :cashier, payment = :payment,
             subtotal = :subtotal, tax = :tax, total = :total, voided = :voided, returned = :returned,
             createdAt = :createdAt, updatedAt = :updatedAt, importKey = :importKey, data = :data
         WHERE id = :oldId OR number = :oldId
         LIMIT 1;`,
        { ...row, oldId: key }
    );
    return updated;
}

async function reindexReceipts() {
    const pool = getPool();
    if (!pool) {
        const all = readReceipts();
        const { out, changed } = migrateReceipts(all);
        if (changed) writeReceipts(out);
        return { changed, count: out.length };
    }
    const [rows] = await pool.query('SELECT id, number, data FROM receipts ORDER BY datetime ASC, createdAt ASC, id ASC;');
    const records = (rows || []).map(r => parseData(r.data)).filter(Boolean);
    const { out, changed } = migrateReceipts(records);
    if (!changed) return { changed: false, count: out.length };
    for (let i = 0; i < out.length; i += 1) {
        const updated = out[i];
        const oldId = String(rows[i]?.id || rows[i]?.number || updated.id || '').trim();
        const row = normalizeReceipt(updated);
        if (!row) continue;
        await pool.query(
            `UPDATE receipts
             SET id = :id, number = :number, datetime = :datetime, cashier = :cashier, payment = :payment,
                 subtotal = :subtotal, tax = :tax, total = :total, voided = :voided, returned = :returned,
                 createdAt = :createdAt, updatedAt = :updatedAt, importKey = :importKey, data = :data
             WHERE id = :oldId OR number = :oldId
             LIMIT 1;`,
            { ...row, oldId }
        );
    }
    return { changed: true, count: out.length };
}

async function replaceAll(receipts) {
    const { out } = migrateReceipts(receipts || []);
    const pool = getPool();
    if (!pool) {
        writeReceipts(out);
        return out;
    }
    await pool.query('DELETE FROM receipts;');
    const normalized = out.map(normalizeReceipt).filter(Boolean);
    const sql = `
        INSERT INTO receipts
            (id, number, datetime, cashier, payment, subtotal, tax, total, voided, returned, createdAt, updatedAt, importKey, data)
        VALUES
            (:id, :number, :datetime, :cashier, :payment, :subtotal, :tax, :total, :voided, :returned, :createdAt, :updatedAt, :importKey, :data)
        ON DUPLICATE KEY UPDATE
            number = VALUES(number),
            datetime = VALUES(datetime),
            cashier = VALUES(cashier),
            payment = VALUES(payment),
            subtotal = VALUES(subtotal),
            tax = VALUES(tax),
            total = VALUES(total),
            voided = VALUES(voided),
            returned = VALUES(returned),
            createdAt = VALUES(createdAt),
            updatedAt = VALUES(updatedAt),
            importKey = VALUES(importKey),
            data = VALUES(data);
    `;
    for (const row of normalized) {
        await pool.query(sql, row);
    }
    return out;
}

async function debugInfo() {
    const pool = getPool();
    const list = await listReceipts();
    return {
        storageType: pool ? 'mysql' : 'json',
        storagePath: pool ? 'mysql' : resolveDataDir(),
        count: Array.isArray(list) ? list.length : 0,
        sampleIds: (Array.isArray(list) ? list : []).slice(0, 5).map(r => ({ id: r?.id, number: r?.number }))
    };
}

module.exports = {
    listReceipts,
    countReceipts,
    getReceiptById,
    addReceipt,
    markVoid,
    markReturn,
    reindexReceipts,
    replaceAll,
    debugInfo
};

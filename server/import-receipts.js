require('dotenv').config();
const crypto = require('crypto');
const { getPool } = require('./db');
const fs = require('fs');
const path = require('path');
const { readReceipts } = require('./storage');

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

function readBackupReceipts(backupPath) {
    if (!backupPath) return null;
    const full = path.resolve(String(backupPath));
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.receipts)) return parsed.receipts;
    return null;
}

async function run() {
    const pool = getPool();
    if (!pool) {
        throw new Error('MySQL is not configured. Set MYSQL_URL or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE.');
    }
    const backupPath = String(process.env.MIDDLETONS_BACKUP_PATH || '').trim();
    const backupReceipts = readBackupReceipts(backupPath);
    const receipts = backupReceipts || readReceipts();
    const excludeVoids = String(process.env.EXCLUDE_VOIDED || '').trim() === '1';
    const normalized = (Array.isArray(receipts) ? receipts : [])
        .filter(r => !excludeVoids || !r?.voided)
        .map(normalizeReceipt)
        .filter(Boolean);
    if (!normalized.length) {
        console.log('[import] no receipts found to import.');
        await pool.end();
        return;
    }
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
    let count = 0;
    for (const receipt of normalized) {
        await pool.query(sql, receipt);
        count += 1;
        if (count % 250 === 0) {
            console.log(`[import] imported ${count} receipts...`);
        }
    }
    console.log(`[import] imported ${count} receipts total.`);
    await pool.end();
}

run().catch((err) => {
    console.error('[import] failed', err.message || err);
    process.exitCode = 1;
});

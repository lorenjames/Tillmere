require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');
const { readVendors, readCashiers, readSettings } = require('./storage');

function readBackup(backupPath) {
    if (!backupPath) return null;
    const full = path.resolve(String(backupPath));
    if (!fs.existsSync(full)) return null;
    const raw = fs.readFileSync(full, 'utf-8');
    return JSON.parse(raw);
}

function hashRecord(record) {
    return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function normalizeVendor(raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const code = String(v.code || '').trim();
    if (!code) return null;
    const name = String(v.name || '').trim();
    const phone = String(v.phone || '').trim();
    const email = String(v.email || '').trim();
    const active = v.active === false ? 0 : 1;
    return {
        code,
        name,
        phone,
        email,
        active,
        importKey: hashRecord(v),
        data: JSON.stringify(v)
    };
}

function normalizeCashier(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const name = String(c.name || '').trim();
    if (!name) return null;
    const active = c.active === false ? 0 : 1;
    return {
        name,
        active,
        pinHash: String(c.pinHash || '').trim(),
        pinSalt: String(c.pinSalt || '').trim(),
        importKey: hashRecord(c),
        data: JSON.stringify(c)
    };
}

async function upsertVendors(pool, vendors) {
    if (!vendors.length) return 0;
    const sql = `
        INSERT INTO vendors
            (code, name, phone, email, active, importKey, data)
        VALUES
            (:code, :name, :phone, :email, :active, :importKey, :data)
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            phone = VALUES(phone),
            email = VALUES(email),
            active = VALUES(active),
            importKey = VALUES(importKey),
            data = VALUES(data);
    `;
    let count = 0;
    for (const vendor of vendors) {
        await pool.query(sql, vendor);
        count += 1;
    }
    return count;
}

async function upsertCashiers(pool, cashiers) {
    if (!cashiers.length) return 0;
    const sql = `
        INSERT INTO cashiers
            (name, active, pinHash, pinSalt, importKey, data)
        VALUES
            (:name, :active, :pinHash, :pinSalt, :importKey, :data)
        ON DUPLICATE KEY UPDATE
            active = VALUES(active),
            pinHash = VALUES(pinHash),
            pinSalt = VALUES(pinSalt),
            importKey = VALUES(importKey),
            data = VALUES(data);
    `;
    let count = 0;
    for (const cashier of cashiers) {
        await pool.query(sql, cashier);
        count += 1;
    }
    return count;
}

async function upsertSettings(pool, settings) {
    if (!settings || typeof settings !== 'object') return false;
    const sql = `
        INSERT INTO settings (id, data, updatedAt)
        VALUES (1, :data, NOW())
        ON DUPLICATE KEY UPDATE data = VALUES(data), updatedAt = NOW();
    `;
    await pool.query(sql, { data: JSON.stringify(settings) });
    return true;
}

async function run() {
    const pool = getPool();
    if (!pool) {
        throw new Error('MySQL is not configured. Set MYSQL_URL or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE.');
    }
    const backupPath = String(process.env.MIDDLETONS_BACKUP_PATH || '').trim();
    const backup = readBackup(backupPath);
    const vendorsRaw = Array.isArray(backup?.vendors) ? backup.vendors : readVendors();
    const cashiersRaw = Array.isArray(backup?.cashiers) ? backup.cashiers : readCashiers();
    const settingsRaw = (backup && typeof backup.settings === 'object')
        ? backup.settings
        : readSettings();

    const vendors = (Array.isArray(vendorsRaw) ? vendorsRaw : []).map(normalizeVendor).filter(Boolean);
    const cashiers = (Array.isArray(cashiersRaw) ? cashiersRaw : []).map(normalizeCashier).filter(Boolean);

    const vendorsCount = await upsertVendors(pool, vendors);
    const cashiersCount = await upsertCashiers(pool, cashiers);
    const settingsOk = await upsertSettings(pool, settingsRaw);

    console.log(`[import] vendors: ${vendorsCount}`);
    console.log(`[import] cashiers: ${cashiersCount}`);
    console.log(`[import] settings: ${settingsOk ? 'ok' : 'skipped'}`);
    await pool.end();
}

run().catch((err) => {
    console.error('[import] failed', err.message || err);
    process.exitCode = 1;
});

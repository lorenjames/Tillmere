require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');

async function run() {
    const pool = getPool();
    if (!pool) {
        throw new Error('MySQL is not configured. Set MYSQL_URL or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE.');
    }
    await pool.query(`
        CREATE TABLE IF NOT EXISTS migrations (
            name VARCHAR(255) PRIMARY KEY,
            applied_at DATETIME NOT NULL
        );
    `);
    const [[dbRow]] = await pool.query('SELECT DATABASE() as name;');
    const dbName = dbRow?.name || null;
    if (dbName) {
        const [pkRows] = await pool.query(
            'SELECT 1 as ok FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1;',
            [dbName, 'receipts', 'pk']
        );
        if (Array.isArray(pkRows) && pkRows.length) {
            await pool.query(
                'INSERT IGNORE INTO migrations (name, applied_at) VALUES (?, NOW());',
                ['002_receipts_pk.sql']
            );
        }
    }
    const [appliedRows] = await pool.query('SELECT name FROM migrations;');
    const applied = new Set((appliedRows || []).map(row => row.name));
    const sqlDir = path.join(__dirname, 'sql');
    const files = fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
        if (applied.has(file)) {
            console.log(`[migrate] skip ${file}`);
            continue;
        }
        const full = path.join(sqlDir, file);
        const sql = fs.readFileSync(full, 'utf-8');
        if (!sql.trim()) continue;
        try {
            await pool.query(sql);
            await pool.query('INSERT INTO migrations (name, applied_at) VALUES (?, NOW());', [file]);
            console.log(`[migrate] applied ${file}`);
        } catch (err) {
            const message = String(err?.message || '');
            if (file === '002_receipts_pk.sql' && message.includes('Duplicate column name \'pk\'')) {
                await pool.query('INSERT IGNORE INTO migrations (name, applied_at) VALUES (?, NOW());', [file]);
                console.log(`[migrate] mark applied ${file} (pk already exists)`);
                continue;
            }
            throw err;
        }
    }
    await pool.end();
}

run().catch((err) => {
    console.error('[migrate] failed', err.message || err);
    process.exitCode = 1;
});

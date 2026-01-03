require('dotenv').config();
const { readGiftCards } = require('./storage');
const { getPool } = require('./db');
const { saveGiftCards } = require('./giftcards-store');

async function run() {
    const pool = getPool();
    if (!pool) {
        throw new Error('MySQL is not configured. Set MYSQL_URL or MYSQL_HOST/MYSQL_USER/MYSQL_DATABASE.');
    }
    const data = readGiftCards();
    if (!data) {
        console.log('[giftcards] no giftcards.json found, skipping import.');
        return;
    }
    await saveGiftCards(data);
    console.log('[giftcards] imported giftcards.json into MySQL.');
    await pool.end();
}

run().catch((err) => {
    console.error('[giftcards] import failed', err.message || err);
    process.exitCode = 1;
});

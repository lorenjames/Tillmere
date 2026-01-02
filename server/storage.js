const fs = require('fs');
const path = require('path');

function resolveDataDir() {
    const fromEnv = String(process.env.MIDDLETONS_DATA_DIR || '').trim();
    if (fromEnv) return path.resolve(fromEnv);
    return path.join(process.cwd(), 'data');
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
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

function dataPath(fileName) {
    return path.join(resolveDataDir(), fileName);
}

function readReceipts() {
    return readJson(dataPath('receipts.json'), []);
}

function readGiftCards() {
    return readJson(dataPath('giftcards.json'), { books: [], cards: [], transactions: [] });
}

function readVendors() {
    return readJson(dataPath('vendors.json'), []);
}

function readCashiers() {
    return readJson(dataPath('cashiers.json'), []);
}

function readSettings() {
    return readJson(dataPath('settings.json'), {});
}

function writeGiftCards(giftCards) {
    const safe = giftCards && typeof giftCards === 'object'
        ? giftCards
        : { books: [], cards: [], transactions: [] };
    return writeJson(dataPath('giftcards.json'), safe);
}

function writeReceipts(receipts) {
    return writeJson(dataPath('receipts.json'), Array.isArray(receipts) ? receipts : []);
}

function writeSettings(settings) {
    const safe = settings && typeof settings === 'object' ? settings : {};
    return writeJson(dataPath('settings.json'), safe);
}

function writeCashiers(cashiers) {
    return writeJson(dataPath('cashiers.json'), Array.isArray(cashiers) ? cashiers : []);
}

function writeVendors(vendors) {
    return writeJson(dataPath('vendors.json'), Array.isArray(vendors) ? vendors : []);
}

module.exports = {
    resolveDataDir,
    readReceipts,
    readGiftCards,
    writeReceipts,
    readVendors,
    readCashiers,
    readSettings,
    writeSettings,
    writeGiftCards,
    writeCashiers,
    writeVendors
};

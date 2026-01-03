const crypto = require('crypto');
const { readGiftCards, writeGiftCards } = require('./storage');

function roundMoney(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 100) / 100;
}

function normalizeGiftCardNumber(value) {
    return String(value || '').replace(/\s+/g, '').trim().toUpperCase();
}

function normalizeGiftCardData(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const books = Array.isArray(source.books) ? source.books : [];
    const cards = Array.isArray(source.cards) ? source.cards : [];
    const transactions = Array.isArray(source.transactions) ? source.transactions : [];
    const cleanCards = cards
        .map(card => {
            const number = normalizeGiftCardNumber(card?.number);
            if (!number) return null;
            const status = ['available', 'active', 'redeemed', 'void'].includes(card?.status)
                ? card.status
                : (Number(card?.balance || 0) > 0 ? 'active' : 'available');
            return {
                number,
                bookId: String(card?.bookId || '').trim(),
                status,
                balance: roundMoney(card?.balance || 0),
                initialValue: roundMoney(card?.initialValue || 0),
                soldAt: String(card?.soldAt || ''),
                soldBy: String(card?.soldBy || ''),
                soldReceipt: String(card?.soldReceipt || ''),
                note: String(card?.note || '')
            };
        })
        .filter(Boolean);
    const cleanBooks = books
        .map(book => ({
            id: String(book?.id || '').trim(),
            label: String(book?.label || '').trim(),
            prefix: String(book?.prefix || '').trim(),
            start: Number.isFinite(Number(book?.start)) ? Number(book.start) : 0,
            end: Number.isFinite(Number(book?.end)) ? Number(book.end) : 0,
            pad: Number.isFinite(Number(book?.pad)) ? Number(book.pad) : 0,
            createdAt: String(book?.createdAt || ''),
            count: Number.isFinite(Number(book?.count)) ? Number(book.count) : 0
        }))
        .filter(b => b.id || b.label || b.prefix);
    const cleanTransactions = transactions
        .map(txn => ({
            id: String(txn?.id || '').trim(),
            number: normalizeGiftCardNumber(txn?.number),
            type: String(txn?.type || ''),
            amount: roundMoney(txn?.amount || 0),
            balanceAfter: roundMoney(txn?.balanceAfter || 0),
            cashier: String(txn?.cashier || '').trim(),
            receiptNumber: String(txn?.receiptNumber || '').trim(),
            note: String(txn?.note || '').trim(),
            createdAt: String(txn?.createdAt || '')
        }))
        .filter(txn => txn.id && txn.number);
    return { books: cleanBooks, cards: cleanCards, transactions: cleanTransactions };
}

function loadGiftCards() {
    const fallback = { books: [], cards: [], transactions: [] };
    const raw = readGiftCards();
    return normalizeGiftCardData(raw || fallback);
}

function saveGiftCards(data) {
    const normalized = normalizeGiftCardData(data || {});
    writeGiftCards(normalized);
    return normalized;
}

function buildGiftCardBook(payload, existingNumbers) {
    const label = String(payload?.label || '').trim();
    const prefix = String(payload?.prefix || '').trim();
    const start = Number.parseInt(payload?.start, 10);
    const end = Number.parseInt(payload?.end, 10);
    const pad = Number.parseInt(payload?.pad, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
        const err = new Error('Start and end numbers are required.');
        err.code = 'INVALID_RANGE';
        throw err;
    }
    const normalizedStart = Math.min(start, end);
    const normalizedEnd = Math.max(start, end);
    const padLen = Number.isFinite(pad) && pad > 0
        ? pad
        : Math.max(String(normalizedStart).length, String(normalizedEnd).length);
    const numbers = [];
    for (let i = normalizedStart; i <= normalizedEnd; i += 1) {
        const num = `${prefix}${String(i).padStart(padLen, '0')}`;
        numbers.push(normalizeGiftCardNumber(num));
    }
    const existing = new Set(existingNumbers.map(n => normalizeGiftCardNumber(n)));
    const dupes = numbers.filter(n => existing.has(n));
    if (dupes.length) {
        const err = new Error(`Some gift cards already exist (${dupes.slice(0, 3).join(', ')}${dupes.length > 3 ? ', ...' : ''}).`);
        err.code = 'DUPLICATE_CARDS';
        err.duplicates = dupes;
        throw err;
    }
    const bookId = `book-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createdAt = new Date().toISOString();
    return {
        book: {
            id: bookId,
            label,
            prefix,
            start: normalizedStart,
            end: normalizedEnd,
            pad: padLen,
            createdAt,
            count: numbers.length
        },
        numbers
    };
}

function addGiftCardBook(payload) {
    const data = loadGiftCards();
    const existingNumbers = data.cards.map(c => c.number);
    const { book, numbers } = buildGiftCardBook(payload, existingNumbers);
    const cards = numbers.map(number => ({
        number,
        bookId: book.id,
        status: 'available',
        balance: 0,
        initialValue: 0,
        soldAt: '',
        soldBy: '',
        soldReceipt: '',
        note: ''
    }));
    data.books.push(book);
    data.cards.push(...cards);
    saveGiftCards(data);
    return { ok: true, book, added: numbers.length };
}

function sellGiftCard(payload) {
    const data = loadGiftCards();
    const number = normalizeGiftCardNumber(payload?.number);
    const amount = roundMoney(payload?.amount);
    const cashier = String(payload?.cashier || '').trim();
    const receiptNumber = String(payload?.receiptNumber || '').trim();
    const note = String(payload?.note || '').trim();
    if (!number) {
        const err = new Error('Gift card number is required.');
        err.code = 'INVALID_NUMBER';
        throw err;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error('Gift card amount must be greater than 0.');
        err.code = 'INVALID_AMOUNT';
        throw err;
    }
    const card = data.cards.find(c => normalizeGiftCardNumber(c.number) === number);
    if (!card) {
        const err = new Error('Gift card not found.');
        err.code = 'CARD_NOT_FOUND';
        throw err;
    }
    if (card.status !== 'available' || Number(card.balance || 0) > 0) {
        const err = new Error('Gift card is already active.');
        err.code = 'CARD_ALREADY_ACTIVE';
        throw err;
    }
    const now = new Date().toISOString();
    card.status = 'active';
    card.initialValue = amount;
    card.balance = amount;
    card.soldAt = now;
    card.soldBy = cashier;
    card.soldReceipt = receiptNumber;
    card.note = note;
    data.transactions.push({
        id: `txn-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        number: card.number,
        type: 'sale',
        amount,
        balanceAfter: card.balance,
        cashier,
        receiptNumber,
        note,
        createdAt: now
    });
    saveGiftCards(data);
    return { ok: true, card };
}

function redeemGiftCard(payload) {
    const data = loadGiftCards();
    const number = normalizeGiftCardNumber(payload?.number);
    const amount = roundMoney(payload?.amount);
    const cashier = String(payload?.cashier || '').trim();
    const receiptNumber = String(payload?.receiptNumber || '').trim();
    const note = String(payload?.note || '').trim();
    if (!number) {
        const err = new Error('Gift card number is required.');
        err.code = 'INVALID_NUMBER';
        throw err;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error('Redemption amount must be greater than 0.');
        err.code = 'INVALID_AMOUNT';
        throw err;
    }
    const card = data.cards.find(c => normalizeGiftCardNumber(c.number) === number);
    if (!card) {
        const err = new Error('Gift card not found.');
        err.code = 'CARD_NOT_FOUND';
        throw err;
    }
    if (card.status !== 'active' || Number(card.balance || 0) <= 0) {
        const err = new Error('Gift card is not active.');
        err.code = 'CARD_INACTIVE';
        throw err;
    }
    if (amount > Number(card.balance || 0)) {
        const err = new Error('Gift card balance is too low.');
        err.code = 'INSUFFICIENT_BALANCE';
        err.balance = Number(card.balance || 0);
        throw err;
    }
    const now = new Date().toISOString();
    card.balance = roundMoney(Number(card.balance || 0) - amount);
    if (card.balance <= 0) {
        card.status = 'redeemed';
        card.balance = 0;
    }
    data.transactions.push({
        id: `txn-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        number: card.number,
        type: 'redeem',
        amount,
        balanceAfter: card.balance,
        cashier,
        receiptNumber,
        note,
        createdAt: now
    });
    saveGiftCards(data);
    return { ok: true, card };
}

function lookupGiftCard(payload) {
    const data = loadGiftCards();
    const number = normalizeGiftCardNumber(payload?.number);
    if (!number) return null;
    const card = data.cards.find(c => normalizeGiftCardNumber(c.number) === number) || null;
    if (!card) return null;
    const history = data.transactions.filter(t => normalizeGiftCardNumber(t.number) === number);
    return { card, transactions: history };
}

module.exports = {
    loadGiftCards,
    saveGiftCards,
    addGiftCardBook,
    sellGiftCard,
    redeemGiftCard,
    lookupGiftCard
};

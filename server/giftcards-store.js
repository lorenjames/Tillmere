const { readGiftCards, writeGiftCards } = require('./storage');
const { getPool } = require('./db');

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

function toDbDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

function fromDbDate(value) {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
    return String(value);
}

async function loadGiftCards() {
    const fallback = { books: [], cards: [], transactions: [] };
    const pool = getPool();
    if (!pool) {
        const raw = readGiftCards();
        return normalizeGiftCardData(raw || fallback);
    }
    const [bookRows] = await pool.query(`
        SELECT id, label, prefix, start_num AS start, end_num AS end, pad, created_at AS createdAt, count
        FROM giftcard_books
        ORDER BY created_at ASC
    `);
    const [cardRows] = await pool.query(`
        SELECT number, book_id AS bookId, status, balance, initial_value AS initialValue,
               sold_at AS soldAt, sold_by AS soldBy, sold_receipt AS soldReceipt, note
        FROM giftcards
    `);
    const [txnRows] = await pool.query(`
        SELECT id, number, type, amount, balance_after AS balanceAfter, cashier,
               receipt_number AS receiptNumber, note, created_at AS createdAt
        FROM giftcard_transactions
        ORDER BY created_at ASC
    `);
    const data = {
        books: (bookRows || []).map(row => ({
            id: String(row.id || '').trim(),
            label: String(row.label || '').trim(),
            prefix: String(row.prefix || '').trim(),
            start: Number.isFinite(Number(row.start)) ? Number(row.start) : 0,
            end: Number.isFinite(Number(row.end)) ? Number(row.end) : 0,
            pad: Number.isFinite(Number(row.pad)) ? Number(row.pad) : 0,
            createdAt: fromDbDate(row.createdAt),
            count: Number.isFinite(Number(row.count)) ? Number(row.count) : 0
        })),
        cards: (cardRows || []).map(row => ({
            number: normalizeGiftCardNumber(row.number),
            bookId: String(row.bookId || '').trim(),
            status: String(row.status || '').trim(),
            balance: roundMoney(row.balance || 0),
            initialValue: roundMoney(row.initialValue || 0),
            soldAt: fromDbDate(row.soldAt),
            soldBy: String(row.soldBy || '').trim(),
            soldReceipt: String(row.soldReceipt || '').trim(),
            note: String(row.note || '')
        })),
        transactions: (txnRows || []).map(row => ({
            id: String(row.id || '').trim(),
            number: normalizeGiftCardNumber(row.number),
            type: String(row.type || '').trim(),
            amount: roundMoney(row.amount || 0),
            balanceAfter: roundMoney(row.balanceAfter || 0),
            cashier: String(row.cashier || '').trim(),
            receiptNumber: String(row.receiptNumber || '').trim(),
            note: String(row.note || '').trim(),
            createdAt: fromDbDate(row.createdAt)
        }))
    };
    return normalizeGiftCardData(data || fallback);
}

async function saveGiftCards(data) {
    const normalized = normalizeGiftCardData(data || {});
    const pool = getPool();
    if (!pool) {
        writeGiftCards(normalized);
        return normalized;
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM giftcard_transactions;');
        await conn.query('DELETE FROM giftcards;');
        await conn.query('DELETE FROM giftcard_books;');

        for (const book of normalized.books) {
            await conn.query(
                `INSERT INTO giftcard_books
                    (id, label, prefix, start_num, end_num, pad, created_at, count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
                [
                    book.id,
                    book.label,
                    book.prefix,
                    Number(book.start || 0),
                    Number(book.end || 0),
                    Number(book.pad || 0),
                    toDbDate(book.createdAt) || toDbDate(new Date()),
                    Number(book.count || 0)
                ]
            );
        }

        for (const card of normalized.cards) {
            await conn.query(
                `INSERT INTO giftcards
                    (number, book_id, status, balance, initial_value, sold_at, sold_by, sold_receipt, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
                [
                    card.number,
                    card.bookId || null,
                    card.status,
                    Number(card.balance || 0),
                    Number(card.initialValue || 0),
                    toDbDate(card.soldAt),
                    card.soldBy || '',
                    card.soldReceipt || '',
                    card.note || ''
                ]
            );
        }

        for (const txn of normalized.transactions) {
            await conn.query(
                `INSERT INTO giftcard_transactions
                    (id, number, type, amount, balance_after, cashier, receipt_number, note, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
                [
                    txn.id,
                    txn.number,
                    txn.type,
                    Number(txn.amount || 0),
                    Number(txn.balanceAfter || 0),
                    txn.cashier || '',
                    txn.receiptNumber || '',
                    txn.note || '',
                    toDbDate(txn.createdAt) || toDbDate(new Date())
                ]
            );
        }

        await conn.commit();
        return normalized;
    } catch (err) {
        try { await conn.rollback(); } catch (_) { }
        throw err;
    } finally {
        conn.release();
    }
}

function buildGiftCardBook(payload) {
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

function getDuplicateNumbers(numbers, existingNumbers) {
    const existing = new Set(existingNumbers.map(n => normalizeGiftCardNumber(n)));
    return numbers.filter(n => existing.has(normalizeGiftCardNumber(n)));
}

async function getExistingNumbersFromDb(pool, numbers) {
    const existing = new Set();
    const chunkSize = 500;
    for (let i = 0; i < numbers.length; i += chunkSize) {
        const chunk = numbers.slice(i, i + chunkSize);
        if (!chunk.length) continue;
        const placeholders = chunk.map(() => '?').join(',');
        const [rows] = await pool.query(
            `SELECT number FROM giftcards WHERE number IN (${placeholders});`,
            chunk
        );
        (rows || []).forEach(row => existing.add(normalizeGiftCardNumber(row.number)));
    }
    return Array.from(existing);
}

async function addGiftCardBook(payload) {
    const pool = getPool();
    const { book, numbers } = buildGiftCardBook(payload);
    let existingNumbers = [];
    if (pool) {
        existingNumbers = await getExistingNumbersFromDb(pool, numbers);
    } else {
        const data = await loadGiftCards();
        existingNumbers = data.cards.map(c => c.number);
    }
    const dupes = getDuplicateNumbers(numbers, existingNumbers);
    if (dupes.length) {
        const err = new Error(`Some gift cards already exist (${dupes.slice(0, 3).join(', ')}${dupes.length > 3 ? ', ...' : ''}).`);
        err.code = 'DUPLICATE_CARDS';
        err.duplicates = dupes;
        throw err;
    }
    if (!pool) {
        const data = await loadGiftCards();
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
        await saveGiftCards(data);
        return { ok: true, book, added: numbers.length };
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.query(
            `INSERT INTO giftcard_books
                (id, label, prefix, start_num, end_num, pad, created_at, count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
            [
                book.id,
                book.label,
                book.prefix,
                Number(book.start || 0),
                Number(book.end || 0),
                Number(book.pad || 0),
                toDbDate(book.createdAt) || toDbDate(new Date()),
                Number(book.count || 0)
            ]
        );
        for (const number of numbers) {
            await conn.query(
                `INSERT INTO giftcards
                    (number, book_id, status, balance, initial_value, sold_at, sold_by, sold_receipt, note)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
                [number, book.id, 'available', 0, 0, null, '', '', '']
            );
        }
        await conn.commit();
        return { ok: true, book, added: numbers.length };
    } catch (err) {
        try { await conn.rollback(); } catch (_) { }
        throw err;
    } finally {
        conn.release();
    }
}

async function sellGiftCard(payload) {
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
    const pool = getPool();
    if (!pool) {
        const data = await loadGiftCards();
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
        await saveGiftCards(data);
        return { ok: true, card };
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT number, book_id AS bookId, status, balance, initial_value AS initialValue,
                    sold_at AS soldAt, sold_by AS soldBy, sold_receipt AS soldReceipt, note
             FROM giftcards WHERE number = ? FOR UPDATE;`,
            [number]
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) {
            const err = new Error('Gift card not found.');
            err.code = 'CARD_NOT_FOUND';
            throw err;
        }
        if (String(row.status || '') !== 'available' || Number(row.balance || 0) > 0) {
            const err = new Error('Gift card is already active.');
            err.code = 'CARD_ALREADY_ACTIVE';
            throw err;
        }
        const now = new Date().toISOString();
        await conn.query(
            `UPDATE giftcards
             SET status = ?, balance = ?, initial_value = ?, sold_at = ?, sold_by = ?, sold_receipt = ?, note = ?
             WHERE number = ?;`,
            ['active', amount, amount, toDbDate(now), cashier, receiptNumber, note, number]
        );
        const txnId = `txn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        await conn.query(
            `INSERT INTO giftcard_transactions
                (id, number, type, amount, balance_after, cashier, receipt_number, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [txnId, number, 'sale', amount, amount, cashier, receiptNumber, note, toDbDate(now)]
        );
        await conn.commit();
        const card = {
            number,
            bookId: String(row.bookId || '').trim(),
            status: 'active',
            balance: amount,
            initialValue: amount,
            soldAt: now,
            soldBy: cashier,
            soldReceipt: receiptNumber,
            note
        };
        return { ok: true, card };
    } catch (err) {
        try { await conn.rollback(); } catch (_) { }
        throw err;
    } finally {
        conn.release();
    }
}

async function redeemGiftCard(payload) {
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
    const pool = getPool();
    if (!pool) {
        const data = await loadGiftCards();
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
        await saveGiftCards(data);
        return { ok: true, card };
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [rows] = await conn.query(
            `SELECT number, book_id AS bookId, status, balance, initial_value AS initialValue,
                    sold_at AS soldAt, sold_by AS soldBy, sold_receipt AS soldReceipt, note
             FROM giftcards WHERE number = ? FOR UPDATE;`,
            [number]
        );
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) {
            const err = new Error('Gift card not found.');
            err.code = 'CARD_NOT_FOUND';
            throw err;
        }
        if (String(row.status || '') !== 'active' || Number(row.balance || 0) <= 0) {
            const err = new Error('Gift card is not active.');
            err.code = 'CARD_INACTIVE';
            throw err;
        }
        const currentBalance = roundMoney(row.balance || 0);
        if (amount > currentBalance) {
            const err = new Error('Gift card balance is too low.');
            err.code = 'INSUFFICIENT_BALANCE';
            err.balance = Number(currentBalance || 0);
            throw err;
        }
        const nextBalance = roundMoney(currentBalance - amount);
        const nextStatus = nextBalance <= 0 ? 'redeemed' : 'active';
        const now = new Date().toISOString();
        await conn.query(
            `UPDATE giftcards
             SET status = ?, balance = ?
             WHERE number = ?;`,
            [nextStatus, nextBalance, number]
        );
        const txnId = `txn-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        await conn.query(
            `INSERT INTO giftcard_transactions
                (id, number, type, amount, balance_after, cashier, receipt_number, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [txnId, number, 'redeem', amount, nextBalance, cashier, receiptNumber, note, toDbDate(now)]
        );
        await conn.commit();
        const card = {
            number,
            bookId: String(row.bookId || '').trim(),
            status: nextStatus,
            balance: nextBalance,
            initialValue: roundMoney(row.initialValue || 0),
            soldAt: fromDbDate(row.soldAt),
            soldBy: String(row.soldBy || '').trim(),
            soldReceipt: String(row.soldReceipt || '').trim(),
            note: String(row.note || '')
        };
        return { ok: true, card };
    } catch (err) {
        try { await conn.rollback(); } catch (_) { }
        throw err;
    } finally {
        conn.release();
    }
}

async function lookupGiftCard(payload) {
    const number = normalizeGiftCardNumber(payload?.number);
    if (!number) return null;
    const pool = getPool();
    if (!pool) {
        const data = await loadGiftCards();
        const card = data.cards.find(c => normalizeGiftCardNumber(c.number) === number) || null;
        if (!card) return null;
        const history = data.transactions.filter(t => normalizeGiftCardNumber(t.number) === number);
        return { card, transactions: history };
    }
    const [cardRows] = await pool.query(
        `SELECT number, book_id AS bookId, status, balance, initial_value AS initialValue,
                sold_at AS soldAt, sold_by AS soldBy, sold_receipt AS soldReceipt, note
         FROM giftcards WHERE number = ? LIMIT 1;`,
        [number]
    );
    const row = Array.isArray(cardRows) ? cardRows[0] : null;
    if (!row) return null;
    const [txnRows] = await pool.query(
        `SELECT id, number, type, amount, balance_after AS balanceAfter, cashier,
                receipt_number AS receiptNumber, note, created_at AS createdAt
         FROM giftcard_transactions
         WHERE number = ?
         ORDER BY created_at ASC;`,
        [number]
    );
    const card = {
        number,
        bookId: String(row.bookId || '').trim(),
        status: String(row.status || '').trim(),
        balance: roundMoney(row.balance || 0),
        initialValue: roundMoney(row.initialValue || 0),
        soldAt: fromDbDate(row.soldAt),
        soldBy: String(row.soldBy || '').trim(),
        soldReceipt: String(row.soldReceipt || '').trim(),
        note: String(row.note || '')
    };
    const transactions = (txnRows || []).map(txn => ({
        id: String(txn.id || '').trim(),
        number: normalizeGiftCardNumber(txn.number),
        type: String(txn.type || '').trim(),
        amount: roundMoney(txn.amount || 0),
        balanceAfter: roundMoney(txn.balanceAfter || 0),
        cashier: String(txn.cashier || '').trim(),
        receiptNumber: String(txn.receiptNumber || '').trim(),
        note: String(txn.note || '').trim(),
        createdAt: fromDbDate(txn.createdAt)
    }));
    return { card, transactions };
}

module.exports = {
    loadGiftCards,
    saveGiftCards,
    addGiftCardBook,
    sellGiftCard,
    redeemGiftCard,
    lookupGiftCard
};

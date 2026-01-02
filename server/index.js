require('dotenv').config();
const express = require('express');
const session = require('express-session');
const MySQLStore = require('connect-mysql2')(session);
const path = require('path');
const { getPool } = require('./db');
const { resolveDataDir } = require('./storage');
const {
    listReceipts,
    countReceipts,
    getReceiptById,
    addReceipt,
    markVoid,
    markReturn,
    replaceAll
} = require('./receipts-store');
const {
    loadGiftCards,
    saveGiftCards,
    addGiftCardBook,
    sellGiftCard,
    redeemGiftCard,
    lookupGiftCard
} = require('./giftcards-store');
const { readReceipts } = require('./storage');
const {
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
} = require('./catalog-store');
const { getAppConfigStatus, changePasswords, validateManagerPassword } = require('./app-config');
const { loadSchedule, saveSchedule } = require('./schedule-store');
const { getDrawer, saveOpening, saveClosing, approveDrawer, listDrawers } = require('./drawer-store');
const { countUsers, countAdmins, listUsers, createUser, updateUser, resetPassword, authenticate, roleRank } = require('./users-store');

const app = express();
const port = Number(process.env.PORT) || 3001;
let latestCustomerCartState = null;
const customerCartClients = new Set();

const SESSION_SECRET = String(process.env.SESSION_SECRET || '').trim();
if (!SESSION_SECRET) {
    console.warn('[auth] SESSION_SECRET is not set. Sessions will not be secure.');
}

function isHtmlRequest(req) {
    const url = String(req.path || '');
    if (url === '/' || url.endsWith('.html')) return true;
    return false;
}

function isPublicAsset(req) {
    const url = String(req.path || '');
    if (url.startsWith('/api')) return false;
    if (url.startsWith('/assets')) return true;
    if (url.startsWith('/css')) return true;
    if (url.startsWith('/js')) return true;
    if (url.startsWith('/node_modules')) return true;
    if (url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.jpeg') || url.endsWith('.gif') || url.endsWith('.svg')) return true;
    if (url.endsWith('.ico') || url.endsWith('.webp')) return true;
    if (url.endsWith('.css') || url.endsWith('.js')) return true;
    if (url.endsWith('.map')) return true;
    return false;
}

async function hasUsers() {
    try {
        const count = await countUsers();
        return count > 0;
    } catch (_) {
        return false;
    }
}

function userFromSession(req) {
    return req.session?.user || null;
}

function requireAuth(req, res, next) {
    const user = userFromSession(req);
    if (!user) {
        return res.status(401).json({ error: 'Authentication required.' });
    }
    return next();
}

function requireRole(minRole) {
    return (req, res, next) => {
        const user = userFromSession(req);
        if (!user) return res.status(401).json({ error: 'Authentication required.' });
        const current = roleRank(user.role);
        if (current < roleRank(minRole)) {
            return res.status(403).json({ error: 'Insufficient permissions.' });
        }
        return next();
    };
}

app.use(express.json({ limit: '50mb' }));

const pool = getPool();
const sessionStore = pool
    ? new MySQLStore(
        {
            clearExpired: true,
            checkExpirationInterval: 15 * 60 * 1000,
            expiration: 4 * 60 * 60 * 1000
        },
        pool
    )
    : null;

app.use(session({
    secret: SESSION_SECRET || 'tillmere-dev-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: sessionStore || undefined,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 4 * 60 * 60 * 1000
    }
}));

app.use(async (req, res, next) => {
    try {
        if (req.path.startsWith('/api')) return next();
        if (isPublicAsset(req)) return next();
        const usersExist = await hasUsers();
        const user = userFromSession(req);
        if (req.path === '/setup.html') {
            if (usersExist) return res.redirect('/login.html');
            return next();
        }
        if (req.path === '/login.html') {
            if (!usersExist) return res.redirect('/setup.html');
            return next();
        }
        if (!usersExist && isHtmlRequest(req)) {
            return res.redirect('/setup.html');
        }
        if (!user && isHtmlRequest(req)) {
            return res.redirect('/login.html');
        }
        return next();
    } catch (err) {
        return next();
    }
});

app.use(express.static(path.resolve(__dirname, '..'), { index: 'index.html' }));

app.get('/api/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'middletons-web',
        uptime: process.uptime(),
        dataDir: resolveDataDir()
    });
});

app.get('/api/auth/me', (req, res) => {
    const user = userFromSession(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });
    res.json(user);
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const username = String(req.body?.username || '').trim();
        const password = String(req.body?.password || '');
        const user = await authenticate(username, password);
        if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
        req.session.user = user;
        res.json({ ok: true, user });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.post('/api/auth/logout', (req, res) => {
    try {
        req.session.destroy(() => {
            res.json({ ok: true });
        });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.post('/api/setup', async (req, res) => {
    try {
        const usersExist = await hasUsers();
        if (usersExist) return res.status(409).json({ error: 'Setup already completed.' });
        const payload = {
            username: req.body?.username,
            displayName: req.body?.displayName,
            password: req.body?.password,
            role: 'admin'
        };
        const user = await createUser(payload);
        if (!user) return res.status(500).json({ error: 'Failed to create admin user.' });
        req.session.user = user;
        res.json({ ok: true, user });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.use('/api', (req, res, next) => {
    if (req.path === '/health') return next();
    if (req.path.startsWith('/auth/')) return next();
    if (req.path === '/setup') return next();
    return requireAuth(req, res, next);
});

function broadcastCustomerCartEvent(type, payload) {
    const message = `event: ${type}\n` + `data: ${JSON.stringify(payload)}\n\n`;
    customerCartClients.forEach((client) => {
        try { client.write(message); } catch (_) { }
    });
}

app.get('/api/customer-cart', (_req, res) => {
    res.json(latestCustomerCartState || null);
});
app.post('/api/customer-cart', (req, res) => {
    latestCustomerCartState = req.body || null;
    broadcastCustomerCartEvent('cart', latestCustomerCartState || null);
    res.json({ ok: true });
});
app.post('/api/customer-cart/refresh', (_req, res) => {
    broadcastCustomerCartEvent('refresh', { ok: true, ts: Date.now() });
    res.json({ ok: true });
});
app.get('/api/customer-cart/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
    });
    res.write('\n');
    customerCartClients.add(res);
    if (latestCustomerCartState) {
        try {
            res.write(`event: cart\ndata: ${JSON.stringify(latestCustomerCartState)}\n\n`);
        } catch (_) { }
    }
    req.on('close', () => {
        customerCartClients.delete(res);
    });
});

app.get('/api/receipts', async (_req, res) => {
    try {
        const receipts = await listReceipts();
        res.json(Array.isArray(receipts) ? receipts : []);
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/receipts/:id', async (req, res) => {
    try {
        const needle = String(req.params.id || '').trim();
        if (!needle) return res.status(404).json({ error: 'Not found' });
        const match = await getReceiptById(needle);
        if (!match) return res.status(404).json({ error: 'Not found' });
        return res.json(match);
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/receipts', async (req, res) => {
    try {
        const saved = await addReceipt(req.body || {});
        if (!saved) return res.status(400).json({ error: 'Invalid receipt payload.' });
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/receipts/void', async (req, res) => {
    try {
        const updated = await markVoid(req.body || {});
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/receipts/return', async (req, res) => {
    try {
        const updated = await markReturn(req.body || {});
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/vendors', async (_req, res) => {
    try {
        const vendors = await listVendors();
        res.json(Array.isArray(vendors) ? vendors : []);
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/vendors', async (req, res) => {
    try {
        const vendor = await createVendor(req.body);
        res.json(vendor);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.put('/api/vendors/:code', async (req, res) => {
    try {
        const vendor = await updateVendor(req.params.code, req.body);
        res.json(vendor);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.delete('/api/vendors/:code', async (req, res) => {
    try {
        await deleteVendor(req.params.code);
        res.json({ ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/cashiers', async (_req, res) => {
    try {
        const cashiers = await listCashiers();
        res.json(Array.isArray(cashiers) ? cashiers : []);
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});
app.put('/api/cashiers', async (req, res) => {
    try {
        const saved = await saveCashiers(req.body);
        res.json(Array.isArray(saved) ? saved : []);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/cashiers/:name/pin', requireRole('manager'), async (req, res) => {
    try {
        const payload = req.body || {};
        const result = await setCashierPin(req.params.name, payload.pin, payload.currentPin);
        res.json(result || { ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.delete('/api/cashiers/:name/pin', requireRole('admin'), async (req, res) => {
    try {
        const result = await resetCashierPin(req.params.name);
        res.json(result || { ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/settings', async (_req, res) => {
    try {
        const settings = await loadSettings();
        res.json(settings && typeof settings === 'object' ? settings : {});
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/giftcards', (_req, res) => {
    try {
        const data = loadGiftCards();
        res.json(data || { books: [], cards: [], transactions: [] });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/giftcards/books', (req, res) => {
    try {
        const result = addGiftCardBook(req.body || {});
        res.json(result || { ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error), code: error?.code });
    }
});
app.post('/api/giftcards/sell', (req, res) => {
    try {
        const result = sellGiftCard(req.body || {});
        res.json(result || { ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error), code: error?.code, balance: error?.balance });
    }
});
app.post('/api/giftcards/redeem', (req, res) => {
    try {
        const result = redeemGiftCard(req.body || {});
        res.json(result || { ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error), code: error?.code, balance: error?.balance });
    }
});
app.post('/api/giftcards/lookup', (req, res) => {
    try {
        const result = lookupGiftCard(req.body || {});
        res.json(result || null);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveSettingsPatch(req.body);
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/tax', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveTaxSettings(req.body?.taxRate);
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/gift-card-surcharge', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveGiftCardSurcharge(req.body?.giftCardSurchargeRate);
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/silent', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveSilentSettings(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/branding', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveBrandingSettings(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/discount-reasons', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveDiscountReasons(req.body?.discountReasons || req.body || []);
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/denomination-targets', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveDenominationTargets(req.body?.denominationTargets || req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/tax-exempt-orgs', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveTaxExemptOrgs(req.body?.taxExemptOrgs || req.body || []);
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/vendor-promotions', requireRole('manager'), async (req, res) => {
    try {
        const saved = await saveVendorPromotions(req.body?.vendorPromotions || req.body || []);
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/developer-mode', requireRole('admin'), async (req, res) => {
    try {
        const saved = await saveDeveloperMode(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/customer-display', requireRole('manager'), async (req, res) => {
    try {
        const enabled = !!req.body?.customerDisplayEnabled;
        const saved = await saveSettingsPatch({ customerDisplayEnabled: enabled });
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/settings/manager-mode', requireRole('admin'), async (req, res) => {
    try {
        const ok = validateManagerPassword(req.body?.password || '');
        if (!ok) return res.status(403).json({ error: 'Invalid manager password.' });
        res.json({ ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/app-config/status', (_req, res) => {
    res.json(getAppConfigStatus());
});
app.post('/api/app-config/passwords', requireRole('admin'), (req, res) => {
    try {
        const result = changePasswords(req.body || {});
        res.json(result || { ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error), code: error?.code });
    }
});

app.get('/api/admin/users', requireRole('admin'), async (_req, res) => {
    try {
        const users = await listUsers();
        res.json(Array.isArray(users) ? users : []);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.post('/api/admin/users', requireRole('admin'), async (req, res) => {
    try {
        const created = await createUser(req.body || {});
        res.json(created);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.put('/api/admin/users/:id', requireRole('admin'), async (req, res) => {
    try {
        const nextRole = String(req.body?.role || '').trim().toLowerCase();
        if (nextRole === 'admin') {
            // allow promotion without checks
        } else {
            const adminCount = await countAdmins();
            const userId = Number(req.params.id);
            const currentUser = await listUsers().then(list => list.find(u => Number(u.id) === userId));
            if (currentUser?.role === 'admin' && adminCount <= 1) {
                return res.status(409).json({ error: 'At least one admin account is required.' });
            }
        }
        const updated = await updateUser(req.params.id, req.body || {});
        res.json(updated);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.post('/api/admin/users/:id/password', requireRole('admin'), async (req, res) => {
    try {
        await resetPassword(req.params.id, req.body?.password || '');
        res.json({ ok: true });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/version', (_req, res) => {
    try {
        const pkg = require('../package.json');
        res.json({ version: String(pkg?.version || '') });
    } catch (_) {
        res.json({ version: '' });
    }
});

app.get('/api/schedule', (_req, res) => {
    try {
        res.json(loadSchedule());
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/schedule', (req, res) => {
    try {
        const saved = saveSchedule(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/drawer', async (req, res) => {
    try {
        const date = String(req.query?.date || '').trim();
        const state = await getDrawer(date);
        res.json(state || null);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/drawer/opening', async (req, res) => {
    try {
        const saved = await saveOpening(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/drawer/closing', async (req, res) => {
    try {
        const saved = await saveClosing(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/drawer/approve', async (req, res) => {
    try {
        const saved = await approveDrawer(req.body || {});
        res.json(saved);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});
app.get('/api/drawer/list', async (req, res) => {
    try {
        const startDate = String(req.query?.startDate || '').trim();
        const endDate = String(req.query?.endDate || '').trim();
        const rows = await listDrawers({ startDate, endDate });
        res.json(Array.isArray(rows) ? rows : []);
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/backup/export', requireRole('admin'), async (_req, res) => {
    try {
        const vendors = await listVendors();
        const cashiers = await listCashiers();
        const receipts = await listReceipts();
        const settings = await loadSettings();
        const giftCards = loadGiftCards();
        res.json({
            vendors: Array.isArray(vendors) ? vendors : [],
            cashiers: Array.isArray(cashiers) ? cashiers : [],
            receipts: Array.isArray(receipts) ? receipts : [],
            settings: settings && typeof settings === 'object' ? settings : {},
            giftCards: giftCards && typeof giftCards === 'object' ? giftCards : { books: [], cards: [], transactions: [] }
        });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});
app.post('/api/backup/import', requireRole('admin'), async (req, res) => {
    try {
        const payload = req.body || {};
        const vendors = Array.isArray(payload.vendors) ? payload.vendors : [];
        const cashiers = Array.isArray(payload.cashiers) ? payload.cashiers : [];
        const receipts = Array.isArray(payload.receipts) ? payload.receipts : [];
        const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
        const giftCards = payload.giftCards && typeof payload.giftCards === 'object' ? payload.giftCards : null;
        await saveSettingsPatch(settings);
        await saveCashiers(cashiers);
        await replaceAll(receipts);
        for (const vendor of vendors) {
            try {
                await createVendor(vendor);
            } catch (err) {
                if (err?.status === 409) {
                    await updateVendor(vendor.code, vendor);
                }
            }
        }
        if (giftCards) {
            saveGiftCards(giftCards);
        }
        res.json({
            ok: true,
            counts: {
                vendors: vendors.length,
                cashiers: cashiers.length,
                receipts: receipts.length,
                giftCards: giftCards ? (giftCards.cards || []).length : 0
            }
        });
    } catch (error) {
        res.status(error?.status || 500).json({ error: error?.message || String(error) });
    }
});

app.get('/api/debug/receipts-counts', async (_req, res) => {
    try {
        const jsonReceipts = readReceipts();
        const mysqlReceipts = await listReceipts();
        const jsonCount = Array.isArray(jsonReceipts) ? jsonReceipts.length : 0;
        const mysqlCount = Array.isArray(mysqlReceipts) ? mysqlReceipts.length : 0;
        const mysqlRowCount = await countReceipts();
        const sample = mysqlReceipts?.[0] || jsonReceipts?.[0] || null;
        res.json({
            jsonCount,
            mysqlCount,
            mysqlRowCount,
            sample: sample ? { id: sample.id || null, number: sample.number || null } : null
        });
    } catch (error) {
        res.status(500).json({ error: error?.message || String(error) });
    }
});

app.listen(port, () => {
    console.log(`[web] listening on http://localhost:${port}`);
});

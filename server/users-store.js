const bcrypt = require('bcryptjs');
const { getPool } = require('./db');

const ROLE_ORDER = {
    cashier: 1,
    manager: 2,
    admin: 3
};

function normalizeRole(role) {
    const val = String(role || '').trim().toLowerCase();
    return ROLE_ORDER[val] ? val : 'cashier';
}

function createError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

async function countUsers() {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const [rows] = await pool.query('SELECT COUNT(1) as count FROM users;');
    return Number(rows?.[0]?.count || 0);
}

async function listUsers() {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const [rows] = await pool.query('SELECT id, username, displayName, role, createdAt, updatedAt FROM users ORDER BY username ASC;');
    return Array.isArray(rows) ? rows : [];
}

async function countAdmins() {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const [rows] = await pool.query('SELECT COUNT(1) as count FROM users WHERE role = "admin";');
    return Number(rows?.[0]?.count || 0);
}

async function getUserByUsername(username) {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const [rows] = await pool.query(
        'SELECT id, username, displayName, role, passwordHash FROM users WHERE LOWER(username) = LOWER(:username) LIMIT 1;',
        { username: String(username || '').trim() }
    );
    return Array.isArray(rows) ? rows[0] : null;
}

async function getUserById(id) {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const [rows] = await pool.query(
        'SELECT id, username, displayName, role, passwordHash FROM users WHERE id = :id LIMIT 1;',
        { id: Number(id) }
    );
    return Array.isArray(rows) ? rows[0] : null;
}

async function createUser(payload) {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const username = String(payload?.username || '').trim();
    const displayName = String(payload?.displayName || '').trim();
    const role = normalizeRole(payload?.role);
    const password = String(payload?.password || '');
    if (!username) throw createError(400, 'Username is required.');
    if (!password) throw createError(400, 'Password is required.');
    const existing = await getUserByUsername(username);
    if (existing) throw createError(409, 'Username already exists.');
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
        'INSERT INTO users (username, displayName, role, passwordHash) VALUES (:username, :displayName, :role, :passwordHash);',
        { username, displayName, role, passwordHash }
    );
    const user = await getUserByUsername(username);
    return user ? { id: user.id, username: user.username, displayName: user.displayName, role: user.role } : null;
}

async function updateUser(id, payload) {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const userId = Number(id);
    if (!Number.isFinite(userId)) throw createError(400, 'Invalid user.');
    const displayName = String(payload?.displayName || '').trim();
    const role = normalizeRole(payload?.role);
    await pool.query(
        'UPDATE users SET displayName = :displayName, role = :role WHERE id = :id LIMIT 1;',
        { displayName, role, id: userId }
    );
    const user = await getUserById(userId);
    return user ? { id: user.id, username: user.username, displayName: user.displayName, role: user.role } : null;
}

async function resetPassword(id, newPassword) {
    const pool = getPool();
    if (!pool) throw createError(500, 'MySQL is not configured.');
    const userId = Number(id);
    if (!Number.isFinite(userId)) throw createError(400, 'Invalid user.');
    const password = String(newPassword || '');
    if (!password) throw createError(400, 'Password is required.');
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
        'UPDATE users SET passwordHash = :passwordHash WHERE id = :id LIMIT 1;',
        { passwordHash, id: userId }
    );
    return true;
}

async function authenticate(username, password) {
    const user = await getUserByUsername(username);
    if (!user || !user.passwordHash) return null;
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
    if (!ok) return null;
    return { id: user.id, username: user.username, displayName: user.displayName, role: user.role };
}

function roleRank(role) {
    return ROLE_ORDER[normalizeRole(role)];
}

module.exports = {
    countUsers,
    countAdmins,
    listUsers,
    createUser,
    updateUser,
    resetPassword,
    authenticate,
    roleRank
};

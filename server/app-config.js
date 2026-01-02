const fs = require('fs');
const path = require('path');

const APP_CONFIG_FILE = path.join(__dirname, '..', 'config', 'app-config.json');
const DEFAULTS = { developerPassword: 'middleton', managerPassword: 'middleton' };

function readAppConfig() {
    try {
        if (!fs.existsSync(APP_CONFIG_FILE)) return { ...DEFAULTS };
        const raw = fs.readFileSync(APP_CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULTS, ...(parsed || {}) };
    } catch (_) {
        return { ...DEFAULTS };
    }
}

function writeAppConfig(data) {
    try {
        fs.mkdirSync(path.dirname(APP_CONFIG_FILE), { recursive: true });
        fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (_) {
        return false;
    }
}

function saveAppConfig(patch) {
    const current = readAppConfig();
    const next = { ...current, ...(patch || {}) };
    if (!next.managerPassword) next.managerPassword = next.developerPassword;
    writeAppConfig(next);
    return next;
}

function getAppConfigStatus() {
    try {
        const exists = fs.existsSync(APP_CONFIG_FILE);
        return { exists, encrypted: false, encryptionAvailable: false };
    } catch (_) {
        return { exists: false, encrypted: false, encryptionAvailable: false };
    }
}

function validateDeveloperPassword(password) {
    const config = readAppConfig();
    const expected = String(config?.developerPassword || '');
    return expected && String(password || '') === expected;
}

function validateManagerPassword(password) {
    const config = readAppConfig();
    const expected = String(config?.managerPassword || config?.developerPassword || '');
    return expected && String(password || '') === expected;
}

function changePasswords(payload = {}) {
    const current = readAppConfig();
    const updated = {};
    if (payload.newDeveloper) {
        if (String(payload.currentDeveloper || '') !== String(current.developerPassword || '')) {
            const err = new Error('Invalid current developer password.');
            err.status = 403;
            err.code = 'INVALID_CURRENT_DEV_PASSWORD';
            throw err;
        }
        updated.developerPassword = String(payload.newDeveloper || '');
        updated.managerPassword = String(payload.newManager || current.managerPassword || updated.developerPassword || '');
    }
    if (payload.newManager) {
        if (String(payload.currentManager || '') !== String(current.managerPassword || current.developerPassword || '')) {
            const err = new Error('Invalid current manager password.');
            err.status = 403;
            err.code = 'INVALID_CURRENT_MANAGER_PASSWORD';
            throw err;
        }
        updated.managerPassword = String(payload.newManager || '');
    }
    if (!updated.developerPassword && !updated.managerPassword) {
        return { ok: false, message: 'No password changes applied.' };
    }
    const saved = saveAppConfig(updated);
    return {
        ok: true,
        updated: {
            developer: !!updated.developerPassword,
            manager: !!updated.managerPassword
        },
        encryption: getAppConfigStatus(),
        config: { hasManagerPassword: !!saved.managerPassword }
    };
}

module.exports = {
    readAppConfig,
    saveAppConfig,
    getAppConfigStatus,
    validateDeveloperPassword,
    validateManagerPassword,
    changePasswords
};

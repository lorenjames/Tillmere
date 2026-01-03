const fs = require('fs');
const path = require('path');
const { resolveDataDir } = require('./storage');

const DEFAULT_STORE_HOURS = { start: '10:00', end: '18:00' };
const DEFAULT_BASE_SHIFTS = [
    { name: 'Morning Shift', start: '10:00', end: '14:00' },
    { name: 'Afternoon Shift', start: '14:00', end: '18:00' }
];
const DEFAULT_BASE_HOURS = {
    '0': { start: '13:00', end: '16:00' }, // Sunday
    '3': { start: '11:00', end: '17:30' }, // Wednesday
    '4': { start: '11:00', end: '17:30' }, // Thursday
    '5': { start: '11:00', end: '17:30' }, // Friday
    '6': { start: '10:00', end: '16:00' }  // Saturday
};

function scheduleFile() {
    return path.join(resolveDataDir(), 'schedule.json');
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        const raw = fs.readFileSync(file, 'utf-8');
        const data = JSON.parse(raw);
        return data ?? fallback;
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

function sanitizeTimeString(value, fallback = '') {
    const candidate = String(value || '').trim();
    const match = /^(\d{2}):(\d{2})$/.exec(candidate);
    if (!match) return fallback;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return fallback;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeStoreHours(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        start: sanitizeTimeString(source.start, DEFAULT_STORE_HOURS.start),
        end: sanitizeTimeString(source.end, DEFAULT_STORE_HOURS.end)
    };
}

function normalizeBaseShifts(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const normalized = arr.map((shift, index) => {
        const source = shift && typeof shift === 'object' ? shift : {};
        const name = String(source.name || `Shift ${index + 1}`).trim();
        const start = sanitizeTimeString(source.start, DEFAULT_STORE_HOURS.start);
        const end = sanitizeTimeString(source.end, DEFAULT_STORE_HOURS.end);
        if (!name || !start || !end) return null;
        return { name, start, end };
    }).filter(Boolean);
    if (normalized.length) return normalized;
    return DEFAULT_BASE_SHIFTS.map(shift => ({ ...shift }));
}

function normalizeSpecialHours(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const cleaned = arr.map(entry => {
        const source = entry && typeof entry === 'object' ? entry : {};
        const date = String(source.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
        const start = sanitizeTimeString(source.start, '');
        const end = sanitizeTimeString(source.end, '');
        if (!start || !end) return null;
        return {
            date,
            start,
            end,
            label: String(source.label || '').trim()
        };
    }).filter(Boolean);
    cleaned.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return cleaned;
}

function normalizeBaseHours(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    const result = {};
    if (source) {
        Object.entries(source).forEach(([key, value]) => {
            const day = String(key || '').trim();
            if (!/^[0-6]$/.test(day)) return;
            const start = sanitizeTimeString(value?.start, '');
            const end = sanitizeTimeString(value?.end, '');
            if (!start || !end) return;
            result[day] = { start, end };
        });
    }
    if (Object.keys(result).length) return result;
    if (source) return {};
    const clone = {};
    Object.entries(DEFAULT_BASE_HOURS).forEach(([key, val]) => {
        clone[key] = { start: val.start, end: val.end };
    });
    return clone;
}

function normalizeAssignments(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const result = {};
    Object.entries(raw).forEach(([date, shifts]) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '').trim())) return;
        if (!shifts || typeof shifts !== 'object') return;
        const day = {};
        Object.entries(shifts).forEach(([shiftName, cashier]) => {
            const cleanShift = String(shiftName || '').trim();
            const cleanCashier = String(cashier || '').trim();
            if (!cleanShift || !cleanCashier) return;
            day[cleanShift] = cleanCashier;
        });
        if (Object.keys(day).length) result[date] = day;
    });
    return result;
}

function normalizeSchedule(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
        storeHours: normalizeStoreHours(source.storeHours),
        baseShifts: normalizeBaseShifts(source.baseShifts),
        specialHours: normalizeSpecialHours(source.specialHours),
        baseHours: normalizeBaseHours(source.baseHours),
        assignments: normalizeAssignments(source.assignments)
    };
}

function loadSchedule() {
    const raw = readJson(scheduleFile(), null);
    return normalizeSchedule(raw);
}

function saveSchedule(patch) {
    const current = loadSchedule();
    const source = patch && typeof patch === 'object' ? patch : {};
    const next = {
        storeHours: Object.prototype.hasOwnProperty.call(source, 'storeHours')
            ? normalizeStoreHours(source.storeHours)
            : current.storeHours,
        baseShifts: Object.prototype.hasOwnProperty.call(source, 'baseShifts')
            ? normalizeBaseShifts(source.baseShifts)
            : current.baseShifts,
        specialHours: Object.prototype.hasOwnProperty.call(source, 'specialHours')
            ? normalizeSpecialHours(source.specialHours)
            : current.specialHours,
        baseHours: Object.prototype.hasOwnProperty.call(source, 'baseHours')
            ? normalizeBaseHours(source.baseHours)
            : current.baseHours,
        assignments: Object.prototype.hasOwnProperty.call(source, 'assignments')
            ? normalizeAssignments(source.assignments)
            : current.assignments
    };
    writeJson(scheduleFile(), next);
    return next;
}

module.exports = {
    loadSchedule,
    saveSchedule
};

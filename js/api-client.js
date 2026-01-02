(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.MiddletonsApiClient = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    let ipcRenderer = null;
    if (typeof require === 'function') {
        try {
            const electron = require('electron');
            ipcRenderer = electron?.ipcRenderer || null;
        } catch (_) { }
    }

    function getApiBase() {
        if (typeof window !== 'undefined' && window.MIDDLETONS_API_BASE) {
            return String(window.MIDDLETONS_API_BASE).trim();
        }
        if (typeof window !== 'undefined' && window.location) {
            const protocol = String(window.location.protocol || '').toLowerCase();
            if (protocol === 'http:' || protocol === 'https:') {
                return String(window.location.origin || '').trim();
            }
        }
        if (typeof process !== 'undefined' && process?.env?.MIDDLETONS_API_BASE) {
            return String(process.env.MIDDLETONS_API_BASE).trim();
        }
        return '';
    }

    function normalizeBase(base) {
        return base.replace(/\/+$/, '');
    }

    async function httpRequest(method, path, body) {
        const apiBase = normalizeBase(getApiBase());
        if (!apiBase) throw new Error('API base is not configured.');
        const url = `${apiBase}${path}`;
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        };
        if (body !== undefined) options.body = JSON.stringify(body);
        const resp = await fetch(url, options);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            let message = text || resp.statusText;
            let code = null;
            try {
                const parsed = text ? JSON.parse(text) : null;
                if (parsed && typeof parsed === 'object') {
                    message = parsed.error || parsed.message || message;
                    code = parsed.code || null;
                }
            } catch (_) { }
            const err = new Error(`API ${resp.status}: ${message || resp.statusText}`);
            err.status = resp.status;
            if (code) err.code = code;
            throw err;
        }
        return resp.json();
    }

    async function httpInvoke(channel, args) {
        switch (channel) {
            case 'receipts:load':
                return httpRequest('GET', '/api/receipts');
            case 'receipts:get': {
                const id = String(args[0] || '').trim();
                return httpRequest('GET', `/api/receipts/${encodeURIComponent(id)}`);
            }
            case 'receipts:add':
                return httpRequest('POST', '/api/receipts', args[0] || {});
            case 'receipts:void':
                return httpRequest('POST', '/api/receipts/void', args[0] || {});
            case 'receipts:return':
                return httpRequest('POST', '/api/receipts/return', args[0] || {});
            case 'vendors:load':
                return httpRequest('GET', '/api/vendors');
            case 'vendors:create':
                return httpRequest('POST', '/api/vendors', args[0] || {});
            case 'vendors:update': {
                const previousCode = String(args[0] || '').trim();
                if (!previousCode) throw new Error('Vendor code is required.');
                return httpRequest('PUT', `/api/vendors/${encodeURIComponent(previousCode)}`, args[1] || {});
            }
            case 'vendors:delete': {
                const code = String(args[0] || '').trim();
                if (!code) throw new Error('Vendor code is required.');
                return httpRequest('DELETE', `/api/vendors/${encodeURIComponent(code)}`);
            }
            case 'cashiers:load':
                return httpRequest('GET', '/api/cashiers');
            case 'cashiers:save':
                return httpRequest('PUT', '/api/cashiers', args[0] || []);
            case 'cashiers:setPin': {
                const name = String(args[0]?.name || '').trim();
                if (!name) throw new Error('Cashier name is required.');
                const payload = { pin: args[0]?.pin, currentPin: args[0]?.currentPin };
                return httpRequest('POST', `/api/cashiers/${encodeURIComponent(name)}/pin`, payload);
            }
            case 'cashiers:resetPin': {
                const name = String(args[0]?.name || '').trim();
                if (!name) throw new Error('Cashier name is required.');
                return httpRequest('DELETE', `/api/cashiers/${encodeURIComponent(name)}/pin`);
            }
            case 'settings:load':
                return httpRequest('GET', '/api/settings');
            case 'giftcards:load':
                return httpRequest('GET', '/api/giftcards');
            case 'giftcards:addBook':
                return httpRequest('POST', '/api/giftcards/books', args[0] || {});
            case 'giftcards:sell':
                return httpRequest('POST', '/api/giftcards/sell', args[0] || {});
            case 'giftcards:redeem':
                return httpRequest('POST', '/api/giftcards/redeem', args[0] || {});
            case 'giftcards:lookup':
                return httpRequest('POST', '/api/giftcards/lookup', args[0] || {});
            case 'settings:save':
                return httpRequest('POST', '/api/settings', args[0] || {});
            case 'settings:saveTax':
                return httpRequest('POST', '/api/settings/tax', args[0] || {});
            case 'settings:saveGiftCardSurcharge':
                return httpRequest('POST', '/api/settings/gift-card-surcharge', args[0] || {});
            case 'settings:saveSilent':
                return httpRequest('POST', '/api/settings/silent', args[0] || {});
            case 'settings:saveBranding':
                return httpRequest('POST', '/api/settings/branding', args[0] || {});
            case 'settings:saveDiscountReasons':
                return httpRequest('POST', '/api/settings/discount-reasons', args[0] || {});
            case 'settings:saveDenominationTargets':
                return httpRequest('POST', '/api/settings/denomination-targets', args[0] || {});
            case 'settings:saveTaxExemptOrgs':
                return httpRequest('POST', '/api/settings/tax-exempt-orgs', args[0] || {});
            case 'settings:saveVendorPromotions':
                return httpRequest('POST', '/api/settings/vendor-promotions', args[0] || {});
            case 'settings:saveDev':
                return httpRequest('POST', '/api/settings/developer-mode', args[0] || {});
            case 'settings:disableDev':
                return httpRequest('POST', '/api/settings/developer-mode', { developerMode: false });
            case 'settings:saveCustomerDisplay':
                return httpRequest('POST', '/api/settings/customer-display', args[0] || {});
            case 'settings:enableManagerMode':
                return httpRequest('POST', '/api/settings/manager-mode', args[0] || {});
            case 'appConfig:status':
                return httpRequest('GET', '/api/app-config/status');
            case 'appConfig:changePasswords':
                return httpRequest('POST', '/api/app-config/passwords', args[0] || {});
            case 'app:getVersion': {
                const data = await httpRequest('GET', '/api/version');
                return data?.version || '';
            }
            case 'auth:me':
                return httpRequest('GET', '/api/auth/me');
            case 'auth:logout':
                return httpRequest('POST', '/api/auth/logout');
            case 'schedule:load':
                return httpRequest('GET', '/api/schedule');
            case 'schedule:save':
                return httpRequest('POST', '/api/schedule', args[0] || {});
            case 'print:listPrinters':
                return [];
            case 'print:silent':
                return false;
            case 'data:export':
                return httpRequest('GET', '/api/backup/export');
            case 'data:import':
                return httpRequest('POST', '/api/backup/import', args[0] || {});
            case 'drawer:get': {
                const date = String(args[0] || '').trim();
                const qs = date ? `?date=${encodeURIComponent(date)}` : '';
                return httpRequest('GET', `/api/drawer${qs}`);
            }
            case 'drawer:saveOpening':
                return httpRequest('POST', '/api/drawer/opening', args[0] || {});
            case 'drawer:saveClosing':
                return httpRequest('POST', '/api/drawer/closing', args[0] || {});
            case 'drawer:approve':
                return httpRequest('POST', '/api/drawer/approve', args[0] || {});
            case 'drawer:list': {
                const startDate = String(args[0]?.startDate || '').trim();
                const endDate = String(args[0]?.endDate || '').trim();
                const params = new URLSearchParams();
                if (startDate) params.set('startDate', startDate);
                if (endDate) params.set('endDate', endDate);
                const qs = params.toString();
                return httpRequest('GET', `/api/drawer/list${qs ? `?${qs}` : ''}`);
            }
            case 'customer-cart:request':
                return httpRequest('GET', '/api/customer-cart');
            case 'customer-cart:refresh':
                return httpRequest('POST', '/api/customer-cart/refresh', args[0] || {});
            case 'app:quit':
            case 'app:openUserGuide':
                return false;
            default:
                throw new Error(`Unsupported channel: ${channel}`);
        }
    }

    return {
        hasIpc: !!ipcRenderer,
        invoke: async (channel, ...args) => {
            if (ipcRenderer && typeof ipcRenderer.invoke === 'function') {
                return ipcRenderer.invoke(channel, ...args);
            }
            return httpInvoke(channel, args);
        },
        on: (channel, handler) => {
            if (ipcRenderer && typeof ipcRenderer.on === 'function') {
                ipcRenderer.on(channel, handler);
            }
        },
        send: (channel, ...args) => {
            if (ipcRenderer && typeof ipcRenderer.send === 'function') {
                ipcRenderer.send(channel, ...args);
                return;
            }
            if (channel === 'cart:state') {
                try {
                    httpRequest('POST', '/api/customer-cart', args[0] || {}).catch(() => { });
                } catch (_) { }
            }
        },
        off: (channel, handler) => {
            if (ipcRenderer && typeof ipcRenderer.removeListener === 'function') {
                ipcRenderer.removeListener(channel, handler);
            }
        }
    };
}));

const listeners = new Map();
const handlers = new Map();

const ipcRenderer = {
  invoke: jest.fn(async (channel, ...args) => {
    // Default mock responses; tests can override via mockImplementation
    if (channel === 'vendors:load') return [];
    if (channel === 'cashiers:load') return [{ name: 'Cashier' }];
    if (channel === 'print:silent') return true;
    return undefined;
  }),
  send: jest.fn(),
  on: (channel, cb) => {
    const arr = listeners.get(channel) || [];
    arr.push(cb);
    listeners.set(channel, arr);
  },
  // helper for tests to emit events
  __emit: (channel, ...args) => {
    const arr = listeners.get(channel) || [];
    arr.forEach(cb => {
      try { cb({}, ...args); } catch (_) { /* ignore */ }
    });
  }
};

// Minimal stubs used by main.js tests if imported
const app = {
  getPath: jest.fn(() => ''),
  whenReady: () => ({ then: () => {} })
};

const BrowserWindow = function () { return {}; };
BrowserWindow.getAllWindows = jest.fn(() => []);
const ipcMain = {
  handle: jest.fn((channel, fn) => { handlers.set(channel, fn); })
};
ipcMain.__handlers = handlers;
const dialog = { showSaveDialog: jest.fn(), showOpenDialog: jest.fn() };

module.exports = { ipcRenderer, app, BrowserWindow, ipcMain, dialog };

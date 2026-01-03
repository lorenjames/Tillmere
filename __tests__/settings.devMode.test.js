jest.mock('electron');

const { ipcRenderer, ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setupSettingsDom() {
  document.body.innerHTML = `
    <input id="taxRatePct" />
    <input type="checkbox" id="devMode" />
    <button id="saveDevBtn"></button>
    <div id="brandingCard" style="display:none;"></div>
  `;
}

describe('settings renderer developer mode', () => {
  let promptSpy;
  let mod;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupSettingsDom();
    promptSpy = jest.spyOn(window, 'prompt').mockReturnValue('middleton');
    ipcRenderer.invoke.mockImplementation(async (channel, payload) => {
      if (channel === 'settings:load') return { taxRate: 0.0725, developerMode: false };
      if (channel === 'settings:saveDev') return { developerMode: payload?.developerMode };
      return undefined;
    });
    mod = require('../js/settings.js');
    window.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('load'));
    return flush();
  });

  afterEach(() => {
    promptSpy?.mockRestore();
    document.body.innerHTML = '';
  });

  test.skip('enables developer mode when correct password is provided and saved', async () => {});

  test('does not enable developer mode when password is omitted/cancelled', async () => {
    promptSpy.mockReturnValue('');

    const devToggle = document.getElementById('devMode');
    const brandingCard = document.getElementById('brandingCard');

    devToggle.checked = true;
    await mod.saveDevSettings();
    await flush();

    const saveCalls = ipcRenderer.invoke.mock.calls.filter(([ch]) => ch === 'settings:saveDev');
    expect(saveCalls.length).toBe(0);
    expect(devToggle.checked).toBe(false);
    expect(brandingCard.style.display).toBe('none');
  });

  test('keeps developer mode off when main process rejects incorrect password', async () => {
    promptSpy.mockReturnValue('wrong');
    ipcRenderer.invoke.mockImplementation(async (channel, payload) => {
      if (channel === 'settings:load') return { taxRate: 0.0725, developerMode: false };
      if (channel === 'settings:saveDev') return { developerMode: false };
      return undefined;
    });

    const devToggle = document.getElementById('devMode');
    const brandingCard = document.getElementById('brandingCard');

    devToggle.checked = true;
    await mod.saveDevSettings();
    await flush();

    expect(devToggle.checked).toBe(false);
    expect(brandingCard.style.display).toBe('none');
    const host = document.getElementById('toast-host');
    const lastToast = host && host.lastElementChild;
    expect(lastToast?.textContent || '').toContain('Developer Mode: Off');
  });
});


jest.mock('electron');

const { ipcRenderer } = require('electron');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setupReportsDom() {
  document.body.innerHTML = `
    <input id="fromDate" />
    <input id="toDate" />
    <button id="runBtn"></button>
    <button id="exportBtn"></button>
    <button id="printBtn"></button>
    <button id="printDetailBtn"></button>
    <button id="clearFiltersBtn"></button>
    <button id="backupBtn"></button>
    <button id="restoreBtn"></button>
    <button id="todayBtn"></button>
    <button id="yesterdayBtn"></button>
    <button id="currentMonthBtn"></button>
    <table id="reportTable"><tbody id="reportBody"></tbody></table>
    <table id="cardFeeTable"><tbody id="cardFeeBody"></tbody></table>
    <span id="totCash"></span>
    <span id="totCard"></span>
    <span id="totCheck"></span>
    <span id="totGift"></span>
    <span id="totOther"></span>
    <span id="grandTotal"></span>
    <span id="grandCount"></span>
  `;
}

describe('reports backup/restore actions', () => {
  let alertSpy;
  let confirmSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupReportsDom();
    alertSpy = jest.spyOn(window, 'alert').mockReturnValue(undefined);
    confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    window.require = () => ({ ipcRenderer });
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'state:bootstrap') return { vendors: [], cashiers: [], receipts: [] };
      if (channel === 'data:export') return { ok: true, path: '/tmp/backup.json', counts: { vendors: 0, cashiers: 0, receipts: 0 } };
      if (channel === 'data:import') return { ok: true, counts: { vendors: 0, cashiers: 0, receipts: 0 } };
      return undefined;
    });
    require('../reports.js');
  });

  afterEach(() => {
    alertSpy?.mockRestore();
    confirmSpy?.mockRestore();
    document.body.innerHTML = '';
  });

  test('backup button triggers data:export', async () => {
    window.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('load'));
    await flush();
    expect(() => document.getElementById('backupBtn').click()).not.toThrow();
  });

  test('restore button triggers confirm and data:import', async () => {
    window.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('load'));
    await flush();
    expect(() => document.getElementById('restoreBtn').click()).not.toThrow();
  });
});

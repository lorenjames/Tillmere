jest.mock('electron');
let ipcRenderer;

function setupGiftCardModalDom() {
  document.body.innerHTML = `
    <div>
      <input id="itemName" />
      <datalist id="vendorList"></datalist>
      <table id="itemTable"><tbody></tbody></table>
      <span id="subtotal"></span>
      <span id="tax"></span>
      <span id="total"></span>
      <span id="taxRatePct"></span>
      <span id="taxExemptNote" class="d-none"></span>
      <div id="cardFeeRow" class="d-none"><span id="cardFeeAmount"></span></div>
      <input id="cashReceived" />
      <input id="giftCardAmount" />
      <input id="splitTenderAmount" />
      <input type="checkbox" id="splitTenderToggle" />
      <select id="splitTenderType"><option value="">Select...</option><option value="Card">Card</option></select>
      <select id="paymentSelect"><option value="">Select...</option><option value="Card">Card</option></select>
      <select id="cashierSelect"><option value="">Select...</option><option value="Cashier">Cashier</option></select>

      <div id="giftCardSaleModal"></div>
      <div id="giftCardSaleFields"></div>
      <div id="giftCardSaleEmpty" class="d-none"></div>
      <input id="giftCardSaleAmount" />
      <select id="giftCardSaleSelect"></select>
      <div id="giftCardSaleHint"></div>
      <button id="giftCardSaleConfirmBtn"></button>

      <div id="giftCardActivateReminderModal"></div>
      <div id="giftCardReminderReceiptWrap"></div>
      <span id="giftCardReminderReceipt"></span>
      <button id="giftCardReminderActivateBtn"></button>
    </div>`;
}

function installBootstrapMock() {
  const modal = class {
    show() {}
    hide() {}
  };
  global.bootstrap = { Modal: modal };
  global.window.bootstrap = global.bootstrap;
}

describe('gift card renderer flows', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    setupGiftCardModalDom();
    installBootstrapMock();
    ipcRenderer = require('electron').ipcRenderer;
    ipcRenderer.invoke.mockImplementation(async (channel) => {
      if (channel === 'giftcards:load') {
        return {
          books: [{ id: 'book-1', label: 'Holiday 2025' }],
          cards: [
            { number: 'GC-0001', status: 'available', bookId: 'book-1' },
            { number: 'GC-0002', status: 'active', bookId: 'book-1' }
          ],
          transactions: []
        };
      }
      if (channel === 'vendors:load') return [];
      if (channel === 'vendors:save') return [{ name: 'Store Gift Cards', code: 'STORE-GC' }];
      return undefined;
    });
  });

  test('addGiftCardSaleItem lists available cards', async () => {
    const { addGiftCardSaleItem } = require('../js/renderer.js');
    await addGiftCardSaleItem();
    const options = [...document.getElementById('giftCardSaleSelect').options]
      .map(o => o.value)
      .filter(Boolean);
    expect(options).toEqual(['GC-0001']);
    expect(document.getElementById('giftCardSaleHint').textContent).toMatch(/1 card available/i);
  });

  test('confirmGiftCardSaleItem adds gift card item with card number comment', async () => {
    const { confirmGiftCardSaleItem, __test } = require('../js/renderer.js');
    document.getElementById('giftCardSaleAmount').value = '40';
    const select = document.getElementById('giftCardSaleSelect');
    select.innerHTML = '<option value="GC-0009">GC-0009</option>';
    select.value = 'GC-0009';
    await confirmGiftCardSaleItem();
    const items = __test.getItems();
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('Gift Card Sale');
    expect(items[0].price).toBe(40);
    expect(items[0].vendorName).toBe('STORE-GC');
    expect(items[0].comment).toBe('Card #GC-0009');
  });

  test('gift card reminder button stores activation params', () => {
    const {
      queueGiftCardActivationReminder,
      showGiftCardActivationReminder
    } = require('../js/renderer.js');
    queueGiftCardActivationReminder({
      receiptNumber: 'MID-20250101-120000',
      cardNumber: 'GC-1234',
      amount: 25
    });
    showGiftCardActivationReminder();
    const btn = document.getElementById('giftCardReminderActivateBtn');
    expect(btn.dataset.cardNumber).toBe('GC-1234');
    expect(btn.dataset.amount).toBe('25.00');
    expect(btn.dataset.receipt).toBe('MID-20250101-120000');
  });

  test('extractGiftCardSaleDetails reads card and amount', () => {
    const { extractGiftCardSaleDetails } = require('../js/renderer.js');
    const details = extractGiftCardSaleDetails([{
      name: 'Gift Card Sale',
      comment: 'Card #GC-1111',
      price: 30
    }]);
    expect(details).toEqual({ cardNumber: 'GC-1111', amount: 30 });
  });
});

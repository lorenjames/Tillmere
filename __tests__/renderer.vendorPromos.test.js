jest.mock('electron');
const { ipcRenderer } = require('electron');

const {
  __test,
} = require('../js/renderer.js');

function ymd(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function ymdDaysFrom(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return ymd(d);
}

function setupDom() {
  document.body.innerHTML = `
    <div>
      <input id="itemVendor" />
      <select id="discountType">
        <option value="none">none</option>
        <option value="percent">percent</option>
        <option value="amount">amount</option>
      </select>
      <input id="discountValue" />
      <select id="discountReason">
        <option value="">Select reason</option>
        <option value="Vendor Promo">Vendor Promo</option>
        <option value="Store Promo">Store Promo</option>
      </select>
      <input type="checkbox" id="backdateToggle" />
    </div>
  `;
}

describe('vendor promotions auto-apply', () => {
  const today = ymd();
  const tomorrow = ymd(new Date(Date.now() + 24 * 60 * 60 * 1000));

  beforeEach(() => {
    setupDom();
    __test.setVendorsCache([{ name: 'Vendor A', code: 'V1' }]);
    __test.setVendorPromotions([{
      vendorCode: 'V1',
      vendorName: 'Vendor A',
      type: 'percent',
      value: 10,
      startDate: today,
      endDate: tomorrow,
    }]);
    ipcRenderer.invoke.mockResolvedValue([]);
  });

  test('applies vendor promo to entry fields when vendor matches and today is in range', () => {
    const vendorEl = document.getElementById('itemVendor');
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    vendorEl.value = 'V1';
    __test.applyVendorPromoToFields(vendorEl.value, typeEl, valueEl, reasonEl);

    expect(typeEl.value).toBe('percent');
    expect(valueEl.value).toBe('10');
    expect(reasonEl.value).toBe('Vendor Promo');
    expect(typeEl.dataset.autoVendorPromo).toBe('1');
  });

  test('does not apply promo when back-dating sale', () => {
    document.getElementById('backdateToggle').checked = true;
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    __test.applyVendorPromoToFields('V1', typeEl, valueEl, reasonEl);

    expect(typeEl.value).toBe('none');
    expect(valueEl.value).toBe('');
    expect(reasonEl.value).toBe('');
  });

  test('respects manual discounts and keeps user-entered values', () => {
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    typeEl.value = 'amount';
    valueEl.value = '5';
    typeEl.dataset.manualDiscount = '1';
    valueEl.dataset.manualDiscount = '1';

    __test.applyVendorPromoToFields('V1', typeEl, valueEl, reasonEl, { onlyWhenEmptyOrAuto: true });

    expect(typeEl.value).toBe('amount');
    expect(valueEl.value).toBe('5');
    expect(typeEl.dataset.autoVendorPromo).toBeUndefined();
  });

  test('ignores expired promotions', () => {
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    __test.setVendorPromotions([{
      vendorCode: 'V1',
      vendorName: 'Vendor A',
      type: 'amount',
      value: 3,
      startDate: ymd(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
      endDate: ymd(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)),
    }]);

    __test.applyVendorPromoToFields('V1', typeEl, valueEl, reasonEl);

    expect(typeEl.value).toBe('none');
    expect(valueEl.value).toBe('');
    expect(reasonEl.value).toBe('');
  });

  test('drops overlapping promos for the same vendor and keeps earliest', () => {
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    __test.setVendorPromotions([
      { vendorCode: 'V1', vendorName: 'Vendor A', type: 'percent', value: 5, startDate: today, endDate: tomorrow },
      { vendorCode: 'V1', vendorName: 'Vendor A', type: 'amount', value: 9, startDate: today, endDate: tomorrow },
    ]);

    __test.applyVendorPromoToFields('V1', typeEl, valueEl, reasonEl);
    expect(typeEl.value).toBe('percent');
    expect(valueEl.value).toBe('5');
  });

  test('allows non-overlapping future promos for same vendor', () => {
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    const startFuture = ymdDaysFrom(3);
    const endFuture = ymdDaysFrom(4);
    __test.setVendorPromotions([
      { vendorCode: 'V1', vendorName: 'Vendor A', type: 'percent', value: 5, startDate: today, endDate: tomorrow },
      { vendorCode: 'V1', vendorName: 'Vendor A', type: 'amount', value: 9, startDate: startFuture, endDate: endFuture },
    ]);

    const promoNow = __test.findActiveVendorPromo('V1', 'Vendor A', new Date());
    expect(promoNow?.value).toBe(5);

    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 3);
    const promoFuture = __test.findActiveVendorPromo('V1', 'Vendor A', futureDate);
    expect(promoFuture?.value).toBe(9);
  });

  test('normalization drops past-dated promos when setting promo list manually', () => {
    const typeEl = document.getElementById('discountType');
    const valueEl = document.getElementById('discountValue');
    const reasonEl = document.getElementById('discountReason');

    const pastStart = ymdDaysFrom(-5);
    const pastEnd = ymdDaysFrom(-3);
    __test.setVendorPromotions([
      { vendorCode: 'V1', vendorName: 'Vendor A', type: 'percent', value: 5, startDate: pastStart, endDate: pastEnd },
      { vendorCode: 'V1', vendorName: 'Vendor A', type: 'percent', value: 10, startDate: today, endDate: tomorrow },
    ]);

    __test.applyVendorPromoToFields('V1', typeEl, valueEl, reasonEl);
    expect(typeEl.value).toBe('percent');
    expect(valueEl.value).toBe('10');
  });
});


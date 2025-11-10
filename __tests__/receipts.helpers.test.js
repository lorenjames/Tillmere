// Tests for receipt helpers used in receipts.js listing/printing
const {
  toMoneyNumber,
  deriveOriginalPrice,
  deriveDiscount,
  formatPercentText,
  formatDiscountLabel,
  buildDiscountSuffix,
  toDateInputValue,
} = require('../receipts.js');

describe('receipts helpers', () => {
  test('deriveOriginalPrice and discount summary', () => {
    const it = { price: 85, discountAmount: 15 };
    expect(deriveOriginalPrice(it)).toBe(100);
    const d = deriveDiscount({ price: 85, discountAmount: 15, discountType: 'amount', discountReason: 'VIP' });
    expect(d).toMatchObject({ finalPrice: 85, original: 100, discountAmount: 15, reason: 'VIP' });
  });

  test('percent/amount formatting for receipts', () => {
    expect(formatPercentText(12.34)).toBe('12.34%');
    expect(formatDiscountLabel('percent', 20)).toBe('20% off');
    expect(formatDiscountLabel('amount', 0, 5)).toBe('$5.00 off');
    expect(buildDiscountSuffix('percent', 10, 0, 'Holiday')).toBe(' (Holiday, 10% off)');
  });

  test('date input value is yyyy-mm-dd', () => {
    const d = new Date('2024-03-05T15:00:00Z');
    const s = toDateInputValue(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
    expect(s).toBe('2024-03-05');
  });
});


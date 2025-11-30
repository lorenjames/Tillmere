jest.mock('electron');

const {
  toMoneyNumber,
  money,
  formatPercent,
  formatDiscountLabel,
  buildDiscountSuffix,
  clamp,
  computeDiscount,
  finalPriceFrom,
  deriveOriginalPrice,
  itemHasDiscount,
} = require('../renderer.js');

describe('renderer utils and discount math', () => {
  test('toMoneyNumber parses robustly', () => {
    expect(toMoneyNumber(12.345)).toBe(12.35);
    expect(toMoneyNumber('$1,234.50')).toBe(1234.5);
    expect(toMoneyNumber('(12.34)')).toBe(-12.34);
    expect(toMoneyNumber('12,34')).toBe(12.34); // EU comma
    expect(toMoneyNumber('abc')).toBe(0);
  });

  test('money formats two decimals', () => {
    expect(money(5)).toBe('5.00');
    expect(money(5.2)).toBe('5.20');
    expect(money(5.235)).toBe('5.24');
  });

  test('clamp bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  test('formatPercent and labels', () => {
    expect(formatPercent(10)).toBe('10%');
    expect(formatPercent(12.5)).toBe('12.5%');
    expect(formatPercent(0)).toBe('');
    expect(formatDiscountLabel('percent', 15, 0)).toBe('15% off');
    expect(formatDiscountLabel('amount', 5, 5)).toBe('$5.00 off');
    expect(formatDiscountLabel('none', 0, 0)).toBe('');
  });

  test('buildDiscountSuffix with reason and label', () => {
    expect(buildDiscountSuffix('percent', 10, 0, 'VIP')).toBe(' (VIP, 10% off)');
    expect(buildDiscountSuffix('amount', 5, 5, '')).toBe(' ($5.00 off)');
    expect(buildDiscountSuffix('none', 0, 0, '')).toBe('');
  });

  test('computeDiscount percent/amount/none', () => {
    const p = computeDiscount(100, 'percent', 10, 'reason');
    expect(p).toEqual({ type: 'percent', value: 10, amount: 10, reason: 'reason' });

    const a = computeDiscount(100, 'amount', 25.5, 'sale');
    expect(a).toEqual({ type: 'amount', value: 25.5, amount: 25.5, reason: 'sale' });

    const cap = computeDiscount(50, 'amount', 99, '');
    expect(cap.amount).toBe(50);

    const none = computeDiscount(0, 'amount', 10, 'x');
    expect(none.amount).toBe(0);
  });

  test('computeDiscount clamps percent and floors amount to price', () => {
    const overPct = computeDiscount(50, 'percent', 150, 'over');
    expect(overPct.value).toBe(100);
    expect(overPct.amount).toBe(50);

    const hugeAmount = computeDiscount(40, 'amount', 999, 'big');
    expect(hugeAmount.amount).toBe(40);
    expect(hugeAmount.value).toBe(40);
  });

  test('price helpers', () => {
    expect(finalPriceFrom(100, 15)).toBe(85);
    expect(finalPriceFrom(100, 150)).toBe(0);

    const item = { price: 85, discountAmount: 15 };
    expect(deriveOriginalPrice(item)).toBe(100);
    expect(itemHasDiscount(item)).toBe(true);
    expect(itemHasDiscount({ price: 10 })).toBe(false);
  });
});

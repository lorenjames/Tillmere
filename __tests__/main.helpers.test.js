jest.mock('electron');

const { migrateReceipts } = require('../main.js');

describe('migrateReceipts', () => {
  test('adds id/number when missing and keeps stable fields', () => {
    const input = [
      { datetime: '2024-01-01T00:00:00Z', items: [], number: '' },
      { id: 'R-1', number: 'R-1', items: [] },
    ];
    const { out, changed } = migrateReceipts(input);
    expect(Array.isArray(out)).toBe(true);
    expect(changed).toBe(true);
    const a = out[0];
    expect(a.id).toBeTruthy();
    expect(a.number).toBeTruthy();
    // existing id/number preserved on second
    const b = out[1];
    expect(b.id).toBe('R-1');
    expect(b.number).toBe('R-1');
  });
});


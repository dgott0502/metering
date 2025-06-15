const { safeNumber, calculateMonthlyConsumption } = require('../utils');

describe('safeNumber', () => {
  test('returns 0 for non-numeric input', () => {
    expect(safeNumber('abc')).toBe(0);
    expect(safeNumber(undefined)).toBe(0);
    expect(safeNumber(null)).toBe(0);
  });

  test('returns numeric value for numeric input', () => {
    expect(safeNumber('10')).toBe(10);
    expect(safeNumber(5)).toBe(5);
    expect(safeNumber('3.14')).toBe(3.14);
  });
});

describe('calculateMonthlyConsumption', () => {
  test('aggregates readings into monthly totals', () => {
    const readings = [
      { date: '2024-01-01', meter: 'm1', kWHNet: 100 },
      { date: '2024-01-31', meter: 'm1', kWHNet: 150 },
      { date: '2024-02-01', meter: 'm1', kWHNet: 150 },
      { date: '2024-02-28', meter: 'm1', kWHNet: 220 }
    ];
    const result = calculateMonthlyConsumption(readings);
    expect(result.monthly['m1']['2024-01']).toEqual({ min: 100, max: 150 });
    expect(result.monthly['m1']['2024-02']).toEqual({ min: 150, max: 220 });
    expect(result.consumption['m1']['2024-01']).toBe(50);
    expect(result.consumption['m1']['2024-02']).toBe(70);
  });
});

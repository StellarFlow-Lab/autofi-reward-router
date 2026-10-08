import { addAmounts, applySlippage, fromStroops, isPositiveAmount, percentOf, toStroops } from '../utils/amount';

describe('amount math', () => {
  test('round-trips stroops exactly', () => {
    expect(toStroops('1')).toBe(10_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(fromStroops(123_456_789n)).toBe('12.3456789');
    expect(fromStroops(toStroops('922337203685.4775807'))).toBe('922337203685.4775807');
  });

  test('rejects malformed or out-of-range amounts', () => {
    for (const bad of ['', 'abc', '-1', '1.12345678', '1e5', '922337203685.4775808']) {
      expect(() => toStroops(bad)).toThrow();
    }
  });

  test('percentOf has no float drift', () => {
    expect(percentOf('100', 70)).toBe('70.0000000');
    expect(percentOf('0.1', 30)).toBe('0.0300000'); // 0.1 * 0.3 in floats = 0.030000000000000002
    expect(percentOf('0.0000001', 50)).toBe('0.0000000'); // rounds down
    expect(() => percentOf('1', 101)).toThrow();
    expect(() => percentOf('1', 50.5)).toThrow();
  });

  test('applySlippage rounds down', () => {
    expect(applySlippage('1000', 200)).toBe('980.0000000');
    expect(applySlippage('0.0000003', 5000)).toBe('0.0000001');
    expect(() => applySlippage('1', 10_000)).toThrow();
  });

  test('helpers', () => {
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('0.0000001')).toBe(true);
    expect(isPositiveAmount('x')).toBe(false);
    expect(addAmounts('0.1', '0.2')).toBe('0.3000000');
  });
});

// 发版时的 Android versionCode（app.config.ts）：同一个包名只有 versionCode 更大才能覆盖安装，所以它必须一直往上走。
import { describe, expect, it } from 'vitest';

import { androidVersionCode } from '../../app.config';

describe('the Android versionCode of a release', () => {
  it('gives each part two digits and puts a final release after its pre-releases', () => {
    expect(androidVersionCode('1.5.0')).toBe(1050099);
    expect(androidVersionCode('1.6.0-rc.2')).toBe(1060002);
    expect(androidVersionCode('1.6.0-beta')).toBe(1060000);
  });

  it('always goes up from one release to the next', () => {
    const order = ['1.5.2', '1.6.0-rc.1', '1.6.0-rc.2', '1.6.0', '1.6.1', '1.10.0', '2.0.0'];
    const codes = order.map(androidVersionCode);
    expect(codes).toEqual([...codes].sort((left, right) => left - right));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('refuses a version it cannot encode', () => {
    expect(() => androidVersionCode('v1.5.0')).toThrow();
    expect(() => androidVersionCode('1.100.0')).toThrow();
    expect(androidVersionCode('2099.99.99')).toBeLessThanOrEqual(2_100_000_000);
  });
});

// 发版时的版本号（2026-11-15，release-android.yml）：配置的其余部分都在 app.json 里。
// PLC_APP_VERSION 是 release 的 tag 去掉 v（例如 1.5.0、1.6.0-rc.2）。没有它时（开发、Expo Go）照用 app.json。
// Android 只认 versionCode 判断新旧：同一个包名，versionCode 更大才能覆盖安装。所以它由版本号算出来，一直往上走。
import type { ConfigContext, ExpoConfig } from 'expo/config';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * 版本号换成 versionCode：主.次.修订各占两位，最后两位是预发布的序号。
 * 1.5.0 → 1050099，1.6.0-rc.2 → 1060002：正式版是 99，排在同一个版本的所有预发布后面。
 * 主版本号最大 2099（Android 的上限是 2,100,000,000），次版本号和修订号最大 99，预发布序号最大 98。
 */
export function androidVersionCode(version: string): number {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`PLC_APP_VERSION is not a version such as 1.5.0: ${version}`);
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  if (minor > 99 || patch > 99 || major > 2099) throw new Error(`PLC_APP_VERSION is out of range for an Android versionCode: ${version}`);
  let build = 99;
  if (match[4] !== undefined) {
    const last = match[4].split('.').at(-1) ?? '';
    build = /^\d+$/.test(last) ? Math.min(Number(last), 98) : 0;
  }
  return ((major * 100 + minor) * 100 + patch) * 100 + build;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const version = process.env.PLC_APP_VERSION?.trim();
  if (!version) return config as ExpoConfig;
  return {
    ...config,
    version,
    android: { ...config.android, versionCode: androidVersionCode(version) },
  } as ExpoConfig;
};

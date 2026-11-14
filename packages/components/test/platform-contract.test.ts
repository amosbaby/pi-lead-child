// @vitest-environment node
// 三端 API 统一的契约：每个有原生实现的控件，web 实现（Xxx.tsx）和原生实现（Xxx.native.tsx）
// 都导出同样的组件名，并且 props 类型都来自同一个 Xxx.types.ts。类型上的一致由三遍类型检查保证
// （tsconfig.json / tsconfig.ios.json / tsconfig.android.json），这里检查文件结构，防止有人只改一端。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function nativeImplementations(): string[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.native.tsx') ? [path] : [];
  });
  return walk(SRC);
}

function exportedComponents(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/^export function (\w+)/gm)].map((match) => match[1]!).sort();
}

describe('one API on web, iOS and Android', () => {
  const natives = nativeImplementations();

  it('covers every native control', () => {
    const names = natives.map((file) => file.slice(SRC.length + 1));
    expect(names).toEqual(expect.arrayContaining([
      'controls/Button.native.tsx',
      'controls/TextField.native.tsx',
      'controls/Switch.native.tsx',
      'controls/SegmentedControl.native.tsx',
      'lists/ListItem.native.tsx',
      'display/TaskCard.native.tsx',
    ]));
  });

  it('has a web implementation exporting the same components for each native one', () => {
    for (const native of natives) {
      const web = native.replace(/\.native\.tsx$/, '.tsx');
      expect.soft(existsSync(web), web).toBe(true);
      expect.soft(exportedComponents(web), web).toEqual(exportedComponents(native));
    }
  });

  it('takes the props of both implementations from one shared types file', () => {
    for (const native of natives) {
      const web = native.replace(/\.native\.tsx$/, '.tsx');
      const types = native.replace(/\.native\.tsx$/, '.types.ts');
      const typesImport = `from './${types.split('/').pop()!.replace(/\.ts$/, '')}'`;
      expect.soft(existsSync(types), types).toBe(true);
      expect.soft(readFileSync(web, 'utf8'), web).toContain(typesImport);
      expect.soft(readFileSync(native, 'utf8'), native).toContain(typesImport);
    }
  });

  // 原生控件（controls/、lists/）在 iOS 上是 SwiftUI 控件（Expo UI）。
  // 展示类组件（display/）三端都由 Tamagui 渲染，原生实现只换掉无障碍相关的部分（例如 TaskCard 的展开按钮）。
  // Android 上只有 Switch 用 Compose（2026-11-12、11-13）：Compose 控件的默认内边距、最小尺寸压不掉，也不认 style 里的高度，
  // 图标按钮里的图标被裁成空心圆，输入框的文字贴在顶上，和卡片的内边距对不齐。
  // Android 实现（Xxx.android.tsx）走 Tamagui 和 React Native 的 TextInput，和 web 同一份。
  it('renders the controls with Tamagui and React Native on Android', () => {
    for (const name of ['controls/Button', 'controls/SegmentedControl', 'controls/TextField', 'lists/ListItem']) {
      const android = join(SRC, `${name}.android.tsx`);
      expect.soft(existsSync(android), android).toBe(true);
      const source = readFileSync(android, 'utf8');
      expect.soft(source, android).not.toMatch(/from '@expo\/ui/);
      expect.soft(source, android).toContain(`from './${name.split('/').pop()}.tamagui'`);
      expect.soft(exportedComponents(android), android).toEqual(exportedComponents(join(SRC, `${name}.native.tsx`)));
    }
    const chatInput = join(SRC, 'controls/ChatInput.android.tsx');
    expect.soft(readFileSync(chatInput, 'utf8'), chatInput).not.toMatch(/from '@expo\/ui/);
    expect.soft(exportedComponents(chatInput), chatInput).toEqual(exportedComponents(join(SRC, 'controls/ChatInput.native.tsx')));
  });

  // Expo UI 57.0.25 带标签的 Compose Switch 传 width(IntrinsicSize.Max)，原生只收整数，app 直接退出（2026-11-14）。
  it('never hands the label to the Compose Switch on Android', () => {
    const android = join(SRC, 'controls/Switch.android.tsx');
    const source = readFileSync(android, 'utf8');
    const expoSwitch = /<ExpoSwitch\b[^>]*>/.exec(source)?.[0] ?? '';
    expect(expoSwitch, android).not.toBe('');
    expect(expoSwitch, android).not.toMatch(/\blabel=/);
    expect(exportedComponents(android)).toEqual(exportedComponents(join(SRC, 'controls/Switch.native.tsx')));
  });

  it('renders the native controls with Expo UI', () => {
    for (const native of natives.filter((file) => /\/(?:controls|lists)\//.test(file))) {
      expect.soft(readFileSync(native, 'utf8'), native).toMatch(/from '@expo\/ui(?:\/[\w/-]+)?'/);
    }
  });
});

// app 的源码里不能有运行时的互相引用（2026-11-13）。Metro 每次刷新都报一遍 Require cycle，
// 而且循环里先加载的模块可能拿到还没初始化的值。只看运行时的 import：import type 编译后会删掉，不算。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('./', import.meta.url));
const EXTENSIONS = ['.ts', '.tsx', '.native.ts', '.native.tsx', '/index.ts', '/index.tsx'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? join(SRC, specifier.slice(2)) : resolve(dirname(from), specifier);
  for (const extension of ['', ...EXTENSIONS]) {
    const path = base + extension;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

// 文件里运行时的本地 import：from './x'、from '@/x'。整条是 import type，或者花括号里全是 type 的，不算。
export function runtimeImports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^(import|export)\s+([^;]*?)\s+from\s+'([^']+)'/gms)) {
    const [, , clause, specifier] = match as unknown as [string, string, string, string];
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue;
    if (/^type\b/.test(clause)) continue;
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    if (named && named[1]!.split(',').map((part) => part.trim()).filter(Boolean).every((part) => part.startsWith('type '))) continue;
    found.push(specifier);
  }
  return found;
}

function findCycles(files: readonly string[]): string[][] {
  const graph = new Map(files.map((file) => [file, runtimeImports(readFileSync(file, 'utf8'))
    .map((specifier) => resolveImport(file, specifier))
    .filter((path): path is string => path !== null)]));
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (file: string) => {
    state.set(file, 'visiting');
    stack.push(file);
    for (const next of graph.get(file) ?? []) {
      if (state.get(next) === 'visiting') cycles.push(stack.slice(stack.indexOf(next)).map((path) => path.slice(SRC.length)));
      else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(file, 'done');
  };
  for (const file of files) if (!state.has(file)) visit(file);
  return cycles;
}

describe('import cycles', () => {
  it('skips type-only imports', () => {
    expect(runtimeImports("import type { A } from './a';\nimport { type B, type C } from './b';\nimport { d } from './d';")).toEqual(['./d']);
  });

  it('has no runtime cycle in the app', () => {
    expect(findCycles(sources(SRC))).toEqual([]);
  });
});

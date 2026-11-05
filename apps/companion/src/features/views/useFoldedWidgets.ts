import { useCallback, useSyncExternalStore } from 'react';

import { platformWidgetFoldMemory } from '@/data/platformWidgetFoldMemory';

// 视图面板里你折叠起来的控件（工单 #54）：按控件 id 记，存在这台设备上，不进后端。
// 和工单详情记块的折叠（useRememberedSections）一样：第一次用到时从本地读一次，之后每次改都写回去。
// 读失败、内容不对时当作都没折叠。
let folded: readonly number[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function parse(text: string | null): number[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const before = folded;
  void platformWidgetFoldMemory.load().then((text) => {
    // 读回来之前你已经点过的控件，以你点的为准。
    const touched = folded !== before;
    if (!touched) folded = parse(text);
    emit();
  }).catch(() => {});
}

function subscribe(listener: () => void) {
  ensureLoaded();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot() {
  return folded;
}

export function useFoldedWidgets(): [readonly number[], (id: number, fold: boolean) => void] {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setFolded = useCallback((id: number, fold: boolean) => {
    const rest = folded.filter((item) => item !== id);
    folded = fold ? [...rest, id] : rest;
    emit();
    void platformWidgetFoldMemory.save(JSON.stringify(folded)).catch(() => {});
  }, []);
  return [value, setFolded];
}

/** 只给测试用：清掉内存里的记录，下次用到时重新从本地读。 */
export function resetFoldedWidgetsForTesting() {
  folded = [];
  loaded = false;
  emit();
}

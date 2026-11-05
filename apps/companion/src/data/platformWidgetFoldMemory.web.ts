import type { WidgetFoldStorage } from './platformWidgetFoldMemory';

// 视图面板里你折叠起来的控件（工单 #54）：记在这台设备的 localStorage 里，不进后端。
// 没有 localStorage 的环境（隐私模式拒绝访问等）退回内存。
const KEY = 'pi-lead-child.folded-widgets.v1';
let fallback: string | null = null;

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const platformWidgetFoldMemory: WidgetFoldStorage = {
  async load() {
    return local()?.getItem(KEY) ?? fallback;
  },
  async save(value) {
    const storage = local();
    if (storage) storage.setItem(KEY, value);
    else fallback = value;
  },
};

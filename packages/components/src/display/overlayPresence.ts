import { useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// 现在有几个盖住页面的浮层（悬浮面板、抽屉）开着。FairyEye 在被盖住时暂停动画（2026-11-14 用户：只加不可见时暂停）。
let openOverlays = 0;
const overlayListeners = new Set<() => void>();

function notify() {
  for (const listener of overlayListeners) listener();
}

/** 浮层打开时调用一次，返回关上时调用的函数。 */
export function registerOverlay(): () => void {
  openOverlays += 1;
  notify();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    openOverlays -= 1;
    notify();
  };
}

function subscribeOverlays(listener: () => void) {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

/** 有盖住页面的浮层开着时为 true。 */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeOverlays, () => openOverlays > 0, () => false);
}

function subscribeAppState(listener: () => void) {
  const subscription = AppState.addEventListener('change', listener);
  return () => subscription.remove();
}

const currentAppState = (): AppStateStatus => AppState.currentState;

/** 应用在前台、屏幕亮着时为 true。退到后台、锁屏时为 false（web 上标签页隐藏时也是 false）。 */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeAppState, () => currentAppState() === 'active', () => true);
}

import type { SurfaceActionDone, SurfaceActionOrigin, UiActionButtonTarget } from '@pi-lead-child/protocol';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '../../state/CompanionStateProvider';

// 会话卡片上做成了的按钮（工单 #263，protocol 的 surface-actions.ts）。按钮按下、操作成功以后收起，换成一行「已完成」。
// 服务端按「哪一次 render_ui 调用、哪个按钮」记了一条：卡片打开时读回来，刷新页面、换一台设备打开也是已完成。
// 只有会话里的卡片有 callId。工作台的控件是反复用的，没有这层：按钮照旧。

type Runtime = ReturnType<typeof useCompanionRuntime>;

// 读过的记录按 runtime 存一份：会话列表只画看得见的卡，卡片滚出去再滚回来时不再闪一下按钮。
const cache = new WeakMap<object, Map<string, SurfaceActionDone[]>>();

function cacheOf(runtime: Runtime): Map<string, SurfaceActionDone[]> {
  let byCall = cache.get(runtime);
  if (!byCall) {
    byCall = new Map();
    cache.set(runtime, byCall);
  }
  return byCall;
}

function remember(runtime: Runtime, record: SurfaceActionDone): SurfaceActionDone[] {
  const byCall = cacheOf(runtime);
  const next = [...(byCall.get(record.callId) ?? []).filter((entry) => entry.node !== record.node), record];
  byCall.set(record.callId, next);
  return next;
}

type SurfaceActionsState = {
  callId: string | null;
  done: readonly SurfaceActionDone[];
  markDone: (record: Omit<SurfaceActionDone, 'callId' | 'at'>) => void;
  refresh: () => void;
};

const SurfaceActions = createContext<SurfaceActionsState>({ callId: null, done: [], markDone: () => {}, refresh: () => {} });

/** 一张会话卡片的按钮记录。callId 为 null（工作台的控件、流式中途的卡）时不读也不记。 */
export function SurfaceActionsProvider({ callId, enabled, children }: { callId: string | null; enabled: boolean; children: ReactNode }) {
  const runtime = useCompanionRuntime();
  const active = enabled && callId !== null;
  const [done, setDone] = useState<readonly SurfaceActionDone[]>(() => (active ? cacheOf(runtime).get(callId!) ?? [] : []));
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    runtime.getSurfaceActions([callId!]).then((records) => {
      if (!live) return;
      // 这次读的时候本机刚做成的按钮可能还没写进服务端的结果：本机记下的留着。
      const local = cacheOf(runtime).get(callId!) ?? [];
      const merged = [...records, ...local.filter((entry) => !records.some((record) => record.node === entry.node))];
      cacheOf(runtime).set(callId!, merged);
      setDone(merged);
    }, () => {});
    return () => { live = false; };
  }, [active, callId, epoch, runtime]);
  const markDone = useCallback((record: Omit<SurfaceActionDone, 'callId' | 'at'>) => {
    if (!active) return;
    setDone(remember(runtime, { ...record, callId: callId!, at: new Date().toISOString() }));
  }, [active, callId, runtime]);
  const refresh = useCallback(() => setEpoch((value) => value + 1), []);
  const value = useMemo(() => ({ callId: active ? callId : null, done, markDone, refresh }), [active, callId, done, markDone, refresh]);
  return <SurfaceActions.Provider value={value}>{children}</SurfaceActions.Provider>;
}

/** 这个按钮在这张卡上做成了没有，和执行时要带上的 origin。记录的目标和操作要和按钮一致才算。 */
export function useSurfaceActionDone(node: string, target: UiActionButtonTarget, action: string): {
  done: SurfaceActionDone | null;
  origin: SurfaceActionOrigin | null;
  markDone: () => void;
  refresh: () => void;
} {
  const state = useContext(SurfaceActions);
  const targetType: string = target.type;
  const targetId = String(target.id as string | number);
  const done = state.done.find((entry) => entry.node === node && entry.action === action
    && entry.target.type === targetType && entry.target.id === targetId) ?? null;
  return {
    done,
    origin: state.callId ? { callId: state.callId, node } : null,
    markDone: () => state.markDone({ node, target: { type: targetType, id: targetId }, action }),
    refresh: state.refresh,
  };
}

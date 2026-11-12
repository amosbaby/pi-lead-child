// 信号源的策略（用户 2026-11-12）：新内容来了，能不能代用户往外部账号里写（回邮件、接受邀请），按用户建信号源时的话。
// 用户没有说可以时，缺省是先问用户。这一条由代码守：
//   - 信号源的事件叫醒的一轮（turnOrigin 的 externalEvents 里有 signal.received），那个信号源不是「可以代我处理」的；
//   - 或者这一轮用 read_signal_items 读过信号的内容，而有信号源不是「可以代我处理」的；
// 这时连接的写入工具不直接执行：系统存下这一次调用，发确认卡，用户点了才执行（和连接的「先问我」同一条路）。
// 用户本人正在说话的一轮不受限：用户在场，照连接自己的写入策略。
// 可以代处理的范围（用户原话里说的那几种事）由 Lead 按原话判断，写在事件块和 skill signal-sources 里。
import { isLiveUserTurn } from "@pi-lead-child/engine";
import { SIGNAL_RECEIVED_KIND } from "@pi-lead-child/protocol";
import { getEvent, getSignalSource, listSignalSources, type Db } from "@pi-lead-child/store";
import type { TurnOriginDeps } from "./turn-origin.js";

export interface SignalAskFirst {
  // 哪个信号源（给确认卡和 Lead 看）。
  name: string;
  label: string;
}

/** 这一轮里连接的写入要不要先问用户。不用时为 null。 */
export function signalAskFirst(db: Db, deps: TurnOriginDeps): SignalAskFirst | null {
  const origin = deps.turnOrigin?.();
  if (!origin) return null;
  const woken = (origin.externalEvents ?? []).flatMap((seq) => {
    const event = getEvent(db, seq);
    return event?.kind === SIGNAL_RECEIVED_KIND && typeof event.payload.signal === "string"
      ? [{ name: event.payload.signal, label: typeof event.payload.label === "string" ? event.payload.label : event.payload.signal }] : [];
  });
  const read = (origin.externalBy ?? []).some((source) => source.via === "tool" && source.tool === "read_signal_items");
  if (!woken.length && !read) return null;
  if (isLiveUserTurn(db, deps.currentTurnId?.() ?? null, "tickets:create")) return null;
  // 信号源已经删了的也按先问用户算：没有地方写着可以代处理。
  const blocked = woken.find((entry) => getSignalSource(db, entry.name)?.actForUser !== true);
  if (blocked) return blocked;
  if (!read) return null;
  const askFirst = listSignalSources(db).find((source) => !source.actForUser);
  return askFirst ? { name: askFirst.name, label: askFirst.label } : null;
}

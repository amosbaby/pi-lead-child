// 不记两遍账（.scratch/external-worker-hub/spec.md P1-6）：你在来源里已经回了，工单不用你再回来记一次。
//   - 工单关联的会话卡进入 replied（你用草稿回了）或 resolved_elsewhere（你在来源里自己回了）时（hub 的 disposeCardEvents 之后
//     调 onCardDisposed），ready / active 的单收尾：关掉外部工人的 Run（stopped），system 推到 review，记一条 replied_in_source。
//     replying_self（你说了一句，没回答对方）不算。
//   - 只读类（代查，purpose=lookup：dispatch_agent_task 派的单）回复已经发出，没有交付物要验：接着 system review → done
//     （stages.ts 的 review->done 的第二种触发）。工人先交了（complete，单在 review）、你后回的，也在这里走到 done；
//     你先回、工人后交的，completeTicket 交完以后调 closeOutAnsweredTicket。交付类的单停在 review 等你验收。
//   - 工单有自己在跑的 Run（self 模式下的代查、执行者）时不动：那条流水线自己收尾。done、cancelled、blocked 的单不动。
// 卡和工单怎么关联：代查记录（channel_lookups.item_id），或者工单的来源（ticket_sources 的 conversation = 卡的对象键、
// message_ts = 卡的锚点 reply_target.thread_ts，ticket-sources.ts 写的就是这两个值；不是叫醒那一轮的那条消息）。
// message_ts 为空的来源（用户私信里建的单）不按卡关联。
//
// 外部 / 暂停模式下派的子 agent 工单在卡上留一条排着的记录（channel_lookups queued、run_id null，ruling R12），占着这张卡唯一的
// 进行中记录。它什么时候结束（settleDeferredLookups，CARRY→Task 11）只看一条规则：工单还能由外部工人接着做——stage 是
// ready / active / blocked，并且执行模式不是 self 或者现在有工人领着——就留着（这时再派一张就重复了），否则结束。
// 工单进了 review / done 记成 finished（卡上显示「已结束」），别的（切回 self 没人领、self 下放掉或交回）记成 cancelled。
// 调用的地方：收尾、工人交了 / 交回、放掉、切回 self。
import type { Item } from "@pi-lead-child/core";
import { EXTERNAL_RUNTIME_ID, type ChannelCardState } from "@pi-lead-child/protocol";
import {
  addActivity, getChannelCard, getItem, itemUpdatedEvent, markRunStopped, publishGatewayEvent, runUpdatedEvent, transition,
  updateChannelCard, updateChannelLookup, type ChannelCard, type Db,
} from "@pi-lead-child/store";
import { getExecutionMode } from "../execution-mode.js";
import { cardAnchor } from "../ticket-sources.js";
import { openWorkerClaim, touchItem } from "./claim.js";

export const REPLIED_IN_SOURCE_DECISION = "replied_in_source";

// 你已经回了对方的卡的状态。
const ANSWERED_CARD_STATES: readonly ChannelCardState[] = ["replied", "resolved_elsewhere"];
// 还能由外部工人接着做的单（排着的记录留着的条件之一）。
const WORKABLE_STAGES: readonly Item["stage"][] = ["ready", "active", "blocked"];

export interface CardDisposal {
  // 卡现在的状态（处置以后）。
  state: ChannelCardState;
  now?: Date;
}

export interface TicketCloseout {
  ticketId: number;
  from: Item["stage"];
  to: "review" | "done";
  // 关掉的外部工人的 Run。单没人领、或者已经在 review 时是 null。
  closedRunId: number | null;
}

/** 这张卡关联的工单（代查记录和工单来源），按编号。 */
function cardTicketIds(db: Db, card: ChannelCard): number[] {
  const ids = new Set<number>();
  for (const row of db.prepare("SELECT DISTINCT item_id FROM channel_lookups WHERE card_id = ? AND item_id IS NOT NULL")
    .all(card.id) as Array<{ item_id: number }>) ids.add(row.item_id);
  const anchor = cardAnchor(card);
  if (anchor) {
    for (const row of db.prepare("SELECT DISTINCT item_id FROM ticket_sources WHERE conversation = ? AND message_ts = ?")
      .all(card.objectKey, anchor) as Array<{ item_id: number }>) ids.add(row.item_id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** 这张工单关联的会话卡（同上的两种关联，反过来查）。 */
function ticketCards(db: Db, itemId: number): ChannelCard[] {
  const ids = new Set<number>();
  for (const row of db.prepare("SELECT DISTINCT card_id FROM channel_lookups WHERE item_id = ?").all(itemId) as Array<{ card_id: number }>) {
    ids.add(row.card_id);
  }
  const sources = db.prepare(
    "SELECT DISTINCT conversation, message_ts FROM ticket_sources WHERE item_id = ? AND conversation IS NOT NULL AND message_ts IS NOT NULL",
  ).all(itemId) as Array<{ conversation: string; message_ts: string }>;
  for (const source of sources) {
    for (const row of db.prepare(
      `SELECT id FROM channel_cards WHERE object_key = ? AND json_valid(reply_target) AND json_extract(reply_target, '$.thread_ts') = ?`,
    ).all(source.conversation, source.message_ts) as Array<{ id: number }>) ids.add(row.id);
  }
  return [...ids].sort((a, b) => a - b).map((id) => getChannelCard(db, id)).filter((card): card is ChannelCard => Boolean(card));
}

// 只读类：代查（purpose=lookup）。不是交付，没有要你验收的成果（core 的 RunPurpose）。
const isReadOnly = (item: Item) => item.purpose === "lookup";

/**
 * 卡结束以后（hub 的 disposeCardEvents）：你已经回了对方时，关联的工单收尾（见文件头）。返回收尾了的工单。一笔事务；
 * 不是 replied / resolved_elsewhere 时什么也不做。
 */
export function onCardDisposed(db: Db, card: ChannelCard, disposal: CardDisposal): TicketCloseout[] {
  if (!ANSWERED_CARD_STATES.includes(disposal.state)) return [];
  const now = disposal.now ?? new Date();
  return db.transaction(() => cardTicketIds(db, card)
    .map((itemId) => closeOutTicket(db, itemId, card, disposal.state, now))
    .filter((closed): closed is TicketCloseout => closed !== null))();
}

/**
 * 工人交了一张只读类的单（completeTicket 之后，单在 review）：关联的卡你已经回过了时，接着走到 done。返回收尾；没有时 null。
 */
export function closeOutAnsweredTicket(db: Db, itemId: number, now = new Date()): TicketCloseout | null {
  const card = ticketCards(db, itemId).find((candidate) => ANSWERED_CARD_STATES.includes(candidate.state));
  return card ? closeOutTicket(db, itemId, card, card.state, now) : null;
}

function closeOutTicket(db: Db, itemId: number, card: ChannelCard, state: ChannelCardState, now: Date): TicketCloseout | null {
  const item = getItem(db, itemId);
  if (!item || item.kind !== "task") return null;
  const readOnly = isReadOnly(item);
  // 终态是权威（核心不变量）：done、cancelled 不动。blocked（交回给你、等你决定）也不动。review 只有只读类还要往前走。
  if (!(item.stage === "ready" || item.stage === "active" || (item.stage === "review" && readOnly))) return null;
  const live = db.prepare(
    "SELECT id FROM runs WHERE item_id = ? AND runtime <> ? AND state IN ('starting','running') LIMIT 1",
  ).get(itemId, EXTERNAL_RUNTIME_ID) as { id: number } | undefined;
  if (live) return null;
  const from = item.stage;
  const reason = `you replied in the source (card #${card.id}, ${state})`;
  let closedRunId: number | null = null;
  const stoppedRunIds: number[] = [];
  let settledDispatchRequestIds: number[] = [];
  if (from !== "review") {
    const claim = openWorkerClaim(db, itemId);
    if (claim) {
      markRunStopped(db, claim.runId);
      closedRunId = claim.runId;
    }
    // 和领单一样（claim.ts）：暂停的 Run、还排着的派发请求结掉，否则以后会在一张已经收尾的单上再跑。
    for (const run of db.prepare("SELECT id FROM runs WHERE item_id = ? AND state = 'paused' ORDER BY id").all(itemId) as Array<{ id: number }>) {
      markRunStopped(db, run.id);
      stoppedRunIds.push(run.id);
    }
    settledDispatchRequestIds = (db.prepare("SELECT id FROM dispatch_requests WHERE item_id = ? AND state = 'pending' ORDER BY id")
      .all(itemId) as Array<{ id: number }>).map((row) => row.id);
    const settle = db.prepare("UPDATE dispatch_requests SET state = 'cancelled', updated_at = datetime('now') WHERE id = ? AND state = 'pending'");
    for (const id of settledDispatchRequestIds) settle.run(id);
    transition(db, { itemId, to: "review", actor: "system", reason, ...(closedRunId ? { runId: closedRunId } : {}), now });
  }
  // review → done 的第二种 system 触发（stages.ts）：只读类，你的回复已经发出（卡是 replied / resolved_elsewhere）。
  if (readOnly) transition(db, { itemId, to: "done", actor: "system", reason, ...(closedRunId ? { runId: closedRunId } : {}), now });
  const to = readOnly ? "done" : "review";
  addActivity(db, {
    itemId, actor: "system", kind: "decision", ...(closedRunId ? { runId: closedRunId } : {}),
    payload: {
      decision: REPLIED_IN_SOURCE_DECISION, cardId: card.id, cardState: state, source: card.source, from, to, closedRunId,
      ...(stoppedRunIds.length ? { stoppedRunIds } : {}),
      ...(settledDispatchRequestIds.length ? { settledDispatchRequestIds } : {}),
    },
  });
  touchItem(db, itemId);
  settleDeferredLookups(db, { itemId, reason: "你在来源里已经回复了", now });
  if (closedRunId) publishGatewayEvent(db, runUpdatedEvent(itemId, closedRunId, now));
  publishGatewayEvent(db, itemUpdatedEvent(itemId, now));
  return { ticketId: itemId, from, to, closedRunId };
}

/**
 * 结束不再有人接着做的工单在卡上排着的记录（见文件头的规则）。itemId 只看这张工单的；不给时看所有的（切回 self）。
 * 返回结束了的记录编号。调用方负责事务（每条记录一次更新，各自原子）。
 */
export function settleDeferredLookups(db: Db, input: { itemId?: number; reason: string; now?: Date }): number[] {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  // 排着的子 agent 工单记录：有工单、没有 Run、不是旧代查（旧代查有代查闸门的结论，hub 的 retireOldLookups 管）。
  const rows = db.prepare(
    `SELECT id, card_id, item_id FROM channel_lookups
     WHERE run_id IS NULL AND item_id IS NOT NULL AND state IN ('queued', 'running')
       AND json_valid(intake) AND json_extract(intake, '$.gate') IS NULL ${input.itemId === undefined ? "" : "AND item_id = ?"}
     ORDER BY id`,
  ).all(...(input.itemId === undefined ? [] : [input.itemId])) as Array<{ id: number; card_id: number; item_id: number }>;
  if (!rows.length) return [];
  const self = getExecutionMode(db) === "self";
  const settled: number[] = [];
  for (const row of rows) {
    const item = getItem(db, row.item_id);
    if (item && WORKABLE_STAGES.includes(item.stage) && (!self || openWorkerClaim(db, item.id))) continue;
    const ended = item && (item.stage === "review" || item.stage === "done");
    updateChannelLookup(db, row.id, {
      state: ended ? "finished" : "cancelled",
      reply: { decision: "hand_over", reasons: [input.reason], order: null, at, choice: null },
    }, { at: now });
    updateChannelCard(db, row.card_id, {}, { at: now });
    settled.push(row.id);
  }
  return settled;
}

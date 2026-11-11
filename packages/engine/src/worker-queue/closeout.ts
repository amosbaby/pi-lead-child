// 不记两遍账（.scratch/external-worker-hub/spec.md P1-6）：你在来源里已经回了，工单不用你再回来记一次。
//   - 工单关联的会话卡进入 replied（你用草稿回了）或 resolved_elsewhere（你在来源里自己回了）时（hub 的 disposeCardEvents 之后
//     调 onCardDisposed），ready / active / blocked 的单收尾：关掉外部工人的 Run（stopped），system 推到 review，撤掉处理方式的判断
//     （handling 改回 NULL：你已经处理了，不再「待你处理」，ruling R20），记一条 replied_in_source。
//     replying_self（你说了一句，没回答对方）不算。
//   - 只读类（卡上代查记录的剧本是 lookup：咨询、进度）回复已经发出，没有交付物要验：接着 system review → done
//     （stages.ts 的 review->done 的第二种触发）。剧本是 review 的（code_review、approve：在 PR 上留了评论或者批准了）
//     停在 review 等你看（ruling R21）。工人先交了（complete，单在 review）、你后回的，也在这里走到 done；
//     你先回、工人后交的，completeTicket 交完以后调 closeOutAnsweredTicket。交付类的单停在 review 等你验收。
//   - 工单有自己在跑的 Run（self 模式下的代查、执行者）时不动：那条流水线自己收尾。done、cancelled、draft 的单不动。
// 卡和工单按卡本身关联（ruling R19）：代查记录（channel_lookups.card_id）或者工单的来源（ticket_sources.card_id）是这张卡。
// 不按对话和锚点关联：一个线程里的几张卡锚点相同（回了后一张会误收前一张的单），私信里卡的锚点随新消息移动（会漏掉）。
// 没有卡的来源（用户私信里建的单、worker.track）不按卡关联。
//
// 外部 / 暂停模式下派的子 agent 工单在卡上留一条排着的记录（channel_lookups queued、run_id null，ruling R12），占着这张卡唯一的
// 进行中记录。它什么时候结束（settleDeferredLookups，CARRY→Task 11）只看一条规则：工单还能由外部工人接着做——stage 是
// ready / active / blocked，并且执行模式不是 self 或者现在有工人领着——就留着（这时再派一张就重复了），否则结束。
// 工单进了 review / done 记成 finished（卡上显示「已结束」），别的（切回 self 没人领、self 下放掉或交回）记成 cancelled。
// 调用的地方：卡结束（关联的每张单都看一遍，不管它收没收尾）、工人交了 / 交回、放掉、取消、切回 self。
import type { Item } from "@pi-lead-child/core";
import { EXTERNAL_RUNTIME_ID, type ChannelCardState } from "@pi-lead-child/protocol";
import {
  addActivity, clearHandling, getChannelCard, getItem, getLookupByItem, itemUpdatedEvent, markRunStopped, publishGatewayEvent, runUpdatedEvent,
  transition, updateChannelCard, updateChannelLookup, type ChannelCard, type Db,
} from "@pi-lead-child/store";
import { getExecutionMode } from "../execution-mode.js";
import { openWorkerClaim, touchItem } from "./claim.js";

export const REPLIED_IN_SOURCE_DECISION = "replied_in_source";

// 你已经回了对方的卡的状态。
const ANSWERED_CARD_STATES: readonly ChannelCardState[] = ["replied", "resolved_elsewhere"];
// 还能由外部工人接着做的单：排着的记录留着的条件之一，也是你回了以后要收尾到 review 的单。
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

/** 这张卡关联的工单（代查记录和工单来源里记着这张卡的），按编号。 */
function cardTicketIds(db: Db, cardId: number): number[] {
  return (db.prepare(
    `SELECT item_id FROM channel_lookups WHERE card_id = ? AND item_id IS NOT NULL
     UNION SELECT item_id FROM ticket_sources WHERE card_id = ? ORDER BY item_id`,
  ).all(cardId, cardId) as Array<{ item_id: number }>).map((row) => row.item_id);
}

/** 这张工单关联的会话卡（同上的两种关联，反过来查）。 */
function ticketCards(db: Db, itemId: number): ChannelCard[] {
  return (db.prepare(
    `SELECT card_id FROM channel_lookups WHERE item_id = ?
     UNION SELECT card_id FROM ticket_sources WHERE item_id = ? AND card_id IS NOT NULL ORDER BY card_id`,
  ).all(itemId, itemId) as Array<{ card_id: number }>)
    .map((row) => getChannelCard(db, row.card_id)).filter((card): card is ChannelCard => Boolean(card));
}

// 只读类（ruling R21）：卡上派这张单的代查记录，剧本是 lookup（咨询、进度）。review 剧本（code_review、approve）在 PR 上留了
// 评论或者批准了，你要看一眼，不算；Lead 建的交付类单没有代查记录。
const isReadOnly = (db: Db, itemId: number) => getLookupByItem(db, itemId)?.playbook === "lookup";

/**
 * 卡结束以后（hub 的 disposeCardEvents）：你已经回了对方时，关联的工单收尾（见文件头）。返回收尾了的工单。一笔事务；
 * 不是 replied / resolved_elsewhere 时什么也不做。
 */
export function onCardDisposed(db: Db, card: ChannelCard, disposal: CardDisposal): TicketCloseout[] {
  if (!ANSWERED_CARD_STATES.includes(disposal.state)) return [];
  const now = disposal.now ?? new Date();
  return db.transaction(() => {
    const closed: TicketCloseout[] = [];
    for (const itemId of cardTicketIds(db, card.id)) {
      const done = closeOutTicket(db, itemId, card, disposal.state, now);
      if (done) closed.push(done);
      // 不管收没收尾（例如单已经取消了），它在卡上排着的记录都按规则看一遍。
      settleDeferredLookups(db, { itemId, reason: "你在来源里已经回复了", now });
    }
    return closed;
  })();
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
  const readOnly = isReadOnly(db, itemId);
  // 终态是权威（核心不变量）：done、cancelled 不动，draft 也不动。blocked（交回给你）你在来源里回了就是处理了（ruling R20）。
  // review 只有只读类还要往前走。
  if (!(WORKABLE_STAGES.includes(item.stage) || (item.stage === "review" && readOnly))) return null;
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
    // 你已经处理了：不再「待你处理」（needs_user 撤掉，复杂度留着）。
    clearHandling(db, itemId);
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

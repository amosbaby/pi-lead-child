// 对外提问（用户 2026-11-11、2026-11-12）：Lead 替一张工单在通道的对话里问一个人。
//   - 问：发消息的操作（ui-actions 的 channel_conversation.send_message）带上 question 时，发出去以后在这里登记：
//     一条挂在「回复会出现的那个对话」上的等待（store 的 lead_waits），和工单上的一条活动 question_sent。
//   - 答：那个对话里来了别人的消息，等待了结，Lead 被叫醒，带着备注、发信人和原话（store 的 settleLeadWaits，
//     通道适配器把来信的事件声明成 waitSignal=message）。
//   - 上限（用户：「最多6条可以，最长一天」）：一个问题最多发 QUESTION_LIMITS.maxMessages 条，从第一次问起最长等
//     QUESTION_LIMITS.maxWaitMs。到了就不让再发，拒绝里写下一步：把来回的摘要交给用户。
// 不开新表（用户问「这是要单独开一个数据库表吗」以后定的）：轮数从工单的活动里数；来回的每一轮不另存，通道里的对话就是记录。
// 所以同一个对话里同时有两个问题时，等待只有一条，备注里并着两个问题；是不是该回答的那个人回的，由 Lead 看发信人。
// 不绑定哪个通道：这里只认对话的编号和对象键。
import {
  addActivity, getDecisionRequest, getItem, registerLeadWait, type Db,
} from "@pi-lead-child/store";
import { LEAD_WAIT_LIMITS } from "@pi-lead-child/protocol";

export const QUESTION_LIMITS = {
  maxMessages: 6,
  maxWaitMs: 24 * 60 * 60_000,
} as const;

/** 工单活动里的记号：替这张工单问了一条（payload.decisionRequestId、conversation、objectKey、round、text）。 */
export const QUESTION_SENT = "question_sent";

export interface OutboundQuestionRef {
  ticketId: number;
  decisionId?: number;
}

export class OutboundQuestionRefused extends Error {
  constructor(readonly code: "invalid_input" | "forbidden", message: string) {
    super(message);
    this.name = "OutboundQuestionRefused";
  }
}

interface QuestionRounds {
  count: number;
  firstAt: string | null;
}

function roundsOf(db: Db, question: OutboundQuestionRef): QuestionRounds {
  const rows = db.prepare(
    `SELECT created_at AS at, json_extract(payload, '$.decisionRequestId') AS decision, json_extract(payload, '$.at') AS sentAt
       FROM activities
      WHERE item_id = ? AND kind = 'decision' AND json_valid(payload) AND json_extract(payload, '$.decision') = ?
      ORDER BY id`,
  ).all(question.ticketId, QUESTION_SENT) as Array<{ at: string; decision: number | null; sentAt: string | null }>;
  const mine = rows.filter((row) => (question.decisionId === undefined ? row.decision === null : row.decision === question.decisionId));
  return { count: mine.length, firstAt: mine[0]?.sentAt ?? null };
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

function subjectOf(db: Db, question: OutboundQuestionRef): string {
  const item = getItem(db, question.ticketId);
  const title = item ? `「${clip(item.display_title ?? item.title, 40)}」` : "";
  return question.decisionId === undefined
    ? `工单 #${question.ticketId}${title}`
    : `工单 #${question.ticketId}${title}的决定请求 #${question.decisionId}`;
}

function handToUser(question: OutboundQuestionRef): string {
  return question.decisionId === undefined
    ? "把来回的摘要交给用户，请他来定。"
    : `把来回的摘要交给用户：用 render_ui 的 Intervention 节点把决定请求 #${question.decisionId} 摆给他，正文写清问过谁、对方说了什么、卡在哪。`;
}

/**
 * 发之前检查：工单在，决定请求是这张工单上还没有结果的那一个，没有超过条数和时间的上限。不合格时抛 OutboundQuestionRefused
 * （这时还没有发）。返回这是第几条。
 */
export function assertQuestionAllowed(db: Db, question: OutboundQuestionRef, now: Date): { round: number } {
  if (!getItem(db, question.ticketId)) throw new OutboundQuestionRefused("invalid_input", `没有发：工单 #${question.ticketId} 不存在。`);
  if (question.decisionId !== undefined) {
    const request = getDecisionRequest(db, question.decisionId);
    if (!request || request.itemId !== question.ticketId) {
      throw new OutboundQuestionRefused("invalid_input", `没有发：#${question.decisionId} 不是工单 #${question.ticketId} 的决定请求。`);
    }
    if (request.state !== "pending") {
      throw new OutboundQuestionRefused("invalid_input", `没有发：决定请求 #${question.decisionId} 已经有了结果（${request.state}），不用再问。`);
    }
  }
  const rounds = roundsOf(db, question);
  if (rounds.count >= QUESTION_LIMITS.maxMessages) {
    throw new OutboundQuestionRefused(
      "forbidden",
      `没有发：${subjectOf(db, question)}已经发了 ${rounds.count} 条，上限是 ${QUESTION_LIMITS.maxMessages} 条。${handToUser(question)}`,
    );
  }
  if (rounds.firstAt && now.getTime() - Date.parse(rounds.firstAt) > QUESTION_LIMITS.maxWaitMs) {
    throw new OutboundQuestionRefused(
      "forbidden",
      `没有发：${subjectOf(db, question)}从第一次问起已经过了 ${Math.round(QUESTION_LIMITS.maxWaitMs / 86_400_000)} 天。${handToUser(question)}`,
    );
  }
  return { round: rounds.count + 1 };
}

export interface RecordedQuestion {
  ticketId: number;
  decisionId: number | null;
  round: number;
  maxMessages: number;
  // 等到什么时候（第一次问的时刻加上限）。
  waitUntil: string;
  waitId: number;
}

/**
 * 消息发出去以后登记：工单上记一条 question_sent，在回复会出现的对话（objectKey）上登记等待。
 * 那个对话上已经有别的问题在等时，备注里并上这一个。追问不延长期限：等到第一次问的时刻加上限为止。
 */
export function recordQuestionSent(db: Db, input: {
  question: OutboundQuestionRef; conversation: string; objectKey: string; text: string; actor: "user" | "lead"; now: Date;
}): RecordedQuestion {
  return db.transaction((): RecordedQuestion => {
    const { question, now } = input;
    const rounds = roundsOf(db, question);
    const round = rounds.count + 1;
    const firstAt = rounds.firstAt ? Date.parse(rounds.firstAt) : now.getTime();
    const deadline = firstAt + QUESTION_LIMITS.maxWaitMs;
    addActivity(db, {
      itemId: question.ticketId, actor: input.actor, kind: "decision",
      payload: {
        decision: QUESTION_SENT, decisionRequestId: question.decisionId ?? null, conversation: input.conversation,
        // 工单历史的标题按界面语言写（companion 的 decisionLabels），正文显示这里的 text：问出去的原话。
        objectKey: input.objectKey, round, text: clip(input.text, 300), at: now.toISOString(),
      },
    });
    const origin = question.decisionId === undefined
      ? `question:ticket:${question.ticketId}`
      : `question:ticket:${question.ticketId}:decision:${question.decisionId}`;
    const note = `${subjectOf(db, question)}：你问了「${clip(input.text, 100)}」。回复来了：用它回答这个问题，或者追问，或者交给用户。`;
    const open = db.prepare("SELECT note, origin FROM lead_waits WHERE entity_key = ? AND state = 'waiting'")
      .get(input.objectKey) as { note: string; origin: string } | undefined;
    // 同一个对话上已经有别的问题在等：备注并在一起，Lead 靠回复的内容分清答的是哪一个。
    const merged = open && open.origin !== origin && open.origin.startsWith("question:");
    const registered = registerLeadWait(db, {
      entityKey: input.objectKey,
      note: merged ? clip(`${open!.note}\n另一个问题：${note}`, LEAD_WAIT_LIMITS.noteMaxChars) : note,
      origin: merged ? "question:multiple" : origin,
      timeoutMs: Math.max(deadline - now.getTime(), LEAD_WAIT_LIMITS.minMs),
      now,
    });
    return {
      ticketId: question.ticketId, decisionId: question.decisionId ?? null, round, maxMessages: QUESTION_LIMITS.maxMessages,
      waitUntil: new Date(deadline).toISOString(), waitId: registered.wait.id,
    };
  })();
}

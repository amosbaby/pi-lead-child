// 用户在 Slack 私信里问的事，Lead 当轮派出去、之后才有结果（工单 #81 的 (c)）：用户常用手机，看不到 App。
// 用户在自己私信那一轮里让 Lead 建的工单（store 的 recordTurnTicketOrigins）和用 dispatch_agent_task 派的子 agent 工单
// （dispatchedTicketOf）记下来源私信；之后 Lead 在系统叫醒的一轮里
// （轻子 agent 交回、通道派的子 agent 交回、执行结束、用户选完决定……）写给用户的话，交给这一轮的事提到了这样的工单时，同步发到那个私信。
// 发送和用户本人那一轮的回复走同一条路（hub.replyToOwner：署名、Markdown 换成 Slack 的格式）。
// 纯内部的一轮（回 NO_REPLY、什么都没说）不发。
import { stripQuietReply } from "@pi-lead-child/protocol";
import { ticketOriginConversations, type Db } from "@pi-lead-child/store";

const TICKET_ENTITY = /^ticket:([1-9]\d{0,11})$/u;

function ticketsOf(events: ReadonlyArray<{ entityKey: string; payload?: unknown }>): number[] {
  return events.flatMap((event) => {
    const match = TICKET_ENTITY.exec(event.entityKey);
    // 通道派的子 agent 工单交回（channel.task.finished）记在通道卡上，工单编号在 payload 的 itemId 里。
    const itemId = event.payload && typeof event.payload === "object" ? (event.payload as { itemId?: unknown }).itemId : undefined;
    return [
      ...(match ? [Number(match[1])] : []),
      ...(typeof itemId === "number" && Number.isSafeInteger(itemId) && itemId > 0 ? [itemId] : []),
    ];
  });
}

/**
 * 系统叫醒的一轮写给用户的话要同步发到哪些私信：交给这一轮的事（事件的 entityKey 是 ticket:N，或者 payload 里有 itemId）
 * 提到了记过来源私信的工单。没有要发的（没说话、回 NO_REPLY、事情和私信里派的工单无关）时 conversations 是空的。
 */
export function systemReplyForOwner(
  db: Db, input: { text: string; events: ReadonlyArray<{ entityKey: string; payload?: unknown }> },
): { text: string; conversations: string[] } {
  const text = stripQuietReply(input.text);
  if (!text) return { text: "", conversations: [] };
  const tickets = ticketsOf(input.events);
  return { text, conversations: tickets.length ? ticketOriginConversations(db, tickets) : [] };
}

/**
 * Lead 在私信那一轮里用 dispatch_agent_task 派的子 agent 工单（工单由派单器以 system 的名义建，按建单人认不出来）：
 * 从工具的结果里读出工单编号。别的工具、失败的结果返回 null。
 */
export function dispatchedTicketOf(toolName: string, result: unknown): number | null {
  if (toolName !== "dispatch_agent_task") return null;
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return null;
  const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("");
  try {
    const parsed = JSON.parse(text) as { ok?: unknown; itemId?: unknown };
    return parsed.ok === true && typeof parsed.itemId === "number" && Number.isSafeInteger(parsed.itemId) && parsed.itemId > 0 ? parsed.itemId : null;
  } catch {
    return null;
  }
}

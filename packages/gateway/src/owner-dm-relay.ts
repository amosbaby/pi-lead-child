// 用户在 Slack 私信里问的事，Lead 当轮派出去、之后才有结果（工单 #81 的 (c)）：用户常用手机，看不到 App。
// 用户在自己私信那一轮里让 Lead 建的工单记下来源私信（store 的 recordTurnTicketOrigins）；之后 Lead 在系统叫醒的一轮里
// （轻子 agent 交回、执行结束、用户选完决定……）写给用户的话，交给这一轮的事提到了这样的工单时，同步发到那个私信。
// 发送和用户本人那一轮的回复走同一条路（hub.replyToOwner：署名、Markdown 换成 Slack 的格式）。
// 纯内部的一轮（回 NO_REPLY、什么都没说）不发。
import { stripQuietReply } from "@pi-lead-child/protocol";
import { ticketOriginConversations, type Db } from "@pi-lead-child/store";

const TICKET_ENTITY = /^ticket:([1-9]\d{0,11})$/u;

/** 系统叫醒的一轮写给用户的话要同步发到哪些私信。没有要发的（没说话、回 NO_REPLY、事情和私信里建的工单无关）时 conversations 是空的。 */
export function systemReplyForOwner(db: Db, input: { text: string; entityKeys: readonly string[] }): { text: string; conversations: string[] } {
  const text = stripQuietReply(input.text);
  if (!text) return { text: "", conversations: [] };
  const tickets = input.entityKeys.flatMap((key) => {
    const match = TICKET_ENTITY.exec(key);
    return match ? [Number(match[1])] : [];
  });
  return { text, conversations: tickets.length ? ticketOriginConversations(db, tickets) : [] };
}

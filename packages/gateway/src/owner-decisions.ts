// 用户自己私信里的决定请求（工单 #81）。用户常用手机，看不到 App：要用户决定的事在 Slack 私信里也能看到、能点。
//   (a) Lead 在用户私信那一轮里用 render_ui 的 ChoiceGroup 建的决定请求：那一轮回复以后，系统在同一个私信里发一条带选项的消息
//       （pushTurnChoices，每张卡一条）。
//   (b) 执行者提的、要用户回答的决定请求（受众是 user）：系统主动推到用户自己的私信（syncOwnerDecisions，daemon 每一拍调）。
//       默认规则（用户以后可以改）：每条只推一次；同一张工单 10 分钟内的几条合成一条消息（改写那条，不另发）；只要 Lead 判断的不推；
//       没有用户自己的私信时不推，每条记一条事件。只推提出不到 60 分钟的：功能上线时以前的决定请求不会一起涌进私信。
//   被回答、撤销或过期以后（不管在 App 里还是在 Slack 里），系统把那条消息改成结果（syncOwnerDecisions 比较消息上显示的状态）。
// 用户本人在自己的私信里选了一个选项（resolveOwnerDecision）：和 App 里选是同一个操作（操作层的 decision.resolve，
// performUserUiAction），凭证是那个通道的私信凭证（store 的 channelOwnerBinding，权限和 Companion 一样），来源记成 channel。
// 已经回答过、过期的不再回答，只返回它现在的样子：App 和 Slack 先后点不会重复生效。
// 「是不是用户本人点的、是不是在用户自己的私信里」由通道的 hub 认（只有认过的点击才到这里）。
import type { DecisionRequest } from "@pi-lead-child/core";
import {
  appendEvent, bindingScopes, decisionMessagesToSync, getDecisionPush, getDecisionRequest, getItem, getLocale, insertDecisionPush,
  listDecisionPushes, openDecisionMessage, recordTicketOrigin, setDecisionPushMessage, setDecisionPushShown, unpushedUserDecisions,
  type Binding, type DecisionPush, type Db,
} from "@pi-lead-child/store";
import { CHANNEL_EVENT_KINDS, type Locale } from "@pi-lead-child/protocol";
import type { ChannelOwnerChoice, OwnerChoiceCardContent } from "@pi-lead-child/engine";
import { channelOwnerSource } from "./owner-confirmations.js";
import { ownerDecisionMessages } from "./owner-decisions.messages.js";
import { performUserUiAction, type UserUiActionContext } from "./ui-action-routes.js";

// 默认规则（工单 #81）。
export const OWNER_DECISION_MERGE_MS = 10 * 60_000;
export const OWNER_DECISION_RECENT_MS = 60 * 60_000;
// 一条消息最多合几条（Slack 一条消息最多 50 个 block，一条决定请求最多占 4 个）。
export const OWNER_DECISIONS_PER_MESSAGE = 8;
// 发不出去、改不成的消息，过多久再试（同一个幂等键，来源里不会多发）。
const RETRY_MS = 60_000;

/** 发消息的那一层（daemon 里是通道的 hub）。来源不能发带按钮的消息时返回 null。 */
export interface OwnerDecisionTransport {
  sendOwnerChoices(conversation: string, content: OwnerChoiceCardContent, key: string): Promise<{ remoteRef: Record<string, string> } | null>;
  editOwnerChoices(conversation: string, message: Record<string, string>, content: OwnerChoiceCardContent): Promise<unknown>;
}

export interface OwnerDecisionDeps {
  db: Db;
  // 操作层（和网关的 performUiActionAsUser 用同一份服务）。
  uiActions: UserUiActionContext;
  transport: OwnerDecisionTransport;
  log(line: string): void;
  now?: () => Date;
}

const DECISION_TARGET = /^decision:([1-9]\d{0,11})$/u;

function decisionIdOf(target: string): number | null {
  const match = DECISION_TARGET.exec(target);
  return match ? Number(match[1]) : null;
}

function choiceOf(push: DecisionPush, request: DecisionRequest, locale: Locale): ChannelOwnerChoice {
  const m = ownerDecisionMessages(locale);
  const pending = request.state === "pending";
  const recommended = request.options.find((option) => option.id === push.recommended) ?? null;
  const lines = pending ? [
    ...request.options.filter((option) => option.description?.trim()).map((option) => m.option(option.label, option.description!)),
    ...(recommended ? [m.recommended(recommended.label, push.recommendReason)] : []),
  ] : [];
  const selected = request.options.find((option) => option.id === request.selectedOptionId);
  const result = request.state === "resolved"
    ? selected ? m.selected(selected.label) : request.resolutionText ? m.answered(request.resolutionText.slice(0, 300)) : null
    : request.state === "dismissed" ? m.dismissed(request.dismissalReason)
    : request.state === "expired" ? m.expired
    : null;
  return {
    target: `decision:${request.id}`,
    prompt: request.prompt,
    lines,
    options: request.options.map((option) => ({ label: option.label, recommended: option.id === push.recommended })),
    pending,
    // 要自己写回答的（没有选项，或者允许自己写），第一版在 Slack 里请用户去 App 里回答。
    note: !pending ? null : !request.options.length ? m.writeInApp : request.allowCustom ? m.customInApp : null,
    placeholder: m.placeholder,
    stateLabel: m.states[request.state],
    result,
    separator: m.separator,
  };
}

/** 一条消息现在的样子：里面每条决定请求现在的状态。不认识这条消息时返回 null。 */
export function ownerDecisionMessageContent(db: Db, messageKey: string): OwnerChoiceCardContent | null {
  const pushes = listDecisionPushes(db, messageKey);
  const first = pushes[0];
  if (!first) return null;
  const locale = getLocale(db);
  const decisions = pushes.flatMap((push) => {
    const request = getDecisionRequest(db, push.decisionId);
    return request ? [{ push, request }] : [];
  });
  if (!decisions.length) return null;
  const item = getItem(db, first.itemId);
  return {
    title: ownerDecisionMessages(locale).title(first.itemId, item?.display_title?.trim() || item?.title || ""),
    decisions: decisions.map(({ push, request }) => choiceOf(push, request, locale)),
  };
}

/**
 * 按库里的状态发出或者改写一条消息：还没发出去的发出去（幂等键是消息的键），发过的改成现在的样子。做成以后记下消息上显示的状态。
 * 来源不能发带按钮的消息时什么都不做。发不出去时抛错。
 */
async function syncMessage(deps: OwnerDecisionDeps, messageKey: string): Promise<void> {
  const { db } = deps;
  const pushes = listDecisionPushes(db, messageKey);
  const content = ownerDecisionMessageContent(db, messageKey);
  const first = pushes[0];
  if (!first || !content) return;
  if (!first.messageRef) {
    const sent = await deps.transport.sendOwnerChoices(first.conversation, content, messageKey);
    if (!sent) return;
    setDecisionPushMessage(db, messageKey, sent.remoteRef);
  } else {
    // 那条消息没了（targetGone）也记下现在的状态：不再改它。
    await deps.transport.editOwnerChoices(first.conversation, first.messageRef, content);
  }
  for (const push of pushes) {
    const state = getDecisionRequest(db, push.decisionId)?.state;
    if (state) setDecisionPushShown(db, push.decisionId, state);
  }
}

/** render_ui 画好的卡里的 ChoiceGroup（服务端已经给它建了决定请求，编号在 decision 里），连同卡上写的推荐。 */
export function choiceGroupsOfSurface(surface: unknown): Array<{ decisionId: number; recommended: string | null; reason: string | null }> {
  const nodes = surface && typeof surface === "object" ? (surface as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    if (!node || typeof node !== "object" || (node as { type?: unknown }).type !== "ChoiceGroup") return [];
    const props = (node as { props?: Record<string, unknown> }).props ?? {};
    const recommendation = props.recommendation as { choiceId?: unknown; reason?: unknown } | undefined;
    return typeof props.decision === "number" ? [{
      decisionId: props.decision,
      recommended: typeof recommendation?.choiceId === "string" ? recommendation.choiceId : null,
      reason: typeof recommendation?.reason === "string" ? recommendation.reason : null,
    }] : [];
  });
}

/** 推送的那一层：记着发不出去的消息什么时候再试。 */
export interface OwnerDecisionPusher {
  /** (a) Lead 在私信那一轮画的 ChoiceGroup：每张卡发一条消息。recommended、reason 是卡上写的推荐。 */
  pushTurnChoices(input: {
    conversation: string; turnId: string; choices: Array<{ decisionId: number; recommended?: string | null; reason?: string | null }>;
  }): Promise<void>;
  /** (b) 和改写：推新的执行者决定请求，把状态变了的消息改成现在的样子。ownerConversation 是用户自己的私信，没有时是 null。 */
  sync(ownerConversation: string | null): Promise<void>;
}

export function createOwnerDecisionPusher(deps: OwnerDecisionDeps): OwnerDecisionPusher {
  const now = deps.now ?? (() => new Date());
  const retryAt = new Map<string, number>();
  let syncing = false;

  async function attempt(messageKey: string): Promise<void> {
    const due = retryAt.get(messageKey);
    if (due !== undefined && due > now().getTime()) return;
    try {
      await syncMessage(deps, messageKey);
      retryAt.delete(messageKey);
    } catch (error) {
      retryAt.set(messageKey, now().getTime() + RETRY_MS);
      deps.log(`[owner-decisions] could not send ${messageKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function recordSkipped(decision: { id: number; itemId: number }): void {
    try {
      deps.db.transaction(() => appendEvent(deps.db, {
        source: "system", sourceRef: `owner-decision-skipped:${decision.id}`, kind: CHANNEL_EVENT_KINDS.ownerDecisionSkipped,
        entityKey: `decision:${decision.id}`, level: "record", occurredAt: now().toISOString(),
        payload: {
          decisionId: decision.id, ticketId: decision.itemId, reason: "no_conversation",
          summary: `决定请求 #${decision.id}（工单 #${decision.itemId}）没有推到私信：还没有用户自己的私信（用户没在私信里和 Lead 说过话，或者私信凭证撤销了）。`,
        },
      }))();
    } catch (error) {
      deps.log(`[owner-decisions] could not record the skipped decision #${decision.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    async pushTurnChoices(input) {
      for (const choice of input.choices) {
        const request = getDecisionRequest(deps.db, choice.decisionId);
        if (!request || request.state !== "pending") continue;
        const messageKey = `turn:${input.turnId}:${choice.decisionId}`;
        insertDecisionPush(deps.db, {
          decisionId: request.id, itemId: request.itemId, conversation: input.conversation, messageKey, shownState: request.state,
          recommended: choice.recommended ?? null, recommendReason: choice.reason ?? null, now: now(),
        });
        // 已经推过的（同一张卡在别的消息里）只同步它自己那条。
        await attempt(getDecisionPush(deps.db, request.id)!.messageKey);
      }
    },

    async sync(ownerConversation) {
      if (syncing) return;
      syncing = true;
      try {
        const at = now();
        for (const decision of unpushedUserDecisions(deps.db, { since: new Date(at.getTime() - OWNER_DECISION_RECENT_MS) })) {
          if (!ownerConversation) {
            recordSkipped(decision);
            continue;
          }
          const messageKey = openDecisionMessage(deps.db, {
            conversation: ownerConversation, itemId: decision.itemId, since: new Date(at.getTime() - OWNER_DECISION_MERGE_MS),
            max: OWNER_DECISIONS_PER_MESSAGE,
          }) ?? `push:${decision.id}`;
          insertDecisionPush(deps.db, {
            decisionId: decision.id, itemId: decision.itemId, conversation: ownerConversation, messageKey, shownState: "pending", now: at,
          });
        }
        const unsentSince = new Date(at.getTime() - OWNER_DECISION_RECENT_MS);
        for (const messageKey of decisionMessagesToSync(deps.db, { unsentSince })) await attempt(messageKey);
      } finally {
        syncing = false;
      }
    },
  };
}

/**
 * 用户本人在自己的私信里选了一个选项：按 App 里选的同一个操作回答，返回那条消息现在的样子（整条消息）。
 * 不认识这个对象（不是推到私信的决定请求）时返回 null。已经回答过、过期的不再回答：返回它现在的样子。
 * 这次真的回答了时，记下这张工单的来源私信：Lead 被叫醒以后为它写给用户的话也发回这个私信。
 */
export async function resolveOwnerDecision(
  deps: Pick<OwnerDecisionDeps, "db" | "uiActions" | "log" | "now">,
  request: { target: string; option: number; binding: Binding; conversation: string },
): Promise<OwnerChoiceCardContent | null> {
  const { db } = deps;
  const decisionId = decisionIdOf(request.target);
  const push = decisionId === null ? null : getDecisionPush(db, decisionId);
  const before = decisionId === null ? undefined : getDecisionRequest(db, decisionId);
  if (!push || !before) return null;
  const option = Number.isInteger(request.option) ? before.options[request.option] : undefined;
  if (before.state === "pending" && option) {
    try {
      await performUserUiAction(deps.uiActions, {
        target: { type: "decision", id: before.id }, action: "resolve", input: { decision: "select", optionId: option.id },
        binding: request.binding, scopes: bindingScopes(request.binding), source: channelOwnerSource(request.binding),
      });
    } catch (error) {
      // 两次点击同时到、刚好过期、App 里刚答了：操作层拒绝了，消息显示它现在的状态。
      deps.log(`[owner-decisions] ${request.target}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (getDecisionRequest(db, before.id)?.state === "resolved") {
      recordTicketOrigin(db, { itemId: before.itemId, conversation: request.conversation, now: (deps.now ?? (() => new Date()))() });
    }
  } else if (before.state === "pending") {
    deps.log(`[owner-decisions] ${request.target}: option ${request.option} is not one of the ${before.options.length} options`);
  }
  return ownerDecisionMessageContent(db, push.messageKey);
}

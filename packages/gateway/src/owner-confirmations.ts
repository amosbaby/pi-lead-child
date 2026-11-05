// 用户自己私信里的确认消息（工单 #72）：Lead 在用户发给自己的私信那一轮里产出的两种确认（改规则的确认卡 confirm_rule_change、
// 连接的写入确认 confirm_write），系统在那条私信里另发一条带「确认这一次」「不改」按钮的消息。这里有两件事：
//   1. 消息上写什么（ownerConfirmationContent）：和 App 里的卡同样的标题、原因和参数，按用户选的语言。
//   2. 用户本人点了按钮以后做什么（resolveOwnerConfirmation）：和 App 里点卡是同一份实现、同一个账本——
//      改规则的确认卡走操作层的 rule_change.resolve（performUserUiAction，和 /v1/rule-changes/:id/resolve 一样）；
//      写入确认走 resolveConnectionConfirmationAsUser（和 /v1/connections/confirmations/:id/resolve 一样），再记一次主人操作。
//      凭证是那个通道的私信凭证（store 的 channelOwnerBinding，权限和 Companion 一样），来源记成 channel：
//      账本、主人操作和确认的 resolvedBy 里都看得出是在通道里点的。
//      只执行存下的那一次，参数不变；「不改」作废。已经处理过、过期的确认不再执行，只返回它现在的状态。
// 「是不是用户本人点的、是不是在用户自己的私信里」由通道的 hub 认（只有认过的点击才到这里）。
import {
  RULE_CHANGE_CONFIRMATION_ID, userActionTargetParts,
  type ConnectionConfirmationDto, type Locale, type OwnerActionSource, type RuleChangeConfirmationDto, type UserActionRequest,
} from "@pi-lead-child/protocol";
import { bindingScopes, getLocale, leadDisplayName, recordOwnerAction, type Binding, type Db } from "@pi-lead-child/store";
import { getRuleChangeConfirmation, type OwnerConfirmCardContent } from "@pi-lead-child/engine";
import { resolveConnectionConfirmationAsUser, type ConnectionsService } from "./connections-routes.js";
import { ownerConfirmationMessages } from "./owner-confirmations.messages.js";
import { performUserUiAction, type UserUiActionContext } from "./ui-action-routes.js";

export interface OwnerConfirmationDeps {
  db: Db;
  // 操作层（和网关的 performUiActionAsUser 用同一份服务）。
  uiActions: UserUiActionContext;
  // 连接中心。没有时写入确认处理不了（返回 null）。
  connections?: Pick<ConnectionsService, "confirmation" | "resolveConfirmation">;
  log(line: string): void;
}

const CONNECTION_CONFIRMATION_ID = /^cfm_[A-Za-z0-9_-]{8,40}$/;

/** 这一种「需要用户做什么」在用户自己的私信里带按钮：改规则的确认卡和连接的写入确认。 */
export function isOwnerConfirmationAction(action: UserActionRequest): boolean {
  return action.kind === "confirm_rule_change" || action.kind === "confirm_write";
}

type Target = { kind: "rule_change"; id: string } | { kind: "connection_confirmation"; id: string };

function targetOf(target: string): Target | null {
  const parts = userActionTargetParts(target);
  if (parts?.prefix === "rule_change" && RULE_CHANGE_CONFIRMATION_ID.test(parts.id)) return { kind: "rule_change", id: parts.id };
  if (parts?.prefix === "connection_confirmation" && CONNECTION_CONFIRMATION_ID.test(parts.id)) {
    return { kind: "connection_confirmation", id: parts.id };
  }
  return null;
}

function ruleChangeContent(target: string, confirmation: RuleChangeConfirmationDto, leadName: string, locale: Locale): OwnerConfirmCardContent {
  const m = ownerConfirmationMessages(locale);
  const r = m.ruleChange;
  const state = confirmation.state;
  const result = state === "done" || state === "failed" ? confirmation.resultPreview
    : state === "running" ? r.running
    : state === "declined" ? r.declined
    : state === "expired" ? r.expired(leadName)
    : null;
  return {
    target,
    title: r.title(leadName, confirmation.label),
    facts: [
      ...(confirmation.name ? [{ label: r.target, value: confirmation.name }] : []),
      { label: r.reason, value: confirmation.reason },
      { label: r.blocked, value: confirmation.why },
    ],
    params: confirmation.params.map((param) => ({ name: param.name, value: param.value })),
    pending: state === "pending",
    confirmLabel: m.confirm, declineLabel: m.decline, separator: m.separator,
    stateLabel: r.states[state], result,
  };
}

function connectionContent(target: string, confirmation: ConnectionConfirmationDto, locale: Locale): OwnerConfirmCardContent {
  const m = ownerConfirmationMessages(locale);
  const c = m.connection;
  const state = confirmation.state;
  const result = state === "done" || state === "failed" ? confirmation.resultPreview
    : state === "running" ? c.running
    : state === "rejected" ? c.rejected
    : state === "expired" ? c.expired
    : null;
  return {
    target,
    title: c.title(confirmation.label),
    facts: [{ label: c.summary, value: confirmation.summary }],
    params: [{ name: "tool", value: confirmation.tool }, { name: "args", value: confirmation.argumentsPreview }],
    pending: state === "pending",
    confirmLabel: m.confirm, declineLabel: m.decline, separator: m.separator,
    stateLabel: c.states[state], result,
  };
}

function connectionConfirmation(deps: OwnerConfirmationDeps, id: string): ConnectionConfirmationDto | null {
  if (!deps.connections) return null;
  try {
    return deps.connections.confirmation(id);
  } catch {
    // 没有这个确认（daemon 重启以后没确认的写入都作废，结束超过 30 分钟的也删了）。
    return null;
  }
}

/** 确认消息上写什么（这个确认现在的样子）。不认识这个对象、找不到这个确认时返回 null。 */
export function ownerConfirmationContent(deps: OwnerConfirmationDeps, target: string): OwnerConfirmCardContent | null {
  const parsed = targetOf(target);
  if (!parsed) return null;
  const locale = getLocale(deps.db);
  if (parsed.kind === "rule_change") {
    const confirmation = getRuleChangeConfirmation(deps.db, parsed.id);
    return confirmation ? ruleChangeContent(target, confirmation, leadDisplayName(deps.db), locale) : null;
  }
  const confirmation = connectionConfirmation(deps, parsed.id);
  return confirmation ? connectionContent(target, confirmation, locale) : null;
}

/** 在通道里点的：主人操作和账本里的来源。 */
export function channelOwnerSource(binding: Binding): OwnerActionSource {
  return { client: "channel", deviceName: binding.display_name, loopback: false, fromThisMachine: false };
}

/**
 * 用户本人在自己的私信里点了按钮：按 App 里点卡的同一份实现决定这一次，返回点完以后的确认消息。
 * 不认识这个对象、找不到这个确认时返回 null。已经处理过、过期的不再执行：返回它现在的状态。
 */
export async function resolveOwnerConfirmation(
  deps: OwnerConfirmationDeps, request: { target: string; decision: "confirm" | "decline"; binding: Binding },
): Promise<OwnerConfirmCardContent | null> {
  const parsed = targetOf(request.target);
  if (!parsed) return null;
  const { db } = deps;
  const { binding } = request;
  const source = channelOwnerSource(binding);
  if (parsed.kind === "rule_change") {
    const before = getRuleChangeConfirmation(db, parsed.id);
    if (!before) return null;
    if (before.state === "pending") {
      try {
        await performUserUiAction(deps.uiActions, {
          target: { type: "rule_change", id: parsed.id }, action: "resolve", input: { decision: request.decision },
          binding, scopes: bindingScopes(binding), source,
        });
      } catch (error) {
        // 两次点击同时到、刚好过期、凭证缺权限：操作层拒绝了，消息显示它现在的状态。
        deps.log(`[owner-confirm] ${request.target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return ownerConfirmationContent(deps, request.target);
  }
  const before = connectionConfirmation(deps, parsed.id);
  if (!before) return null;
  if (before.state === "pending") {
    const { ownerAction } = await resolveConnectionConfirmationAsUser(
      deps.connections!, parsed.id, request.decision === "confirm", `${binding.display_name}（binding ${binding.id}）`, getLocale(db),
    );
    try {
      recordOwnerAction(db, { ...ownerAction, undo: { ...ownerAction.undo }, credential: binding, source });
    } catch (error) {
      deps.log(`[owner-confirm] failed to record the owner action for ${request.target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return ownerConfirmationContent(deps, request.target);
}

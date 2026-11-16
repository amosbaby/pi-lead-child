// 设置 → 模型的订阅（模型配置方案 C 的 S3）用的纯函数：接入列表的订阅行、额度条、登录状态、换号方式和时间段。
// 数据是模型设置 DTO 的可选字段 subscriptions（protocol 的 model-subscriptions.ts，切片 S2）。
import {
  subscriptionAccountOf, subscriptionSlotSpec,
  type Locale, type ModelSettingsDto, type Subscription, type SubscriptionAccount, type SubscriptionBase, type SubscriptionDay,
  type SubscriptionLogin, type SubscriptionQuotaWindow, type SubscriptionsDto, type SubscriptionWindow,
} from '@pi-lead-child/protocol';

import { intlLocale } from '@/i18n';

import { slotLabel } from './modelSettingsModel';
import { subscriptionsMessages } from './subscriptions.messages';

/** 已用到这个比例（%）时，额度条和数字变成琥珀色，旁边写「快用完了」（画板 C-Settings-Desktop 的 91%）。 */
export const NEARLY_USED_PERCENT = 80;

export const SUBSCRIPTION_DAYS: readonly SubscriptionDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS: readonly SubscriptionDay[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const WEEKEND: readonly SubscriptionDay[] = ['sat', 'sun'];

/** daemon 给的订阅。旧 daemon 不给时为 null。 */
export function subscriptionsOf(dto: ModelSettingsDto): SubscriptionsDto | null {
  return dto.subscriptions ?? null;
}

export function subscriptionOf(dto: ModelSettingsDto, base: SubscriptionBase): Subscription | null {
  return subscriptionsOf(dto)?.subscriptions.find((entry) => entry.base === base) ?? null;
}

/** 账号的名字：用户起的名字，没有时用邮箱，再没有时写「账号 n」。 */
export function accountName(account: SubscriptionAccount, locale: Locale): string {
  return account.label ?? account.email ?? subscriptionsMessages(locale).accountN(account.index);
}

/** 账号名字下面的一句：邮箱和套餐。 */
export function accountIdentity(account: SubscriptionAccount): string {
  return [account.label ? account.email : null, account.plan].filter(Boolean).join(' · ');
}

/** 额度窗口的名字：daemon 写 5h、7d，界面写「5 小时」「7 天」。认不出时原样写。 */
export function quotaWindowName(label: string, locale: Locale): string {
  const m = subscriptionsMessages(locale);
  const match = /^(\d+)([hd])$/.exec(label);
  if (!match) return label;
  const count = Number(match[1]);
  return match[2] === 'h' ? m.windowHours(count) : m.windowDays(count);
}

export type QuotaBar = {
  key: string;
  name: string;
  /** 已用的比例（0 到 100）。daemon 不知道时为 null。 */
  used: number | null;
  /** 快用完了：琥珀色，旁边有文字（状态不只靠颜色，P13.3）。 */
  near: boolean;
  /** 「24%」。不知道时写「不知道」。 */
  percent: string;
  /** 「24% · 16:40 重置」。没有重置时间时和 percent 一样。 */
  detail: string;
};

/** 账号的额度条：一个窗口一条，写已用的比例（画板：额度条是已用的比例）。 */
export function quotaBars(account: SubscriptionAccount, now: Date, locale: Locale): QuotaBar[] {
  const m = subscriptionsMessages(locale);
  return (account.quota?.windows ?? []).map((window: SubscriptionQuotaWindow, index) => {
    const used = window.remainingPercent === null ? null : Math.round(100 - window.remainingPercent);
    const percent = used === null ? m.quotaUnknown : m.used(used);
    return {
      key: `${window.label}-${index}`,
      name: quotaWindowName(window.label, locale),
      used,
      near: used !== null && used >= NEARLY_USED_PERCENT,
      percent,
      detail: window.resetAt ? m.usedReset(percent, resetLabel(window.resetAt, now, locale)) : percent,
    };
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 重置的时刻：今天写「16:40」，一周以内写「周一 16:40」，更远写「11-24 16:40」（P14.2）。 */
export function resetLabel(iso: string, now: Date, locale: Locale): string {
  const date = new Date(iso);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return time;
  const days = (date.getTime() - now.getTime()) / 86_400_000;
  if (days < 6.5) return `${new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'short' }).format(date)} ${time}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/**
 * 正在用的账号：大脑现在的模型就是这个账号的（<base>-<n>/<id>），或者写的是 <base>/<id> 而这种订阅只有一个登录了的账号。
 * 有几个账号时 pi-multi-pass 在 pool 里自己换号，daemon 不知道它这一刻用哪一个：这时不标。
 */
export function activeAccount(dto: ModelSettingsDto, subscription: Subscription): string | null {
  const current = dto.brain.current.model;
  const slash = current.indexOf('/');
  const provider = slash > 0 ? current.slice(0, slash) : current;
  const account = subscriptionAccountOf(provider);
  if (!account || account.base !== subscription.base) return null;
  const loggedIn = subscription.accounts.filter((entry) => entry.loggedIn);
  if (provider === subscription.base) return loggedIn.length === 1 ? loggedIn[0]!.provider : null;
  return loggedIn.some((entry) => entry.provider === provider) ? provider : null;
}

/** 这种订阅的模型在分工里的位置（「主用」「备用 1」）。<base>-<n>/<id> 和 <base>/<id> 是同一格（D5）。 */
export function subscriptionRoles(dto: ModelSettingsDto, base: SubscriptionBase, locale: Locale): string[] {
  return dto.brain.chain.flatMap((choice, slot) => (subscriptionSlotSpec(choice.model).startsWith(`${base}/`) ? [slotLabel(slot, locale)] : []));
}

/** 订阅行名字后面的一句：账号数，有两个以上账号时加换号方式。 */
export function subscriptionSummary(subscription: Subscription, locale: Locale): string {
  const m = subscriptionsMessages(locale);
  const parts = [m.accounts(subscription.accounts.length)];
  if (subscription.accounts.length >= 2) parts.push(m.strategies[subscription.strategy]);
  return parts.join(' · ');
}

/** 订阅行右边：模型数和在分工里的位置。 */
export function subscriptionUse(dto: ModelSettingsDto, subscription: Subscription, locale: Locale): string {
  const m = subscriptionsMessages(locale);
  return [m.models(subscription.models.length), ...subscriptionRoles(dto, subscription.base, locale)].join(' · ');
}

/** 这种订阅还没结束的登录（开始了、在等用户）。同一种订阅同时只有一个（daemon 会取消旧的）。 */
export function openLogin(dto: ModelSettingsDto, base: SubscriptionBase): SubscriptionLogin | null {
  const logins = subscriptionsOf(dto)?.logins ?? [];
  return logins.find((login) => login.base === base && (login.state === 'starting' || login.state === 'waiting')) ?? null;
}

export function loginById(dto: ModelSettingsDto, id: string | null): SubscriptionLogin | null {
  if (id === null) return null;
  return subscriptionsOf(dto)?.logins.find((login) => login.id === id) ?? null;
}

/** 「0:42」「14:20」「1:02:05」：等了多久、码还剩多久。 */
export function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 码还剩多少毫秒。没有失效时间时为 null。 */
export function msUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? null : at - now.getTime();
}

/** 设备页的地址去掉 https://，显示得短一些。 */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// ── 按时间段换号 ───────────────────────────────────────────────────────────────

/** 「工作日」「周末」「每天」，其余写「一、三、五」。 */
export function daysLabel(days: readonly SubscriptionDay[] | undefined, locale: Locale): string | null {
  const m = subscriptionsMessages(locale);
  if (!days || days.length === 0) return null;
  const set = new Set(days);
  const same = (list: readonly SubscriptionDay[]) => set.size === list.length && list.every((day) => set.has(day));
  if (same(SUBSCRIPTION_DAYS)) return m.everyDay;
  if (same(WEEKDAYS)) return m.weekdays;
  if (same(WEEKEND)) return m.weekends;
  return SUBSCRIPTION_DAYS.filter((day) => set.has(day)).map((day) => m.dayNames[day]).join(locale === 'zh' ? '、' : ', ');
}

/** 一个时间段：「工作日 9–17」。只有日期范围时写日期。 */
export function windowLabel(window: SubscriptionWindow, locale: Locale): string {
  const m = subscriptionsMessages(locale);
  const parts = [
    daysLabel(window.days, locale),
    window.hours ? m.hourRange(window.hours[0], window.hours[1]) : null,
    window.dateRange ? `${window.dateRange.from ?? ''}–${window.dateRange.to ?? ''}` : null,
  ].filter(Boolean);
  return parts.join(' ');
}

/** 按时间段换号时账号的一行：「优先 · 工作日 9–17」。 */
export function scheduleLine(account: SubscriptionAccount, locale: Locale): string {
  const m = subscriptionsMessages(locale);
  return [m.roles[account.role], ...account.windows.map((window) => windowLabel(window, locale))].join(' · ');
}

export type WindowForm = { days: SubscriptionDay[]; from: string; to: string };

export const EMPTY_WINDOW_FORM: WindowForm = { days: [...WEEKDAYS], from: '9', to: '17' };

/** 时间段表单换成 daemon 的 SubscriptionWindow。钟点 0–23 开始、1–24 结束；开始比结束大时跨午夜（22–6）。 */
export function windowFromForm(form: WindowForm, locale: Locale): { ok: true; window: SubscriptionWindow } | { ok: false; problem: string } {
  const problem = { ok: false as const, problem: subscriptionsMessages(locale).windowProblem };
  const hour = (text: string) => (/^\d{1,2}$/.test(text.trim()) ? Number(text.trim()) : null);
  const from = hour(form.from);
  const to = hour(form.to);
  if (form.days.length === 0 || from === null || to === null || from > 23 || to > 24 || from === to) return problem;
  const days = SUBSCRIPTION_DAYS.filter((day) => form.days.includes(day));
  return { ok: true, window: { days, hours: [from, to] } };
}

export function toggleDay(days: readonly SubscriptionDay[], day: SubscriptionDay): SubscriptionDay[] {
  return days.includes(day) ? days.filter((entry) => entry !== day) : SUBSCRIPTION_DAYS.filter((entry) => entry === day || days.includes(entry));
}

export const SUBSCRIPTION_LABEL_MAX = 40;

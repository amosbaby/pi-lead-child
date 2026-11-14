// 「等了多久」的文字。收件箱、日程、项目和工单列表共用。
// 单独放一个文件（2026-11-13）：放在 inboxModel 里时，inboxModel 和 timelineModel 互相引用，Metro 每次刷新都报 Require cycle。
import { DEFAULT_LOCALE, type Locale } from '@/i18n';

import { inboxMessages } from './inbox.messages';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 等了多久，用最大的整单位：51 天、3 小时、12 分钟；不到一分钟是「刚刚」。 */
export function waitedText(since: string, now: Date = new Date(), locale: Locale = DEFAULT_LOCALE): string {
  const m = inboxMessages(locale);
  const elapsed = now.getTime() - new Date(since).getTime();
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return m.justNow;
  if (elapsed >= DAY) return m.days(Math.floor(elapsed / DAY));
  if (elapsed >= HOUR) return m.hours(Math.floor(elapsed / HOUR));
  return m.minutes(Math.floor(elapsed / MINUTE));
}

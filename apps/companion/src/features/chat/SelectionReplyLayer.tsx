// 原生：没有选字回复（RN 的 Text 拿不到选区）。引用从右滑和长按一段开始（QuotableBlock，设计规范 P17.10）。
export function SelectionReplyLayer(_props: { enabled: boolean; onSendNow: () => void }) {
  return null;
}

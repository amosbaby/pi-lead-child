// /stop（用户 2026-11-03）：停下 Lead 正在进行的一轮。daemon 自己答，不交给 Lead：Lead 在等一条很久的命令时，
// 交给它的话要等那条命令结束才看得到（那一次是一条扫进 node_modules 的 grep -r，15 分钟没有结束）。

/** 整条消息只有 `/stop`（不分大小写，两头的空白不算）。别的消息返回 false，照常交给 Lead。 */
export function isStopCommand(message: string): boolean {
  return /^\/stop$/i.test(message.trim());
}

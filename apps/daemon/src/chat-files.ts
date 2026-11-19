// 用户发给 Lead 的文件写到哪里（protocol 的 chat-files.ts）。
//
// 每一轮一个文件夹：数据目录的 chat-files/<轮次>/。Lead 的 read 和 bash 能读数据目录（只挡 config.json 这类凭证，
// core 的 DATA_DIR_DENY_READ），沙箱不让写这里（数据目录里只有 lead-scratch 和 light-tasks 能写，core 的 dataDirDenyWrite）：
// 文件夹里的是用户给的原件，Lead 要改先复制到自己的临时目录。
// 库里的 chat_files 是原件（store 的 chat-files.ts），这里的是给 Lead 读的副本：新的一轮写一次，重启后重建消息时
// 缺了的再写一份。交给 Lead 的路径把用户目录写成 ~（AGENTS.md：发给模型的文字不带真的 home 路径）。
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { tildeHome } from "@pi-lead-child/core";
import type { LeadUserFile } from "@pi-lead-child/lead";
import type { StoredChatFile } from "@pi-lead-child/store";

export const CHAT_FILES_DIR = "chat-files";

const SAFE_FOLDER = /^[A-Za-z0-9_-]{1,128}$/u;

// 一轮的文件夹。轮次编号只有字母、数字、_ 和 - 时直接用它，否则用它的散列（外部通道给的编号可能带别的字符）。
export function chatTurnFilesDir(dataDir: string, turnId: string): string {
  const folder = SAFE_FOLDER.test(turnId) ? turnId : `turn-${createHash("sha256").update(turnId).digest("hex").slice(0, 32)}`;
  return join(resolve(dataDir), CHAT_FILES_DIR, folder);
}

// 一个文件在这一轮文件夹里的路径。磁盘上的名字带目录、是 . 或 ..、或者解析后跑出文件夹时报错，不去写。
function chatFilePath(dir: string, diskName: string): string {
  const path = resolve(dir, diskName);
  if (!diskName || diskName === "." || diskName === ".." || basename(diskName) !== diskName || dirname(path) !== dir) {
    throw new Error(`chat file name escapes its folder: ${JSON.stringify(diskName)}`);
  }
  return path;
}

// 把一轮的文件写进它的文件夹，返回交给 Lead 的清单（envelope.ts 的 LeadUserFile）。
// 已经在、大小也对的文件不再写；大小不对的、被换成链接的先删掉再写。同名的是目录时报错，不去删
// （daemon 进程里不做递归删除，见 host-isolation-architecture.test.ts）。
export function writeChatTurnFiles(
  dataDir: string, turnId: string, files: readonly StoredChatFile[], options: { home?: string } = {},
): LeadUserFile[] {
  if (!files.length) return [];
  const dir = chatTurnFilesDir(dataDir, turnId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const home = options.home ?? homedir();
  return files.map((file) => {
    const path = chatFilePath(dir, file.diskName);
    let existing: ReturnType<typeof lstatSync> | null = null;
    try {
      existing = lstatSync(path);
    } catch {
      existing = null;
    }
    if (!existing || !existing.isFile() || existing.size !== file.data.length) {
      if (existing?.isDirectory()) throw new Error(`a directory is in the way of chat file ${JSON.stringify(file.diskName)}`);
      if (existing) unlinkSync(path);
      writeFileSync(path, file.data, { mode: 0o600, flag: "wx" });
    }
    return { name: file.name, mimeType: file.mimeType, size: file.data.length, path: tildeHome(path, home) };
  });
}

// 写到一半失败时，删掉这一轮的文件夹（这一轮也没存下）。文件夹里只有这一轮的几个文件：逐个删掉，再删空文件夹；
// 删不掉的留着，不报错。
export function removeChatTurnFiles(dataDir: string, turnId: string): void {
  const dir = chatTurnFilesDir(dataDir, turnId);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // 不是文件（例如目录）：留着。
    }
  }
  try {
    rmdirSync(dir);
  } catch {
    // 不是空的：留着。
  }
}

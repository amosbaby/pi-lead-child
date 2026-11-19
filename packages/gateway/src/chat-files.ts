// chat.send 带的文件（protocol 的 chat-files.ts）：校验，再解码成字节交给 daemon。
// 形状（个数、单个 base64 的长度、名字的长度）由 schema 管；这里管 schema 管不到的：base64 能不能解、解码后的大小、
// 名字清理（去掉目录部分，拒收 . 和 ..、控制字符）、MIME 类型规整。文件内容不看：什么类型都收。
import { Value } from "typebox/value";

import {
  CHAT_FILE_MAX_BYTES, CHAT_FILE_MAX_COUNT, CHAT_FILES_MAX_TOTAL_BASE64_LENGTH, ChatFilesInputSchema, normalizeChatFileMimeType,
  sanitizeChatFileName, type ChatFileInput,
} from "@pi-lead-child/protocol";
import type { ChatFileData } from "@pi-lead-child/store";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type DecodedChatFiles = { ok: true; files: ChatFileData[] } | { ok: false; error: string };

export function decodeChatFiles(raw: unknown): DecodedChatFiles {
  if (!Value.Check(ChatFilesInputSchema, raw)) {
    return {
      ok: false,
      error: `files must be 1 to ${CHAT_FILE_MAX_COUNT} files, each { name, mimeType?, data } with base64 data of at most 10 MB`,
    };
  }
  const files = raw as ChatFileInput[];
  const total = files.reduce((sum, file) => sum + file.data.length, 0);
  if (total > CHAT_FILES_MAX_TOTAL_BASE64_LENGTH) return { ok: false, error: "files are too large in total" };
  const decoded: ChatFileData[] = [];
  for (const [index, file] of files.entries()) {
    const name = sanitizeChatFileName(file.name);
    if (!name.ok) return { ok: false, error: `file ${index + 1}: ${name.error}` };
    if (file.data.length % 4 !== 0 || !BASE64.test(file.data)) {
      return { ok: false, error: `file ${index + 1} is not valid base64` };
    }
    const data = Buffer.from(file.data, "base64");
    if (data.length > CHAT_FILE_MAX_BYTES) return { ok: false, error: `file ${index + 1} is larger than 10 MB` };
    decoded.push({ name: name.name, mimeType: normalizeChatFileMimeType(file.mimeType), data });
  }
  return { ok: true, files: decoded };
}

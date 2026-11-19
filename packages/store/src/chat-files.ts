// 用户发给 Lead 的文件（protocol 的 chat-files.ts）。表在 schema.ts 的 chat_files（由 SCHEMA 建，不占迁移号）。
import { randomBytes } from "node:crypto";

import { chatFileDiskNames, sanitizeChatFileName, type ChatFileRef } from "@pi-lead-child/protocol";

import type { Db } from "./db.js";

// 一个要存的文件。name 是清理过的名字（网关的 sanitizeChatFileName），mimeType 是规整过的类型。
export interface ChatFileData {
  name: string;
  mimeType: string;
  data: Buffer;
}

// 存下的一个文件。diskName：写进这一轮文件夹时用的名字（同一轮里去过重、限过长）。
export interface StoredChatFile extends ChatFileData {
  id: string;
  turnId: string;
  diskName: string;
}

export interface StoredChatFileRef extends ChatFileRef {
  diskName: string;
}

const isoNow = (now?: Date) => (now ?? new Date()).toISOString();

type ChatFileRow = { id: string; turn_id: string; name: string; disk_name: string; mime_type: string; byte_size: number; data: Buffer };

const toStored = (row: ChatFileRow): StoredChatFile => ({
  id: row.id, turnId: row.turn_id, name: row.name, diskName: row.disk_name, mimeType: row.mime_type, data: row.data,
});

// 存下一轮带的文件，按给的顺序。返回每个的 id、名字、类型、大小和磁盘上的名字。调用方和建这一轮放在同一个事务里。
// 名字再清理一次：调用方没清理时，这里也不让名字带目录。
export function insertChatFiles(db: Db, turnId: string, files: readonly ChatFileData[], now?: Date): StoredChatFileRef[] {
  const names = files.map((file) => {
    const sanitized = sanitizeChatFileName(file.name);
    if (!sanitized.ok) throw new Error(`invalid chat file name: ${sanitized.error}`);
    return sanitized.name;
  });
  const diskNames = chatFileDiskNames(names);
  const insert = db.prepare(
    `INSERT INTO chat_files (id, turn_id, position, name, disk_name, mime_type, byte_size, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = isoNow(now);
  return files.map((file, position) => {
    const id = `file_${randomBytes(12).toString("base64url")}`;
    const name = names[position]!;
    const diskName = diskNames[position]!;
    insert.run(id, turnId, position, name, diskName, file.mimeType, file.data.length, file.data, createdAt);
    return { id, name, mimeType: file.mimeType, size: file.data.length, diskName };
  });
}

// 一轮带的文件（带内容），按发送时的顺序。没有时是空数组。
export function listTurnChatFiles(db: Db, turnId: string): StoredChatFile[] {
  const rows = db.prepare(
    "SELECT id, turn_id, name, disk_name, mime_type, byte_size, data FROM chat_files WHERE turn_id = ? ORDER BY position",
  ).all(turnId) as ChatFileRow[];
  return rows.map(toStored);
}

// 几轮各带了哪些文件（不读内容）。没有文件的轮次不在结果里。
export function listChatFileRefs(db: Db, turnIds: readonly string[]): Map<string, ChatFileRef[]> {
  const refs = new Map<string, ChatFileRef[]>();
  if (!turnIds.length) return refs;
  const select = db.prepare(
    `SELECT id, turn_id, name, mime_type, byte_size FROM chat_files
     WHERE turn_id IN (SELECT value FROM json_each(?)) ORDER BY turn_id, position`,
  );
  for (const row of select.all(JSON.stringify(turnIds)) as Array<Omit<ChatFileRow, "disk_name" | "data">>) {
    const list = refs.get(row.turn_id) ?? [];
    list.push({ id: row.id, name: row.name, mimeType: row.mime_type, size: row.byte_size });
    refs.set(row.turn_id, list);
  }
  return refs;
}

export function getChatFile(db: Db, id: string): StoredChatFile | null {
  const row = db.prepare("SELECT id, turn_id, name, disk_name, mime_type, byte_size, data FROM chat_files WHERE id = ?").get(id) as
    ChatFileRow | undefined;
  return row ? toStored(row) : null;
}

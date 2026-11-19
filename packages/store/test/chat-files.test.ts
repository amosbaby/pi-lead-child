// 用户发给 Lead 的文件按轮次存（chat_files，由 SCHEMA 建，不占迁移号）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";

import { getChatFile, insertChatFiles, listChatFileRefs, listTurnChatFiles } from "../src/chat-files.js";
import { createTurn } from "../src/conversations.js";
import { openDb, type Db } from "../src/db.js";

let path: string;
let db: Db;
beforeEach(() => {
  path = join(tempDir("plc-"), "plc.db");
  db = openDb(path);
});

const log = Buffer.from("2026-11-19 error: disk full\n");
const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2]);

describe("chat files", () => {
  it("keeps a turn's files in the order they were sent, with their bytes intact", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "看看这两个文件" });
    const refs = insertChatFiles(db, turn.id, [
      { name: "app.log", mimeType: "text/plain", data: log },
      { name: "bundle.zip", mimeType: "application/zip", data: zip },
    ]);

    expect(refs.map(({ name, mimeType, size }) => ({ name, mimeType, size }))).toEqual([
      { name: "app.log", mimeType: "text/plain", size: log.length },
      { name: "bundle.zip", mimeType: "application/zip", size: zip.length },
    ]);
    expect(refs.every((ref) => /^file_[A-Za-z0-9_-]+$/.test(ref.id))).toBe(true);
    expect(listTurnChatFiles(db, turn.id).map((file) => file.data)).toEqual([log, zip]);
    expect(getChatFile(db, refs[1]!.id)).toEqual({
      id: refs[1]!.id, turnId: turn.id, name: "bundle.zip", diskName: "bundle.zip", mimeType: "application/zip", data: zip,
    });
    expect(getChatFile(db, "file_missing")).toBeNull();
  });

  it("gives files with the same name different disk names, and never keeps directory parts", () => {
    const turn = createTurn(db, { originKind: "paired:companion", userText: "" });
    const refs = insertChatFiles(db, turn.id, [
      { name: "a.txt", mimeType: "text/plain", data: log },
      { name: "A.txt", mimeType: "text/plain", data: log },
      { name: "../../x", mimeType: "application/octet-stream", data: zip },
    ]);
    expect(refs.map((ref) => ref.name)).toEqual(["a.txt", "A.txt", "x"]);
    expect(refs.map((ref) => ref.diskName)).toEqual(["a.txt", "A (2).txt", "x"]);
    expect(() => insertChatFiles(db, turn.id, [{ name: "..", mimeType: "text/plain", data: log }])).toThrow(/file name/u);
  });

  it("lists the file refs of several turns without their contents, leaving out turns without files", () => {
    const first = createTurn(db, { originKind: "paired:companion", userText: "一" });
    const plain = createTurn(db, { originKind: "paired:companion", userText: "没有文件" });
    const second = createTurn(db, { originKind: "paired:companion", userText: "" });
    insertChatFiles(db, first.id, [{ name: "app.log", mimeType: "text/plain", data: log }]);
    insertChatFiles(db, second.id, [{ name: "bundle.zip", mimeType: "application/zip", data: zip }]);

    const refs = listChatFileRefs(db, [first.id, plain.id, second.id]);
    expect(refs.get(first.id)).toEqual([{ id: expect.any(String), name: "app.log", mimeType: "text/plain", size: log.length }]);
    expect(refs.get(second.id)?.map((ref) => ref.name)).toEqual(["bundle.zip"]);
    expect(refs.has(plain.id)).toBe(false);
    expect(listChatFileRefs(db, []).size).toBe(0);
    expect(listTurnChatFiles(db, plain.id)).toEqual([]);
  });

  it("creates the table on a database opened before files existed, and keeps rows across reopening", () => {
    db.exec("DROP TABLE chat_files");
    db.close();
    db = openDb(path);
    const turn = createTurn(db, { originKind: "paired:companion", userText: "老库" });
    const [ref] = insertChatFiles(db, turn.id, [{ name: "app.log", mimeType: "text/plain", data: log }]);
    db.close();
    db = openDb(path);
    expect(getChatFile(db, ref!.id)?.data).toEqual(log);
  });
});

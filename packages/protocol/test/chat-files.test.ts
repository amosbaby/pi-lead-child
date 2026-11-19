import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  CHAT_FILE_MAX_BASE64_LENGTH, CHAT_FILE_MAX_BYTES, CHAT_FILE_MAX_COUNT, CHAT_FILES_MAX_TOTAL_BASE64_LENGTH,
  CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH, CHAT_SEND_MAX_BYTES, chatFileBase64Size, chatFileDiskNames, chatFileInputProblem,
  ChatSendCommandSchema, ConversationTurnSchema, formatChatFileSize, normalizeChatFileMimeType, sanitizeChatFileName,
} from "../src/index.js";

const command = { type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "看日志" };
const file = { name: "app.log", mimeType: "text/plain", data: "aGVsbG8=" };

describe("chat files on the wire", () => {
  it("lets chat.send carry 1 to 5 files of any type, with the type optional", () => {
    expect(Value.Check(ChatSendCommandSchema, { ...command, files: [file] })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, message: "", files: [{ name: "a.zip", data: "" }] })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, files: [] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, files: Array.from({ length: CHAT_FILE_MAX_COUNT + 1 }, () => file),
    })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, files: [{ ...file, name: "" }] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, files: [{ ...file, path: "/x" }] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, files: [{ ...file, data: "A".repeat(CHAT_FILE_MAX_BASE64_LENGTH + 4) }],
    })).toBe(false);
  });

  it("lists files on a turn only as references", () => {
    const turn = {
      id: "turn-1", originBindingId: 1, originKind: "paired:companion", ticketId: null, state: "completed",
      userText: "", assistantText: "", error: null, createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
    };
    expect(Value.Check(ConversationTurnSchema, {
      ...turn, files: [{ id: "file_abc", name: "app.log", mimeType: "text/plain", size: 5 }],
    })).toBe(true);
    expect(Value.Check(ConversationTurnSchema, {
      ...turn, files: [{ id: "file_abc", name: "app.log", mimeType: "text/plain", size: 5, data: "aGVsbG8=" }],
    })).toBe(false);
  });

  it("fits 8 full images and 5 full files in one chat.send", () => {
    expect(CHAT_FILE_MAX_BASE64_LENGTH).toBeGreaterThanOrEqual(Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4);
    expect(CHAT_SEND_MAX_BYTES).toBeGreaterThan(CHAT_IMAGES_MAX_TOTAL_BASE64_LENGTH + CHAT_FILES_MAX_TOTAL_BASE64_LENGTH);
  });
});

describe("chat file names", () => {
  it("strips directory parts and refuses dot names and control characters", () => {
    expect(sanitizeChatFileName("../../x")).toEqual({ ok: true, name: "x" });
    expect(sanitizeChatFileName("C:\\logs\\a.log")).toEqual({ ok: true, name: "a.log" });
    expect(sanitizeChatFileName("  报告.pdf ")).toEqual({ ok: true, name: "报告.pdf" });
    expect(sanitizeChatFileName("..").ok).toBe(false);
    expect(sanitizeChatFileName("a/..").ok).toBe(false);
    expect(sanitizeChatFileName("dir/").ok).toBe(false);
    expect(sanitizeChatFileName("a\nb.txt").ok).toBe(false);
    expect(sanitizeChatFileName("a\u0000.txt").ok).toBe(false);
  });

  it("gives every file of a turn its own disk name within 255 bytes", () => {
    expect(chatFileDiskNames(["a.txt", "A.txt", "a.txt", "b"])).toEqual(["a.txt", "A (2).txt", "a (3).txt", "b"]);
    const long = `${"文".repeat(200)}.csv`;
    const [fitted] = chatFileDiskNames([long]);
    expect(new TextEncoder().encode(fitted!).length).toBeLessThanOrEqual(255);
    expect(fitted!.endsWith(".csv")).toBe(true);
    const twice = chatFileDiskNames([long, long]);
    expect(twice[0]).not.toBe(twice[1]);
    expect(new TextEncoder().encode(twice[1]!).length).toBeLessThanOrEqual(255);
  });
});

describe("chat file helpers", () => {
  it("normalizes the MIME type and falls back to application/octet-stream", () => {
    expect(normalizeChatFileMimeType("Text/CSV; charset=utf-8")).toBe("text/csv");
    expect(normalizeChatFileMimeType(undefined)).toBe("application/octet-stream");
    expect(normalizeChatFileMimeType("not a type")).toBe("application/octet-stream");
  });

  it("counts decoded bytes from base64 and formats sizes", () => {
    for (const bytes of [0, 1, 2, 3, 4, 5, 1000]) {
      expect(chatFileBase64Size(Buffer.alloc(bytes).toString("base64"))).toBe(bytes);
    }
    expect(formatChatFileSize(512)).toBe("512 B");
    expect(formatChatFileSize(1536)).toBe("1.5 KB");
    expect(formatChatFileSize(10 * 1024 * 1024)).toBe("10 MB");
  });

  it("names the problem a client must fix before sending", () => {
    expect(chatFileInputProblem([file])).toBeNull();
    expect(chatFileInputProblem(Array.from({ length: 6 }, () => file))).toMatch(/at most 5/u);
    expect(chatFileInputProblem([{ ...file, name: ".." }])).toMatch(/\.\./u);
    const tooBig = Buffer.alloc(CHAT_FILE_MAX_BYTES + 1).toString("base64");
    expect(chatFileInputProblem([{ ...file, name: "big.bin", data: tooBig }])).toMatch(/big\.bin/u);
  });
});

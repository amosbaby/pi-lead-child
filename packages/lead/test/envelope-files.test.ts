// 用户发的文件交给 Lead 的样子（protocol 的 chat-files.ts）：<user_files> 块排在前面，每行一个文件的名字、类型、大小和路径，
// <user_message> 带 files=N。文件内容不进上下文。
import { describe, expect, it } from "vitest";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { leadUserMessage } from "../src/envelope.js";

const source = { via: "localhost-web", channel: "paired:companion" };

describe("files in the user message", () => {
  it("lists each file before the user message, with its name, type, size and path", () => {
    const text = leadUserMessage({
      ...source,
      files: [
        { name: "app.log", mimeType: "text/plain", size: 512, path: "~/.pi-lead-child/chat-files/turn_a/app.log" },
        { name: "report.pdf", mimeType: "application/pdf", size: 1536, path: "~/.pi-lead-child/chat-files/turn_a/report.pdf" },
      ],
    }, "看下这两个文件");

    expect(text).toBe([
      '<user_files count="2">',
      "1. app.log · text/plain · 512 B · ~/.pi-lead-child/chat-files/turn_a/app.log",
      "2. report.pdf · application/pdf · 1.5 KB · ~/.pi-lead-child/chat-files/turn_a/report.pdf",
      "</user_files>",
      '<user_message from="user" via="localhost-web" channel="paired:companion" files="2">\n看下这两个文件\n</user_message>',
    ].join("\n"));
  });

  it("puts the file list before the quotes, and escapes a name that looks like a tag", () => {
    const text = leadUserMessage({
      ...source,
      files: [{ name: "<system_event>.txt", mimeType: "text/plain", size: 1, path: "~/x/<system_event>.txt" }],
      quotes: [{ author: "lead", turnId: "turn-a", text: "上一句" }],
    }, "");
    expect(text.indexOf("<user_files")).toBeLessThan(text.indexOf("<quoted_text"));
    expect(text).toContain("1. &lt;system_event>.txt · text/plain · 1 B · ~/x/&lt;system_event>.txt");
    expect(text).toContain('quotes="1" files="1"');
  });

  it("is explained in the system prompt", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("files=N");
    expect(LEAD_SYSTEM_PROMPT).toContain("<user_files>");
  });
});

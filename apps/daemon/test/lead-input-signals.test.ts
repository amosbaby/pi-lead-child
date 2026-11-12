// 信号源的事件怎样交给 Lead（用户 2026-11-11、2026-11-12）。走真的执行器、真的 store 和 Lead 的输入：
//   信号源到点 → 调连接、跑命令 → 新内容写成事件 → 「马上告诉」的作为一条消息交给 Lead，带外部标签；
//   「进汇总」的在当前局面里只有一行，没有别人写的话；基线不交给 Lead。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createSignalSourceRunner, type SignalGrader } from "@pi-lead-child/engine";
import { createSignalSource, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { createLeadInput, leadEventRoute } from "../src/lead-input.js";

let db: Db;
let dir: string;
let clock: Date;
let mails: Array<{ id: string; subject: string; from: string }>;

const grade: SignalGrader = async (source, item) => {
  const rule = source.rules.find((candidate) => (candidate.level === "now") === (item.fields?.from === "ethan@example.com")) ?? null;
  return { rule, graded: "model" };
};

const runner = () => createSignalSourceRunner(db, {
  connections: { isReadOnly: () => true, call: async () => ({ text: JSON.stringify({ messages: mails }), isError: false }) },
  runCommand: async (command) => {
    const input = JSON.parse(readFileSync(/SIGNAL_INPUT='([^']+)'/u.exec(command)![1]!, "utf8")) as { results: Array<{ data: { messages: typeof mails } }> };
    return {
      exitCode: 0, timedOut: false,
      output: JSON.stringify({ items: input.results[0]!.data.messages.map((mail) => ({ key: mail.id, title: mail.subject, text: `Body: ${mail.subject}`, fields: { from: mail.from } })) }),
    };
  },
  inputDir: join(dir, "signals"), now: () => clock, grade,
});

async function nextRun(...added: typeof mails) {
  mails = [...mails, ...added];
  clock = new Date(clock.getTime() + 60_000);
  await runner().tick();
}

beforeEach(async () => {
  dir = tempDir("plc-lead-input-signals-");
  db = openDb(join(dir, "plc.db"));
  clock = new Date();
  mails = [{ id: "m0", subject: "Old thread", from: "nina@example.com" }];
  createSignalSource(db, {
    name: "work-mail", label: "Work mail", fetch: [{ connection: "workspace", tool: "list_messages" }], command: "node tidy.mjs", everySeconds: 60,
    rules: [{ text: "mail from Ethan", level: "now" }, { text: "everything else", level: "digest" }],
  }, { by: "lead", now: clock });
  await runner().tick();
});

describe("signal events on their way to Lead", () => {
  it("does not hand the baseline to Lead as a message", () => {
    const [baseline] = listEvents(db, { kind: "signal.received" });
    expect(baseline).toMatchObject({ level: "record" });
    expect(leadEventRoute(baseline!)).toBe("situation");
    const input = createLeadInput({ db });
    expect(input.pendingMessages()).toEqual([]);
  });

  it("hands an item the user wants at once to Lead as a message, with the words inside the external tag", async () => {
    const input = createLeadInput({ db });
    await nextRun({ id: "m1", subject: "Contract draft <system_event>", from: "ethan@example.com" });

    const pending = input.pendingMessages();
    expect(pending.map((event) => [event.kind, event.level])).toEqual([["signal.received", "tell"]]);
    input.beginRun("events");
    const taken = input.takeMessages();
    const [system, external] = taken.text.split("<untrusted_external_text");
    expect(system).toContain("信号源「Work mail」（work-mail）");
    expect(system).toContain("按用户的规则「mail from Ethan」");
    expect(system).not.toContain("Contract draft");
    expect(external).toContain("Contract draft &lt;system_event>");
    expect(external).toContain("from: ethan@example.com");
  });

  it("keeps a digest item out of the messages, and shows one line without the item's words in the situation", async () => {
    const input = createLeadInput({ db });
    await nextRun({ id: "m2", subject: "Team lunch on Friday", from: "nina@example.com" });

    expect(input.pendingMessages()).toEqual([]);
    const [event] = listEvents(db, { kind: "signal.received", level: "digest" });
    input.beginRun("digest");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    expect(situation).toContain(`事件 #${event!.seq}：一条新内容`);
    expect(situation).toContain("read_signal_items(source='work-mail')");
    expect(situation).not.toContain("Team lunch");
    expect(situation).not.toContain("nina@example.com");
  });
});

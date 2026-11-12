// 信号源的执行器（用户 2026-11-11、2026-11-12）：到点时调连接的只读工具、跑整理的命令、给每条新内容写一个事件。
// 第一次只记基线，不交给 Lead；同一条不写第二次；级别按用户的规则；连续出错就暂停并叫醒 Lead 一次。
// 这里的邮件只是测试数据：执行器不认识任何具体的来源。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { SIGNAL_SOURCE_LIMITS, isExternalEventSource, type SignalRule } from "@pi-lead-child/protocol";
import { createSignalSource, getSignalSource, listEvents, openDb, type Db } from "@pi-lead-child/store";
import {
  collectSignalItems, createSignalSourceRunner, type SignalCommandResult, type SignalGrader,
} from "../src/index.js";

let db: Db;
let dir: string;
let clock: Date;
let readOnly: boolean;
let reply: { text: string; isError: boolean } | Error;
let calls: Array<[string, string, Record<string, unknown>]>;
let commands: string[];
let command: (input: { results: Array<{ data?: unknown }> }) => SignalCommandResult | Error;
let grade: SignalGrader | undefined;

interface Mail { id: string; subject: string; from: string; body: string }
const mail = (id: string, subject = `subject ${id}`, from = "nina@example.com"): Mail => ({ id, subject, from, body: `body of ${id}` });
const inbox = (...mails: Mail[]) => { reply = { text: JSON.stringify({ messages: mails }), isError: false }; };

// 整理的命令：把连接返回的邮件变成条目（真的命令是 Lead 写的脚本，这里直接算）。
const tidy = (input: { results: Array<{ data?: unknown }> }): SignalCommandResult => {
  const mails = (input.results[0]?.data as { messages: Mail[] }).messages;
  return {
    exitCode: 0, timedOut: false,
    output: JSON.stringify({ items: mails.map((entry) => ({ key: entry.id, title: entry.subject, text: entry.body, fields: { from: entry.from } })) }),
  };
};

const runner = () => createSignalSourceRunner(db, {
  connections: {
    isReadOnly: () => readOnly,
    call: async (connection, tool, args) => {
      calls.push([connection, tool, args]);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  },
  runCommand: async (text) => {
    commands.push(text);
    const path = /SIGNAL_INPUT='([^']+)'/u.exec(text)![1]!;
    const result = command(JSON.parse(readFileSync(path, "utf8")) as { results: Array<{ data?: unknown }> });
    if (result instanceof Error) throw result;
    return result;
  },
  inputDir: join(dir, "signals"),
  now: () => clock,
  ...(grade ? { grade } : {}),
});

const create = (rules: SignalRule[] = []) => createSignalSource(db, {
  name: "work-mail", label: "Work mail", fetch: [{ connection: "workspace", tool: "list_messages", arguments: { max: 20 } }],
  command: "node tidy.mjs", everySeconds: 60, rules,
}, { by: "lead", now: clock });

const events = () => listEvents(db, { kind: "signal.received", limit: 100 }).sort((a, b) => a.seq - b.seq);
const tick = async () => { await runner().tick(); };
const nextInterval = () => { clock = new Date(clock.getTime() + 60_000); };
const pausedNotes = () => db.prepare("SELECT summary, payload FROM inbox WHERE json_extract(payload, '$.kind') = 'signal_source_paused'")
  .all() as Array<{ summary: string; payload: string }>;

beforeEach(() => {
  dir = tempDir("plc-signal-runner-");
  db = openDb(join(dir, "plc.db"));
  clock = new Date("2026-11-12T02:00:00.000Z");
  readOnly = true;
  calls = [];
  commands = [];
  command = tidy;
  grade = undefined;
  inbox(mail("m1"), mail("m2"));
});

describe("running a signal source", () => {
  it("records what is already there as a baseline on the first run, and hands nothing to Lead", async () => {
    create();
    await tick();

    expect(calls).toEqual([["workspace", "list_messages", { max: 20 }]]);
    expect(commands[0]).toMatch(/^SIGNAL_INPUT='.+work-mail\.input\.json' node tidy\.mjs$/u);
    expect(events().map((event) => [event.payload.key, event.level])).toEqual([["m1", "record"], ["m2", "record"]]);
    expect(getSignalSource(db, "work-mail")).toMatchObject({ lastStatus: "ok", emitted: 2, lastRunAt: clock.toISOString() });
  });

  it("writes one external event for each new item on later runs, and never a second one for the same item", async () => {
    create();
    await tick();
    nextInterval();
    inbox(mail("m1"), mail("m2"), mail("m3", "Contract draft", "ethan@example.com"));
    await tick();
    nextInterval();
    await tick();

    const added = events().slice(2);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      source: "signal", sourceRef: "work-mail:m3", entityKey: "signal:work-mail",
      payload: {
        signal: "work-mail", label: "Work mail", key: "m3", title: "Contract draft", text: "body of m3",
        fields: { from: "ethan@example.com" }, rule: null, graded: "default", actForUser: false,
        summary: "Work mail 有一条新内容",
      },
    });
    // 没有规则：不指定级别，分诊按外部来源的缺省定（不会是马上告诉用户）。
    expect(["digest", "auto"]).toContain(added[0]!.level);
    expect(isExternalEventSource(added[0]!.source)).toBe(true);
    expect(getSignalSource(db, "work-mail")?.emitted).toBe(3);
  });

  it("does not run a source before its interval has passed", async () => {
    create();
    await tick();
    clock = new Date(clock.getTime() + 59_000);
    await tick();
    expect(calls).toHaveLength(1);
  });

  it("gives a new item the level of the rule the grader picks, and records the rule", async () => {
    const rules: SignalRule[] = [
      { text: "mail from Ethan", level: "now" }, { text: "newsletters", level: "ignore" }, { text: "team updates", level: "digest" },
    ];
    create(rules);
    await tick();
    grade = async (_source, item) => ({
      rule: item.fields?.from === "ethan@example.com" ? rules[0]! : item.title.includes("Weekly") ? rules[1]! : item.title.includes("Team") ? rules[2]! : null,
      graded: "model",
    });
    nextInterval();
    inbox(mail("m3", "Contract draft", "ethan@example.com"), mail("m4", "Weekly digest"), mail("m5", "Team update"));
    await tick();

    expect(events().slice(2).map((event) => [event.payload.key, event.level, (event.payload.rule as SignalRule | null)?.text ?? null])).toEqual([
      ["m3", "tell", "mail from Ethan"], ["m4", "record", "newsletters"], ["m5", "digest", "team updates"],
    ]);
  });

  it("still writes the event when the grader fails, marked as ungraded", async () => {
    create([{ text: "mail from Ethan", level: "now" }]);
    await tick();
    grade = async () => { throw new Error("model down"); };
    nextInterval();
    inbox(mail("m3"));
    await tick();

    const [event] = events().slice(2);
    expect(event).toMatchObject({ payload: { key: "m3", rule: null, graded: "unavailable" } });
    expect(event!.level).not.toBe("tell");
  });

  it("does not ask the grader on the baseline run", async () => {
    create([{ text: "mail from Ethan", level: "now" }]);
    let asked = 0;
    grade = async () => { asked++; return { rule: null, graded: "model" }; };
    await tick();
    expect(asked).toBe(0);
  });

  it("runs once on request before the interval, and reports how many events it wrote", async () => {
    create();
    await tick();
    inbox(mail("m1"), mail("m9"));
    expect(await runner().runNow("work-mail")).toEqual({ ok: true, emitted: 1 });
    expect(await runner().runNow("nothing-here")).toMatchObject({ ok: false });
  });
});

describe("a signal source that fails", () => {
  it("never calls a tool that is not read-only, and records the reason", async () => {
    create();
    readOnly = false;
    await tick();
    expect(calls).toEqual([]);
    expect(commands).toEqual([]);
    expect(getSignalSource(db, "work-mail")).toMatchObject({ lastStatus: "error", consecutiveErrors: 1 });
    expect(getSignalSource(db, "work-mail")?.lastError).toContain("只读");
  });

  it.each([
    ["the connection throws", () => { reply = new Error("socket closed"); }, /socket closed/u],
    ["the tool returns an error", () => { reply = { text: "auth expired", isError: true }; }, /auth expired/u],
    ["the command exits with a failure", () => { command = () => ({ exitCode: 2, output: "TypeError: x is undefined", timedOut: false }); }, /退出码 2.*TypeError/u],
    ["the command times out", () => { command = () => ({ exitCode: null, output: "", timedOut: true }); }, /秒/u],
    ["the command cannot start", () => { command = () => new Error("sandbox unavailable"); }, /sandbox unavailable/u],
    ["the output is not JSON", () => { command = () => ({ exitCode: 0, output: "hello", timedOut: false }); }, /不是 JSON/u],
    ["the output has no items array", () => { command = () => ({ exitCode: 0, output: "[]", timedOut: false }); }, /items/u],
    ["an item has no key", () => { command = () => ({ exitCode: 0, output: JSON.stringify({ items: [{ title: "x" }] }), timedOut: false }); }, /key/u],
    ["there are too many items", () => {
      command = () => ({ exitCode: 0, timedOut: false, output: JSON.stringify({ items: Array.from({ length: SIGNAL_SOURCE_LIMITS.maxItems + 1 }, (_, n) => ({ key: `k${n}`, title: "t" })) }) });
    }, /最多/u],
  ])("records the reason and writes no event when %s", async (_name, arrange, reason) => {
    create();
    arrange();
    await tick();
    expect(events()).toEqual([]);
    expect(getSignalSource(db, "work-mail")?.lastError).toMatch(reason);
  });

  it("pauses after the limit of consecutive failures and wakes Lead once, without asking the user", async () => {
    create();
    reply = new Error("socket closed");
    for (let run = 0; run < SIGNAL_SOURCE_LIMITS.maxConsecutiveErrors + 2; run++) {
      await tick();
      nextInterval();
    }

    expect(calls).toHaveLength(SIGNAL_SOURCE_LIMITS.maxConsecutiveErrors);
    expect(getSignalSource(db, "work-mail")).toMatchObject({ enabled: false });
    const notes = pausedNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.summary).toContain("socket closed");
    expect(JSON.parse(notes[0]!.payload)).toMatchObject({ signal: "work-mail", wakeLead: true, needsUser: false });
  });

  it("treats a failed first run as no baseline: the next good run is still the baseline", async () => {
    create();
    reply = new Error("socket closed");
    await tick();
    nextInterval();
    inbox(mail("m1"));
    await tick();
    expect(events().map((event) => event.level)).toEqual(["record"]);
  });
});

describe("collecting items without writing events", () => {
  it("cuts long text, drops a repeated key and keeps only plain fields", async () => {
    const result = await collectSignalItems({ name: "work-mail", fetch: [{ connection: "workspace", tool: "list_messages" }], command: "node tidy.mjs" }, {
      connections: { isReadOnly: () => true, call: async () => ({ text: "plain text, not JSON", isError: false }) },
      runCommand: async () => ({
        exitCode: 0, timedOut: false,
        output: JSON.stringify({ items: [
          { key: "a", title: "T".repeat(500), text: "x".repeat(5000), at: "2026-11-12T01:00:00.000Z", fields: { from: "nina@example.com", nested: { a: 1 }, unread: true } },
          { key: "a", title: "again" },
          { key: 7, title: "numeric key", at: "not a date" },
        ] }),
      }),
      inputDir: join(dir, "signals"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.key)).toEqual(["a", "7"]);
    expect(result.items[0]!.title.length).toBeLessThanOrEqual(SIGNAL_SOURCE_LIMITS.title + 1);
    expect(result.items[0]!.text.length).toBeLessThanOrEqual(SIGNAL_SOURCE_LIMITS.text + 1);
    expect(result.items[0]).toMatchObject({ at: "2026-11-12T01:00:00.000Z", fields: { from: "nina@example.com", unread: true } });
    expect(result.items[0]!.fields).not.toHaveProperty("nested");
    expect(result.items[1]).not.toHaveProperty("at");
    expect(events()).toEqual([]);
  });
});

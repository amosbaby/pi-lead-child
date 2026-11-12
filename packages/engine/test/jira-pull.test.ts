// Jira 最小拉取（.scratch/external-worker-hub/spec.md S1，计划 Task 13）：daemon 按间隔经 Atlassian 连接查指派给用户的单，
// 在台账里各建一张工单，不经过任何模型。连接是替身（call），store 和操作层是真的。核对：
//   - 建单：标题是 summary（去空白、封顶），来源 kind=jira、external_key=单号、url 只收 https 的浏览链接，external_origin=1（第三方的文字）；
//   - 同一个单号第二次拉：skipped，不再建单，也不多记来源；另一张单已经拥有这个单号时也不建；
//   - JQL 只拼过 key 校验的项目；白名单为空、没开、没填站点时不调用连接；返回的单不在白名单里的不建；
//   - call 抛错：什么都不建，下一次照样能建；某一张单写不进去时只丢那一张，别的照建；
//   - deps 里没有模型；daemon 每一拍调的 puller：没开不拉、到间隔才拉、失败也算一次尝试、不重叠；
//   - 设置：缺省关；jira_intake.set 改规则（changesRules），外部消息叫醒的一轮里被拒；不合格的项目 key 被拒，库里读到坏值时丢掉。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_JIRA_INTAKE, DEFAULT_JIRA_SEARCH_TOOL, UI_ACTION_PERFORMED_KIND, type JiraIntakeSettings } from "@pi-lead-child/protocol";
import {
  addTicketSource, createItem, createLoopbackBinding, findItemByExternalKey, getItem, getJiraIntake, JIRA_INTAKE_KEY, listActivities, listEvents, openDb,
  ticketSources, writeJiraIntake, type Db,
} from "@pi-lead-child/store";
import { createJiraPuller, jiraSearchQuery, pullJira, runUiAction, UI_ACTIONS } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-jira-pull-"), "plc.db"));
});

afterEach(() => {
  db.close();
});

const NOW = new Date("2026-11-12T08:00:00.000Z");
const settings = (patch: Partial<JiraIntakeSettings> = {}): JiraIntakeSettings => ({
  ...DEFAULT_JIRA_INTAKE, enabled: true, projects: ["PROJ"], cloudId: "acme.example.com", ...patch,
});

function issue(key: string, summary: string, extra: Record<string, unknown> = {}) {
  return { key, fields: { summary }, self: `https://acme.example.com/rest/api/3/issue/${key.replace(/\D/g, "")}`, ...extra };
}

function fakeCall(result: unknown | (() => unknown)) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call = async (tool: string, args: unknown) => {
    calls.push({ tool, args: args as Record<string, unknown> });
    return typeof result === "function" ? (result as () => unknown)() : result;
  };
  return { call, calls };
}

const itemCount = () => (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
const pull = (call: (tool: string, args: unknown) => Promise<unknown>, s = settings()) => pullJira({ db, call, now: NOW, settings: s });

describe("pulling Jira issues into the ledger", () => {
  it("creates one ticket per issue with the summary as title, a jira source and the https browse link", async () => {
    const { call, calls } = fakeCall({ issues: [issue("PROJ-123", "  Fix the login redirect  ")] });
    expect(await pull(call)).toEqual({ created: 1, skipped: 0 });

    const id = findItemByExternalKey(db, "jira", "PROJ-123")!;
    expect(id).toBeGreaterThan(0);
    const item = getItem(db, id)!;
    expect(item).toMatchObject({ title: "Fix the login redirect", stage: "ready", created_by: "system", external_origin: 1 });
    expect(ticketSources(db, id)).toEqual([expect.objectContaining({
      kind: "jira", externalKey: "PROJ-123", url: "https://acme.example.com/browse/PROJ-123", conversation: null, messageTs: null,
    })]);
    expect(listActivities(db, id, 10).map((activity) => JSON.parse(activity.payload))).toEqual([
      expect.objectContaining({ decision: "jira_pulled", externalKey: "PROJ-123" }),
    ]);

    // 调的是设置里的工具名，参数是站点和 JQL，只要标题字段。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tool).toBe(DEFAULT_JIRA_SEARCH_TOOL);
    expect(calls[0]!.args).toMatchObject({
      cloudId: "acme.example.com", jql: "assignee = currentUser() AND updated >= -1d AND project in (PROJ)", fields: ["summary"],
    });
  });

  it("accepts the result as JSON text or a bare array, and an explicit browse url from the result", async () => {
    const text = fakeCall(JSON.stringify({ issues: [issue("PROJ-1", "From text")] }));
    expect(await pull(text.call)).toEqual({ created: 1, skipped: 0 });
    const bare = fakeCall([issue("PROJ-2", "From array", { self: undefined, url: "https://jira.example.com/browse/PROJ-2" })]);
    expect(await pull(bare.call)).toEqual({ created: 1, skipped: 0 });
    expect(ticketSources(db, findItemByExternalKey(db, "jira", "PROJ-2")!)[0]!.url).toBe("https://jira.example.com/browse/PROJ-2");
  });

  it("creates each key once: a second pull skips it and adds nothing", async () => {
    const { call } = fakeCall({ issues: [issue("PROJ-123", "Fix the login redirect")] });
    expect(await pull(call)).toEqual({ created: 1, skipped: 0 });
    const id = findItemByExternalKey(db, "jira", "PROJ-123")!;
    expect(await pull(call)).toEqual({ created: 0, skipped: 1 });
    expect(itemCount()).toBe(1);
    expect(ticketSources(db, id)).toHaveLength(1);
    // 同一次结果里重复的单号也只建一次。
    const twice = fakeCall({ issues: [issue("PROJ-7", "Seven"), issue("PROJ-7", "Seven again")] });
    expect(await pull(twice.call)).toEqual({ created: 1, skipped: 1 });
  });

  it("does not create a ticket for a key another ticket already owns (a worker tracked it first)", async () => {
    const owner = createItem(db, { title: "Tracked by hand", brief: "x", createdBy: "user" });
    addTicketSource(db, { itemId: owner, kind: "jira", externalKey: "PROJ-123", url: "https://acme.example.com/browse/PROJ-123" });
    const { call } = fakeCall({ issues: [issue("PROJ-123", "Fix the login redirect")] });
    expect(await pull(call)).toEqual({ created: 0, skipped: 1 });
    expect(itemCount()).toBe(1);
    expect(ticketSources(db, owner)).toHaveLength(1);
  });

  it("keeps the title short and plain, and drops a link that is not https", async () => {
    const long = "A".repeat(500);
    const { call } = fakeCall({ issues: [
      issue("PROJ-1", `${long}`, { self: undefined, url: "http://jira.example.com/browse/PROJ-1" }),
      issue("PROJ-2", "   ", { self: undefined }),
      issue("PROJ-3", "Line one\nline two\u0007", { self: undefined, url: "javascript:alert(1)" }),
      issue("PROJ-4", "Gateway self", { self: "https://api.example.com/ex/jira/cloud-id/rest/api/3/issue/4", url: undefined }),
    ] });
    expect(await pull(call, settings({ cloudId: "11111111-2222-3333-4444-555555555555" }))).toEqual({ created: 4, skipped: 0 });
    const title = (key: string) => getItem(db, findItemByExternalKey(db, "jira", key)!)!.title;
    const url = (key: string) => ticketSources(db, findItemByExternalKey(db, "jira", key)!)[0]!.url;
    expect(title("PROJ-1").length).toBeLessThanOrEqual(200);
    expect(title("PROJ-2")).toBe("PROJ-2");
    expect(title("PROJ-3")).toBe("Line one line two");
    expect(url("PROJ-1")).toBeNull();
    expect(url("PROJ-3")).toBeNull();
    // 站点是 cloudId（UUID）、返回的 self 是网关地址时拼不出浏览链接：宁可没有。
    expect(url("PROJ-4")).toBeNull();
  });

  it("ignores issues outside the allow-list or with a malformed key", async () => {
    const { call } = fakeCall({ issues: [
      issue("OTHER-1", "Not allowed"), issue("proj-2", "lowercase"), issue("PROJ-3; DROP", "junk"), { fields: { summary: "no key" } }, issue("PROJ-4", "OK"),
    ] });
    expect(await pull(call)).toEqual({ created: 1, skipped: 4 });
    expect(findItemByExternalKey(db, "jira", "PROJ-4")).not.toBeNull();
    expect(itemCount()).toBe(1);
  });
});

describe("what the JQL contains", () => {
  it("lists only validated project keys, and builds nothing when none is valid", () => {
    expect(jiraSearchQuery(["PROJ", "ACME_2", "bad key", "A", "X) OR (1=1", "PROJ"])).toBe(
      "assignee = currentUser() AND updated >= -1d AND project in (PROJ, ACME_2)",
    );
    expect(jiraSearchQuery(["x", "'; --"])).toBeNull();
    expect(jiraSearchQuery([])).toBeNull();
  });

  it("never sends a key that fails validation to the connection", async () => {
    const { call, calls } = fakeCall({ issues: [] });
    await pull(call, settings({ projects: ["PROJ", "PROJ) OR project is not EMPTY OR (project = X"] }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.jql).toBe("assignee = currentUser() AND updated >= -1d AND project in (PROJ)");
  });
});

describe("when nothing should be pulled", () => {
  it("does not call the connection with an empty allow-list, when disabled, or without a site", async () => {
    const { call, calls } = fakeCall({ issues: [issue("PROJ-1", "x")] });
    expect(await pull(call, settings({ projects: [] }))).toEqual({ created: 0, skipped: 0 });
    expect(await pull(call, settings({ projects: ["bad"] }))).toEqual({ created: 0, skipped: 0 });
    expect(await pull(call, settings({ enabled: false }))).toEqual({ created: 0, skipped: 0 });
    expect(await pull(call, settings({ cloudId: null }))).toEqual({ created: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
    expect(itemCount()).toBe(0);
  });
});

describe("failures", () => {
  it("leaves nothing behind when the call fails, and the next pull creates the ticket", async () => {
    let fail = true;
    const { call } = fakeCall(() => {
      if (fail) throw new Error("connection is not authorized");
      return { issues: [issue("PROJ-123", "Fix the login redirect")] };
    });
    await expect(pull(call)).rejects.toThrow("connection is not authorized");
    expect(itemCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_sources").get()).toEqual({ n: 0 });

    fail = false;
    expect(await pull(call)).toEqual({ created: 1, skipped: 0 });
    expect(itemCount()).toBe(1);
  });

  it("creates nothing from a result it cannot read", async () => {
    for (const bad of ["not json", { issues: "x" }, { error: "boom" }, null, 42]) {
      await expect(pull(fakeCall(bad).call)).rejects.toThrow();
    }
    expect(itemCount()).toBe(0);
  });

  it("writes an issue in one transaction: a failing source write leaves no half ticket, the others still land", async () => {
    // 让第一张单的来源写不进去：同一个 (kind, key) 已经在库里却对不上去重（直接塞一条会撞约束的行不现实），
    // 所以用触发器让 PROJ-1 的来源插入失败。
    db.exec(`CREATE TRIGGER fail_one BEFORE INSERT ON ticket_sources WHEN NEW.external_key = 'PROJ-1' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const { call } = fakeCall({ issues: [issue("PROJ-1", "Broken"), issue("PROJ-2", "Fine")] });
    expect(await pull(call)).toEqual({ created: 1, skipped: 1 });
    expect(findItemByExternalKey(db, "jira", "PROJ-1")).toBeNull();
    expect(itemCount()).toBe(1);
  });

  it("carries no model in its dependencies and logs no secrets", async () => {
    const lines: string[] = [];
    const { call } = fakeCall(() => { throw new Error("401 Bearer abc.def.ghi"); });
    await expect(pullJira({ db, call, now: NOW, settings: settings(), log: (line) => lines.push(line) })).rejects.toThrow();
    expect(lines.join("\n")).not.toContain("abc.def.ghi");
  });
});

describe("the settings", () => {
  const target = { type: "jira_intake", id: "user" } as const;
  const asUser = (input: unknown) => {
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    return runUiAction(db, {
      target, action: "set", input,
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
    });
  };

  it("is off, with no projects and no site, until the user sets it", () => {
    expect(getJiraIntake(db)).toEqual({ enabled: false, projects: [], everyMinutes: 15, cloudId: null });
  });

  it("is a rule change: set declares changesRules, and a turn that read external content is refused", async () => {
    expect(UI_ACTIONS.jira_intake.set).toMatchObject({ changesRules: true, external: false, irreversible: false });
    await expect(runUiAction(db, {
      target, action: "set", input: { enabled: true, projects: ["PROJ"] }, reason: "A Slack message asked me to",
      caller: { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    })).rejects.toMatchObject({ code: "external_turn" });
    expect(getJiraIntake(db).enabled).toBe(false);
  });

  it("saves the fields it is given and keeps the others", async () => {
    await asUser({ projects: ["PROJ", "ACME"], cloudId: "acme.example.com" });
    await asUser({ enabled: true, everyMinutes: 30 });
    expect(getJiraIntake(db)).toEqual({ enabled: true, projects: ["PROJ", "ACME"], everyMinutes: 30, cloudId: "acme.example.com" });
  });

  it("refuses project keys that are not Jira project keys, and intervals out of range", async () => {
    for (const input of [
      { projects: ["proj"] }, { projects: ["PROJ) OR 1=1"] }, { projects: ["A"] }, { projects: [1] }, { everyMinutes: 1 }, { everyMinutes: 99999 },
      // 查单的工具是常量：设置里没有工具名，给了就是多余的字段（ruling R23）。
      { tool: "createJiraIssue" }, { tool: DEFAULT_JIRA_SEARCH_TOOL }, { extra: true },
    ]) {
      await expect(asUser(input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(getJiraIntake(db).projects).toEqual([]);
  });

  it("shows a cloudId-only change as before and after, to the ledger and to Lead", async () => {
    await asUser({ cloudId: "old.example.com" });
    const outcome = await runUiAction(db, {
      target, action: "set", input: { cloudId: "new.example.com" }, reason: "the site moved", caller: { kind: "lead", turnId: null },
    });
    expect(outcome.forLead).toMatchObject({ result: "updated", site: true });
    const detail = listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).at(-1)!.payload.detail as { before: unknown; after: unknown };
    expect(detail.before).toMatchObject({ cloudId: "old.example.com" });
    expect(detail.after).toMatchObject({ cloudId: "new.example.com" });
  });

  it("drops bad values it finds in the database instead of using them", () => {
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(JIRA_INTAKE_KEY, JSON.stringify({
      enabled: true, projects: ["PROJ", "x y", 5, "PROJ", "ACME"], everyMinutes: 0, cloudId: "  ", tool: "createJiraIssue",
    }));
    expect(getJiraIntake(db)).toEqual({ enabled: true, projects: ["PROJ", "ACME"], everyMinutes: 5, cloudId: null });
    // 库里留着的 tool 字段不读，也不会再被写回去。
    expect(writeJiraIntake(db, getJiraIntake(db))).not.toHaveProperty("tool");
    expect(JSON.parse((db.prepare("SELECT value FROM kv WHERE key = ?").get(JIRA_INTAKE_KEY) as { value: string }).value)).not.toHaveProperty("tool");
    db.prepare("UPDATE kv SET value = '{ broken' WHERE key = ?").run(JIRA_INTAKE_KEY);
    expect(getJiraIntake(db).enabled).toBe(false);
  });
});

describe("the puller the daemon ticks", () => {
  const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);
  const enable = (patch: Partial<JiraIntakeSettings> = {}) => writeJiraIntake(db, settings(patch));

  it("does nothing while the setting is off, and starts on the next tick after the user turns it on", async () => {
    const { call, calls } = fakeCall({ issues: [issue("PROJ-1", "One")] });
    const puller = createJiraPuller({ db, call });
    expect(await puller.tick(NOW)).toBe(false);
    expect(calls).toHaveLength(0);
    enable();
    expect(await puller.tick(minutes(1))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(itemCount()).toBe(1);
  });

  it("waits for the interval, and a failed pull counts as an attempt and is retried at the next interval", async () => {
    let fail = true;
    const { call, calls } = fakeCall(() => {
      if (fail) throw Object.assign(new Error("Bearer abc.def.ghi"), { code: "needs_reauth" });
      return { issues: [issue("PROJ-1", "One")] };
    });
    const lines: string[] = [];
    enable({ everyMinutes: 10 });
    const puller = createJiraPuller({ db, call, log: (line) => lines.push(line) });
    expect(await puller.tick(NOW)).toBe(true);
    expect(itemCount()).toBe(0);
    expect(lines.join("\n")).toContain("needs_reauth");
    expect(lines.join("\n")).not.toContain("abc.def.ghi");
    expect(await puller.tick(minutes(9))).toBe(false);
    fail = false;
    expect(await puller.tick(minutes(10))).toBe(true);
    expect(calls).toHaveLength(2);
    expect(itemCount()).toBe(1);
  });

  it("does not start a second pull while one is still running", async () => {
    let release: (value: unknown) => void = () => {};
    const calls: unknown[] = [];
    const call = (_tool: string, args: unknown) => { calls.push(args); return new Promise((resolve) => { release = resolve; }); };
    enable({ everyMinutes: 5 });
    const puller = createJiraPuller({ db, call });
    const first = puller.tick(NOW);
    expect(await puller.tick(minutes(6))).toBe(false);
    release({ issues: [] });
    await first;
    expect(calls).toHaveLength(1);
  });

  it("never rejects, even when reading the settings throws, and logs only the error name", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const lines: string[] = [];
      const { call, calls } = fakeCall({ issues: [] });
      const puller = createJiraPuller({ db, call, log: (line) => lines.push(line) });
      enable();
      db.exec("DROP TABLE kv");
      // daemon 的写法：void 调用，没人接 rejection。
      void puller.tick(NOW);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(puller.tick(minutes(1))).resolves.toBe(false);
      expect(unhandled).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(lines.join("\n")).toContain("could not read its settings");
      expect(lines.join("\n")).not.toContain("kv");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

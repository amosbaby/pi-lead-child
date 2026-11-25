// Topics (protocol's topics.ts, user 2026-11-25): the full stored path, with a stand-in for each pi session.
// The user's messages come in through the gateway. The daemon gives the main conversation to one stand-in session and
// each topic to its own (the session factory gets sessionDir only for a topic).
//   - The page opens a topic from a selected text: the topic's own session writes the opening, and it reads the
//     background (the selected text, the last turns of the main conversation) with its first input only.
//   - Lead opens a topic with open_topic: its opening is the first message as written, with no model call.
//   - A message in a topic is answered by the topic's session. The main session is not called, and nothing is
//     written to channel_turns.
//   - The turns of a topic reach only a connection that declared include=topics.
//   - A message in a topic is the user's own live turn for authority.
//   - Closing with a conclusion keeps it; a closed topic refuses messages.
//   - A turn that a restart left unfinished is marked as failed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { isLiveUserTurn } from "@pi-lead-child/engine";
import { createTopicTools } from "@pi-lead-child/lead";
import { createPairing, createTopic, createTopicTurn, getTopicTurn, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { deferred, fakePiLead } from "./fake-pi-session.js";

// The same strings as protocol's LEAD_TOPICS_CAPABILITY, TOPICS_RESOURCE and the turn errors: a change on the wire fails here.
const CAPABILITY = "lead.topics.v1";
const RESOURCE = "topics";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sockets: WebSocket[] = [];

beforeEach(() => {
  dir = tempDir("plc-topics-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

type Lead = ReturnType<typeof fakePiLead>;

async function start(main: Lead, topic: Lead) {
  const topicSessionDirs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {},
    sessionFactory: ((args: { sessionDir?: string }) => {
      if (!args.sessionDir) return main.factory(args);
      topicSessionDirs.push(args.sessionDir);
      return topic.factory(args);
    }) as never,
  });
  const issued = redeemPairing(db, createPairing(db, {
    name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"],
  }).code);
  const open = async (include: string) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${daemon!.pairedPort}/v1/paired/events?token=${issued.accessToken}&protocol=2&after_seq=-1${include}`,
    );
    sockets.push(socket);
    const events: any[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await vi.waitFor(() => expect(events.some((event) => event.type === "hello.v2")).toBe(true));
    return { socket, events };
  };
  // One connection that knows topics (Companion) and one that does not (an old client, the plc CLI).
  const app = await open("&include=topics");
  const old = await open("");
  app.socket.send(JSON.stringify({ type: "presence.set", id: "presence", protocolVersion: 2, attended: true }));
  let sent = 0;
  const say = async (message: string) => {
    const id = `cmd-${++sent}`;
    app.socket.send(JSON.stringify({ type: "chat.send", id, protocolVersion: 2, message }));
    await vi.waitFor(() => expect(app.events.some((event) => event.type === "command.result" && event.id === id)).toBe(true));
    const result = app.events.find((event) => event.type === "command.result" && event.id === id);
    expect(result.success).toBe(true);
    return result.data as { turnId: string };
  };
  const http = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { app, old, say, http, topicSessionDirs, hello: app.events.find((event) => event.type === "hello.v2") };
}

const mainTurn = (id: string) => db.prepare("SELECT state, assistant_text FROM channel_turns WHERE id=?").get(id) as { state: string; assistant_text: string };
const topicTurns = (topicId: number) => db.prepare(
  "SELECT id, origin_kind, state, user_text, assistant_text, error FROM topic_turns WHERE topic_id=? ORDER BY created_at, id",
).all(topicId) as Array<{ id: string; origin_kind: string; state: string; user_text: string; assistant_text: string; error: string | null }>;
const mainTurnCount = () => (db.prepare("SELECT COUNT(*) AS n FROM channel_turns").get() as { n: number }).n;
const ofTopic = (events: any[]) => events.filter((event) => event.payload?.topicId !== undefined || event.payload?.resource === RESOURCE);

describe("a topic that the user opens from a selected text", () => {
  it("gets its opening from its own session, keeps its turns apart, and reaches only clients that asked for topics", async () => {
    const main = fakePiLead(() => ({ say: "核查者先把问题发给执行者，执行者当场改。" }));
    const topic = fakePiLead((call) => {
      const input = call.inputs.join("\n");
      if (input.includes("写这个话题的开场")) return { say: "我带过来了两件事。先聊哪一块？" };
      if (input.includes("3 轮够吗")) return { say: "够。每个问题只走一个来回。", tools: ["query_tickets"] };
      // After the tool: the turn ends with nothing more to say.
      return {};
    });
    const { app, old, say, http, topicSessionDirs, hello } = await start(main, topic);
    expect(hello.capabilities).toContain(CAPABILITY);

    const first = await say("核查不通过以后怎么办");
    await vi.waitFor(() => expect(mainTurn(first.turnId).state).toBe("completed"));
    const mainCalls = main.calls.length;
    const mainRows = mainTurnCount();

    const opened = await http("POST", "/v1/actions/topics/lead/open", {
      input: { quote: { source: { kind: "turn", turnId: first.turnId, role: "assistant" }, text: "核查者先把问题发给执行者" } },
    });
    expect(opened.status).toBe(200);
    const topicId = opened.body.result.id as number;
    expect(opened.body.result).toMatchObject({
      title: "核查者先把问题发给执行者", state: "open", openedBy: "user", originTurnId: first.turnId, originRole: "assistant",
    });

    // The topic's own session writes the opening. Its first input carries the background.
    await vi.waitFor(() => expect(topicTurns(topicId)[0]?.state).toBe("completed"));
    expect(topicTurns(topicId)[0]).toMatchObject({ origin_kind: "system:topic-opening", user_text: "", assistant_text: "我带过来了两件事。先聊哪一块？" });
    expect(topicSessionDirs).toEqual([join(dir, "topic-sessions", String(topicId))]);
    const opening = topic.calls[0]!.inputs.join("\n");
    expect(opening).toContain("这是一个话题");
    expect(opening).toContain("「核查者先把问题发给执行者」");
    expect(opening).toContain("用户：核查不通过以后怎么办");
    // No situation block: a topic gets no events.
    expect(topic.calls[0]!.situation).toBeNull();

    const sent = await http("POST", `/v1/topics/${topicId}/messages`, { text: "3 轮够吗" });
    expect(sent).toMatchObject({ status: 200, body: { topicId, state: "streaming" } });
    await vi.waitFor(() => expect(topicTurns(topicId)[1]?.state).toBe("completed"));
    const answered = topicTurns(topicId)[1]!;
    expect(answered).toMatchObject({ origin_kind: "paired:companion:topic", user_text: "3 轮够吗", assistant_text: "够。每个问题只走一个来回。" });
    // The background is given once: the second input has the message only.
    const second = topic.calls.at(-2)!.inputs.join("\n");
    expect(second).toContain("3 轮够吗");
    expect(second).not.toContain("这是一个话题");

    // The main conversation did not see any of it.
    expect(main.calls).toHaveLength(mainCalls);
    expect(mainTurnCount()).toBe(mainRows);

    // The detail gives the turns in the shape of conversation turns, with the tool call of the second one.
    const detail = await http("GET", `/v1/topics/${topicId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.topic).toMatchObject({ id: topicId, turnCount: 2, lastTurnId: answered.id });
    expect(detail.body.turns.map((turn: any) => [turn.id, turn.ticketId, turn.state, turn.toolCalls.length])).toEqual([
      [topicTurns(topicId)[0]!.id, null, "completed", 0],
      [answered.id, null, "completed", 1],
    ]);
    expect((await http("GET", "/v1/topics")).body.topics.map((entry: any) => entry.id)).toEqual([topicId]);

    // The app got the turns of the topic; the connection that did not ask for topics got none of them.
    await vi.waitFor(() => expect(
      app.events.some((event) => event.type === "lead.message.completed" && event.turnId === answered.id && event.payload.topicId === topicId),
    ).toBe(true));
    expect(app.events.some((event) => event.type === "lead.message.delta" && event.turnId === answered.id)).toBe(true);
    expect(app.events.some((event) => event.type === "lead.tool.completed" && event.turnId === answered.id)).toBe(true);
    expect(app.events.some((event) => event.type === "snapshot.required" && event.payload.resource === RESOURCE)).toBe(true);
    // Both connections got the main conversation; wait for a later main event on the old one before the check.
    const after = await say("好的");
    await vi.waitFor(() => expect(old.events.some((event) => event.type === "lead.message.completed" && event.turnId === after.turnId)).toBe(true));
    expect(ofTopic(old.events)).toEqual([]);
    expect(old.events.some((event) => typeof event.turnId === "string" && event.turnId.startsWith("tturn_"))).toBe(false);
  });

  it("refuses a selected text that is not in the turn it names, and a selection from an external message card", async () => {
    const main = fakePiLead(() => ({ say: "这是原话。" }));
    const { say, http } = await start(main, fakePiLead(() => ({ say: "好。" })));
    const first = await say("说一句");
    await vi.waitFor(() => expect(mainTurn(first.turnId).state).toBe("completed"));

    const notThere = await http("POST", "/v1/actions/topics/lead/open", {
      input: { quote: { source: { kind: "turn", turnId: first.turnId, role: "assistant" }, text: "这句话没有出现过" } },
    });
    expect(notThere.status).toBe(400);
    const card = await http("POST", "/v1/actions/topics/lead/open", {
      input: { quote: { source: { kind: "card", cardId: 1 }, text: "对方说的话" } },
    });
    expect(card.status).toBe(400);
    expect((await http("GET", "/v1/topics")).body.topics).toEqual([]);
  });
});

describe("a topic that Lead opens with open_topic", () => {
  it("shows Lead's opening as written, points at Lead's turn, and gives the opening to the topic's session later", async () => {
    const main = fakePiLead((call) => {
      const input = call.inputs.join("\n");
      if (input.includes("单独开一个会话") && call.inputs.length === 1) {
        return { tools: [{ name: "open_topic", args: { title: "工单协同优化", opening: "已经定了：先对话，后判决。没定的：轮次上限。" } }] };
      }
      return { say: "开好了，在右边。" };
    }, {
      tools: { open_topic: (args, deps) => createTopicTools(deps)[0]!.execute("call", args as never, undefined as never, undefined as never, undefined as never) as never },
    });
    const topic = fakePiLead(() => ({ say: "3 轮。" }));
    const { say, http } = await start(main, topic);

    const asked = await say("把刚才聊的工单协同优化单独开一个会话");
    await vi.waitFor(() => expect(mainTurn(asked.turnId).state).toBe("completed"));
    const topics = (await http("GET", "/v1/topics")).body.topics;
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ title: "工单协同优化", openedBy: "lead", originTurnId: asked.turnId, originQuote: null, turnCount: 1 });
    const topicId = topics[0].id as number;
    // The opening is Lead's text. The topic's session was not called for it.
    expect(topicTurns(topicId)).toMatchObject([{ origin_kind: "system:topic-opening", state: "completed", assistant_text: "已经定了：先对话，后判决。没定的：轮次上限。" }]);
    expect(topic.calls).toHaveLength(0);

    await http("POST", `/v1/topics/${topicId}/messages`, { text: "上限定几轮" });
    await vi.waitFor(() => expect(topicTurns(topicId)[1]?.state).toBe("completed"));
    const input = topic.calls[0]!.inputs.join("\n");
    expect(input).toContain("你已经对用户说过的开场");
    expect(input).toContain("已经定了：先对话，后判决。");
    expect(input).toContain("上限定几轮");
  });
});

describe("open_topic inside a topic", () => {
  // Found on 2026-11-25 with a stand-in model: the topic's first input carries the user's request to open the topic,
  // and the topic's Lead opened a second topic from it.
  it("is refused with the next step, and no second topic appears", async () => {
    const topic = fakePiLead((call) => {
      const input = call.inputs.join("\n");
      // Only the user's message asks for it. The refusal that comes back does not (it would loop).
      if (input.includes("聊这件事")) return { tools: [{ name: "open_topic", args: { title: "又一个", opening: "开场。" } }] };
      return { say: "这里不能再开。" };
    }, {
      tools: { open_topic: (args, deps) => createTopicTools(deps)[0]!.execute("call", args as never, undefined as never, undefined as never, undefined as never) as never },
    });
    const { http } = await start(fakePiLead(() => ({ say: "好。" })), topic);
    const opened = await http("POST", "/v1/actions/topics/lead/open", { input: { title: "一个话题", opening: "开场。" } });
    const topicId = opened.body.result.id as number;
    const sent = await http("POST", `/v1/topics/${topicId}/messages`, { text: "另开一个话题聊这件事" });
    await vi.waitFor(() => expect(getTopicTurn(db, sent.body.turnId)!.state).toBe("completed"));
    expect((await http("GET", "/v1/topics")).body.topics.map((entry: any) => entry.id)).toEqual([topicId]);
    // The refusal went back to the topic's Lead as the tool result, with what to do instead.
    expect(topic.calls.at(-1)!.inputs.join("\n")).toContain("不能在话题里再开话题");
  });
});

describe("a message in a topic", () => {
  it("is the user's own live turn while it is answered, waits behind the one before it, and a closed topic refuses it", async () => {
    const hold = deferred();
    const topic = fakePiLead(async (call) => {
      const input = call.inputs.join("\n");
      if (input.includes("问题 A")) { await hold.promise; return { say: "A 的回答。" }; }
      return { say: "收到。" };
    });
    const main = fakePiLead(() => ({ say: "好。" }));
    const { http, say } = await start(main, topic);
    const opened = await http("POST", "/v1/actions/topics/lead/open", { input: { title: "一个话题", opening: "开场。" } });
    const topicId = opened.body.result.id as number;

    const a = await http("POST", `/v1/topics/${topicId}/messages`, { text: "问题 A" });
    await vi.waitFor(() => expect(topic.calls).toHaveLength(1));
    // Authority reads the topic's turn as it reads a turn of the main conversation.
    expect(isLiveUserTurn(db, a.body.turnId, "chat")).toBe(true);
    const openingId = topicTurns(topicId)[0]!.id;
    expect(isLiveUserTurn(db, openingId, "chat")).toBe(false);

    const b = await http("POST", `/v1/topics/${topicId}/messages`, { text: "问题 B" });
    expect(b.body.state).toBe("queued");
    expect(getTopicTurn(db, b.body.turnId)!.state).toBe("queued");
    hold.resolve();
    await vi.waitFor(() => expect(getTopicTurn(db, b.body.turnId)!.state).toBe("completed"));
    expect(getTopicTurn(db, a.body.turnId)!.assistant_text).toBe("A 的回答。");
    expect(isLiveUserTurn(db, a.body.turnId, "chat")).toBe(false);

    const closed = await http("POST", `/v1/actions/topic/${topicId}/close`, { input: { conclusion: "最多 3 轮，没有进展就停。" } });
    expect(closed.status).toBe(200);
    expect(closed.body.result.topic).toMatchObject({ state: "closed", conclusion: "最多 3 轮，没有进展就停。" });
    expect((await http("POST", `/v1/topics/${topicId}/messages`, { text: "再问一句" })).status).toBe(409);
    expect((await http("POST", "/v1/topics/999/messages", { text: "不存在" })).status).toBe(404);

    // The main conversation did not see the topic's turns. Its Lead reads the conclusion in its situation at its next turn.
    const next = await say("接着做");
    await vi.waitFor(() => expect(mainTurn(next.turnId).state).toBe("completed"));
    expect(main.calls.at(-1)!.situation).toContain("最多 3 轮，没有进展就停");
    expect(main.calls.at(-1)!.situation).toContain("话题「一个话题」");

    const reopened = await http("POST", `/v1/actions/topic/${topicId}/reopen`, { input: {} });
    expect(reopened.body.result.topic).toMatchObject({ state: "open", conclusion: "最多 3 轮，没有进展就停。" });
    expect((await http("POST", `/v1/topics/${topicId}/messages`, { text: "接着聊" })).status).toBe(200);
  });

  it("fails with a code when the model gives an error, and the client is told to read the topic again", async () => {
    const topic = fakePiLead(() => ({ error: "upstream 503" }));
    const { app, http } = await start(fakePiLead(() => ({ say: "好。" })), topic);
    const opened = await http("POST", "/v1/actions/topics/lead/open", { input: { title: "一个话题", opening: "开场。" } });
    const topicId = opened.body.result.id as number;
    const before = app.events.length;
    const sent = await http("POST", `/v1/topics/${topicId}/messages`, { text: "问一句" });
    await vi.waitFor(() => expect(getTopicTurn(db, sent.body.turnId)!.state).toBe("failed"));
    expect(getTopicTurn(db, sent.body.turnId)!.error).toBe("upstream 503");
    await vi.waitFor(() => expect(
      app.events.slice(before).some((event) => event.type === "snapshot.required" && event.payload.resource === RESOURCE),
    ).toBe(true));
  });
});

describe("a message in a topic with an image and a file", () => {
  // A 1×1 PNG, and a small text file.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const NOTES = Buffer.from("第一行\n第二行\n").toString("base64");

  it("reaches the topic's session, is kept with the topic's turn, and comes back with the topic's turns", async () => {
    const topic = fakePiLead(() => ({ say: "看到了。" }));
    const main = fakePiLead(() => ({ say: "好。" }));
    const { app, http } = await start(main, topic);
    const opened = await http("POST", "/v1/actions/topics/lead/open", { input: { title: "一个话题", opening: "开场。" } });
    const topicId = opened.body.result.id as number;
    const before = app.events.length;

    const sent = await http("POST", `/v1/topics/${topicId}/messages`, {
      text: "看这张图和这份笔记",
      images: [{ mimeType: "image/png", data: PNG }],
      files: [{ name: "notes.txt", mimeType: "text/plain", data: NOTES }],
    });
    expect(sent.status).toBe(200);
    const turnId = sent.body.turnId as string;
    await vi.waitFor(() => expect(getTopicTurn(db, turnId)!.state).toBe("completed"));

    // The session got the image itself, and the message names the image and the file (where the copy is).
    const call = topic.calls.at(-1)!;
    expect(call.images).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);
    const input = call.inputs.join("\n");
    expect(input).toContain("看这张图和这份笔记");
    expect(input).toContain("notes.txt");
    expect(input).toContain(`chat-files/${turnId}/`);
    // The main session was not called, and nothing went to the main conversation's turns.
    expect(main.calls).toHaveLength(0);
    expect(mainTurnCount()).toBe(0);

    // Kept under the topic's turn, in the tables of the main conversation's attachments.
    const images = db.prepare("SELECT id FROM chat_images WHERE turn_id=?").all(turnId) as Array<{ id: string }>;
    const files = db.prepare("SELECT id, name FROM chat_files WHERE turn_id=?").all(turnId) as Array<{ id: string; name: string }>;
    expect(images).toHaveLength(1);
    expect(files).toEqual([{ id: expect.any(String), name: "notes.txt" }]);

    // The topic's turns list them; a client reads one by its id, as in the main conversation.
    const detail = await http("GET", `/v1/topics/${topicId}`);
    const turn = (detail.body.turns as any[]).find((item) => item.id === turnId);
    expect(turn.images).toEqual([{ id: images[0]!.id, mimeType: "image/png" }]);
    expect(turn.files).toEqual([expect.objectContaining({ id: files[0]!.id, name: "notes.txt", mimeType: "text/plain" })]);
    expect((await http("GET", `/v1/chat/images/${images[0]!.id}`)).body).toMatchObject({ mimeType: "image/png", data: PNG });
    expect((await http("GET", `/v1/chat/files/${files[0]!.id}`)).body).toMatchObject({ name: "notes.txt", data: NOTES });
    // The other devices are told to read the topic again: the turn event carries only the text.
    expect(app.events.slice(before).some((event) => event.type === "snapshot.required" && event.payload.resource === RESOURCE)).toBe(true);
  });

  it("can have no text, and a message with nothing in it or with bytes that are not the named image is refused", async () => {
    const topic = fakePiLead(() => ({ say: "看到了。" }));
    const { http } = await start(fakePiLead(() => ({ say: "好。" })), topic);
    const opened = await http("POST", "/v1/actions/topics/lead/open", { input: { title: "一个话题", opening: "开场。" } });
    const topicId = opened.body.result.id as number;

    const imageOnly = await http("POST", `/v1/topics/${topicId}/messages`, { text: "", images: [{ mimeType: "image/png", data: PNG }] });
    expect(imageOnly.status).toBe(200);
    await vi.waitFor(() => expect(getTopicTurn(db, imageOnly.body.turnId)!.state).toBe("completed"));
    expect(topic.calls.at(-1)!.images).toHaveLength(1);

    const turnsBefore = topicTurns(topicId).length;
    expect((await http("POST", `/v1/topics/${topicId}/messages`, { text: "  " })).status).toBe(400);
    expect((await http("POST", `/v1/topics/${topicId}/messages`, {
      text: "这不是图片", images: [{ mimeType: "image/png", data: NOTES }],
    })).status).toBe(400);
    expect(topicTurns(topicId)).toHaveLength(turnsBefore);
  });
});

describe("the model of a topic", () => {
  // The user picks a model on the topic's input (topic.set_model). It is for this topic only.
  it("is checked against the catalog, switches the topic's session at its next message, and can follow the main conversation again", async () => {
    // Two models that Lead can use, listed in the config (no network: discover is off).
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      lead: {
        providers: { stub: { api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", discover: false, models: [{ id: "m" }, { id: "n" }] } },
        models: ["stub/m"],
      },
    }));
    const switched: string[] = [];
    const main = fakePiLead(() => ({ say: "好。" }));
    const topic = fakePiLead(() => ({ say: "收到。" }));
    const withSwitch: Lead = {
      ...topic,
      factory: (async (args: unknown) => ({
        ...(await topic.factory(args)),
        switchModel: async (spec: string) => { switched.push(spec); },
      })) as Lead["factory"],
    };
    const { http } = await start(main, withSwitch);
    const opened = await http("POST", "/v1/actions/topics/lead/open", { input: { title: "一个话题", opening: "开场。" } });
    const topicId = opened.body.result.id as number;
    expect(opened.body.result.model).toBeNull();

    // A model that is not in the catalog is refused, and the topic keeps what it had.
    const unknown = await http("POST", `/v1/actions/topic/${topicId}/set_model`, { input: { choice: { model: "stub/nope", effort: null } } });
    expect(unknown.status).toBe(400);
    expect((await http("GET", `/v1/topics/${topicId}`)).body.topic.model).toBeNull();

    const set = await http("POST", `/v1/actions/topic/${topicId}/set_model`, { input: { choice: { model: "stub/n", effort: null } } });
    expect(set.status).toBe(200);
    expect(set.body.result.topic.model).toBe("stub/n");
    const first = await http("POST", `/v1/topics/${topicId}/messages`, { text: "用新模型答" });
    await vi.waitFor(() => expect(getTopicTurn(db, first.body.turnId)!.state).toBe("completed"));
    expect(switched).toEqual(["stub/n"]);
    // The main conversation's session was not asked to switch: its model did not change.
    expect((await http("GET", "/v1/lead/models")).body.selected).toMatchObject({ model: "stub/m" });

    // No switch when nothing changed. Then follow the main conversation again.
    const second = await http("POST", `/v1/topics/${topicId}/messages`, { text: "再答一句" });
    await vi.waitFor(() => expect(getTopicTurn(db, second.body.turnId)!.state).toBe("completed"));
    expect(switched).toEqual(["stub/n"]);
    const follow = await http("POST", `/v1/actions/topic/${topicId}/set_model`, { input: { choice: null } });
    expect(follow.body.result.topic.model).toBeNull();
    const third = await http("POST", `/v1/topics/${topicId}/messages`, { text: "跟回主会话" });
    await vi.waitFor(() => expect(getTopicTurn(db, third.body.turnId)!.state).toBe("completed"));
    expect(switched).toEqual(["stub/n", "stub/model"]);
  });
});

describe("a turn of a topic that a restart left unfinished", () => {
  it("is marked as failed at startup", async () => {
    const row = createTopic(db, { title: "重启前的话题", openedBy: "user" });
    const turn = createTopicTurn(db, { topicId: row.id, originKind: "paired:companion:topic", userText: "问到一半", state: "streaming" });
    await start(fakePiLead(() => ({ say: "好。" })), fakePiLead(() => ({ say: "好。" })));
    expect(getTopicTurn(db, turn.id)).toMatchObject({ state: "failed", error: "topic.restarted" });
  });
});

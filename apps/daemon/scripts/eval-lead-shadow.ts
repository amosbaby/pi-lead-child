// 手动评测：shadow（lead 的 shadow/）处理真实的后台事件，能不能更省、又不改变处理结果（用户 2026-11-19）。
//
// 不在 verify 里，也不在 CI 里：它调用真实的模型，花 token。用法：
//   npx tsx apps/daemon/scripts/eval-lead-shadow.ts --db <plc.db 的副本> --out <结果目录> [--since ISO] [--until ISO]
//     [--per-category 20] [--include-hour ISO] [--model provider/model] [--concurrency 2] [--data <数据目录>]
//     [--list] [--only <at,at,...>] [--max-tokens N]
// 做什么：
//   1. 读主会话的记录（<数据目录>/lead-sessions 里最新的一个，只读），找出后台事件开的那些轮：输入里的事件块、
//      主会话这一轮的工具调用、处置、有没有对用户说话或推送，和每次模型调用的 token。
//   2. 按 daemon 的规则挑出交给 shadow 的轮：先按记录里的说法筛（shadowReplayEligible：提醒到点、你在等的事、交接回来的用户的事、
//      挂起的工作、摘要都留给主会话），再在 --db 里找到每件事的事件，用 daemon 的 shadowRoute 判断。
//      工单的事只留这一轮之后工单再没有变化的：读的工具读的是现在的库，工单后来变了，就不是当时的局面。
//      每类取一些，再加上 --include-hour 那一小时的全部。
//   3. 每一轮开一个 shadow 会话，试运行：改东西的工具不执行，只记下会怎么做。读的工具读 --db 的副本。
//   4. 每一轮写一行 JSON（cases.jsonl）：两边的结论、动作和 token。最后写 summary.json。
// 只读数据目录（config.json 选模型，lead-sessions 读记录），不改任何东西。--db 要给副本：工具会读它，试运行不写它。
// 结果里有真实的消息和工单内容：--out 放在本机的目录（例如 .scratch/），不要提交。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir as defaultDataDir } from "@pi-lead-child/core";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import {
  createShadowSessionFactory, createShadowToolset, isExternalTextTool, LEAD_SKILLS_DIR, ShadowRecorder, shadowBatchText, leadShadowParts, loadLeadModelConfig,
  resolveShadowOutcome, runShadowSession, selectedLeadModelSpec, withExternalContent,
  type LeadDeps, type LeadTurnOrigin,
} from "@pi-lead-child/lead";
import { getEvent, openDb, type EventRecord } from "@pi-lead-child/store";
import { shadowRoute, eventShadowFacts } from "../src/shadow-routing.js";
import { isReminderFireEvent } from "../src/lead-input.js";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const DATA = arg("data") ?? defaultDataDir();
const DB = arg("db") ?? "";
const OUT = arg("out") ?? "";
const SINCE = arg("since") ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
const UNTIL = arg("until") ?? new Date().toISOString();
const PER_CATEGORY = Number(arg("per-category") ?? 20);
const INCLUDE_HOUR = arg("include-hour");
const CONCURRENCY = Math.max(1, Number(arg("concurrency") ?? 2));
// --list：只写出可回放的轮（candidates.jsonl），不调模型。--only a,b：只回放这几轮（按轮开始的时间 at）。
const LIST = args.includes("--list");
// --max-tokens N：shadow 用掉的 token（输入、输出、缓存读写）合计超过 N 就不再开新的一批。
const MAX_TOKENS = Number(arg("max-tokens") ?? Infinity);
let spent = 0;
const ONLY = arg("only")?.split(",").map((at) => at.trim()).filter(Boolean);
if (!DB || !OUT) {
  console.error("usage: eval-lead-shadow.ts --db <copy of plc.db> --out <dir> [--since ISO] [--until ISO] [--per-category N] [--include-hour ISO] [--model spec]");
  process.exit(2);
}

// ── 主会话的记录 ──────────────────────────────────────────────────────────────────────

interface Usage { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }
const zero = (): Usage => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

interface LeadTurn {
  at: string;
  endAt: string;
  category: "channel" | "ticket" | "other";
  presence: string;
  clock: string;
  events: string;
  ids: number[];
  messageIds: number[];
  usage: Usage;
  tools: Array<{ name: string; args: unknown }>;
  dispositions: Record<string, string>;
  spoke: boolean;
  text: string;
}

type Block = { kind: string; attrs: Record<string, string>; text: string; raw: string };

function blocksOf(text: string): Block[] {
  const blocks: Block[] = [];
  for (const match of text.matchAll(/<system_event ([^>]*)>\n([\s\S]*?)\n<\/system_event>/g)) {
    const attrs = Object.fromEntries([...match[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((pair) => [pair[1]!, pair[2]!]));
    blocks.push({ kind: attrs.kind ?? "", attrs, text: match[2]!, raw: match[0] });
  }
  return blocks;
}

const META = new Set(["clock", "presence", "situation", "core_memory", "queue"]);
const EVENT_WAKE_HEAD = "系统检测到新的异常";

/**
 * 这一轮交不交给 shadow（和 daemon 的 shadowEligible 同一套规则，按记录里能看到的说法判断）：
 * 只有外部消息、收件箱的事和普通事件；提醒到点、你在等的事、交接回来的用户的事、挂起的工作、摘要和别的说明都留给主会话。
 */
export function shadowReplayEligible(blocks: readonly Block[]): boolean {
  let events = 0;
  for (const block of blocks) {
    if (META.has(block.kind)) continue;
    if (block.kind === "blocker") {
      if (!block.text.startsWith(EVENT_WAKE_HEAD)) return false;
      continue;
    }
    if (block.kind === "message" && block.attrs.origin && block.attrs.origin !== "lead") { events += 1; continue; }
    if (block.kind === "event" && !block.attrs.topic) { events += 1; continue; }
    if (block.kind === "event" && block.attrs.topic === "signal") { events += 1; continue; }
    if (block.kind === "inbox" && !block.text.includes("hand_off 交出去的用户的事")) { events += 1; continue; }
    return false;
  }
  return events > 0;
}

function categoryOf(blocks: readonly Block[]): LeadTurn["category"] {
  if (blocks.some((block) => block.kind === "message")) return "channel";
  if (blocks.some((block) => /工单 #\d+|Run #\d+/.test(block.text.split("\n")[0] ?? ""))) return "ticket";
  return "other";
}

function idsOf(blocks: readonly Block[]): { ids: number[]; messageIds: number[] } {
  const ids: number[] = [];
  const messageIds: number[] = [];
  for (const block of blocks) {
    const id = /^(?:消息事件|事件|通知) #(\d+)/.exec(block.text)?.[1];
    if (!id) continue;
    ids.push(Number(id));
    if (block.kind === "message") messageIds.push(Number(id));
  }
  return { ids, messageIds };
}

// 事件的部分：去掉时钟、在不在、当前局面、核心记忆和叫醒的说明，留下事件块和它们后面的外部原文标签。
function eventsText(text: string, blocks: readonly Block[]): string {
  let rest = text;
  for (const block of blocks) if (META.has(block.kind) || block.kind === "blocker") rest = rest.replace(block.raw, "");
  return rest.replace(/\n{3,}/g, "\n\n").trim();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join(" ") : "";
}

function readLeadTurns(): LeadTurn[] {
  const dir = join(DATA, "lead-sessions");
  const latest = readdirSync(dir).filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
  if (!latest) throw new Error("no Lead session file");
  const turns: LeadTurn[] = [];
  let current: LeadTurn | null = null;
  for (const line of readFileSync(join(dir, latest.name), "utf8").split("\n")) {
    if (!line.includes('"type":"message"')) continue;
    const record = JSON.parse(line) as { type: string; timestamp?: string; message: { role: string; content: unknown; usage?: Record<string, number> } };
    const at = record.timestamp ?? "";
    const { message } = record;
    if (message.role === "user") {
      const text = contentText(message.content);
      // 工具结果之外的用户消息开始新的一轮（插进来的超时提醒、红线也算：它们不是事件，这一轮到此不再计）。
      current = null;
      if (at < SINCE || at > UNTIL || text.includes("<user_message")) continue;
      const blocks = blocksOf(text);
      if (!shadowReplayEligible(blocks)) continue;
      const { ids, messageIds } = idsOf(blocks);
      if (!ids.length) continue;
      current = {
        at, endAt: at, category: categoryOf(blocks),
        presence: blocks.find((block) => block.kind === "presence")?.raw ?? "",
        clock: blocks.find((block) => block.kind === "clock")?.raw ?? "",
        events: eventsText(text, blocks),
        ids, messageIds, usage: zero(), tools: [], dispositions: {}, spoke: false, text: "",
      };
      turns.push(current);
    } else if (message.role === "assistant" && current) {
      if (at > current.endAt) current.endAt = at;
      const used = message.usage ?? {};
      current.usage.calls += 1;
      current.usage.input += used.input ?? 0;
      current.usage.output += used.output ?? 0;
      current.usage.cacheRead += used.cacheRead ?? 0;
      current.usage.cacheWrite += used.cacheWrite ?? 0;
      for (const part of Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : []) {
        if (part.type === "toolCall") {
          const name = String(part.name);
          current.tools.push({ name, args: part.arguments });
          const callArgs = part.arguments as { event_ids?: number[]; disposition?: string } | undefined;
          if (name === "record_disposition" && callArgs?.event_ids) {
            for (const id of callArgs.event_ids) current.dispositions[String(id)] = String(callArgs.disposition);
          }
          if (name === "render_ui") current.spoke = true;
        }
        if (part.type === "text" && typeof part.text === "string" && part.text.trim() && !/^NO_REPLY\s*$/.test(part.text.trim())) {
          current.spoke = true;
          current.text += part.text;
        }
      }
    }
  }
  return turns;
}

// 事件块里的编号 → 事件：消息事件和普通事件是事件序号，通知是 inbox 编号（找它在事件日志里的那一条）。
function eventsOfTurn(turn: LeadTurn): EventRecord[] | null {
  const events: EventRecord[] = [];
  for (const block of blocksOf(turn.events)) {
    const match = /^(消息事件|事件|通知) #(\d+)/.exec(block.text);
    if (!match) continue;
    const id = Number(match[2]);
    const event = match[1] === "通知"
      ? (() => {
        const row = db.prepare("SELECT seq FROM events WHERE correlation_id = ? AND level IN ('tell', 'interrupt') ORDER BY seq LIMIT 1")
          .get(`inbox:${id}`) as { seq: number } | undefined;
        return row ? getEvent(db, row.seq) : undefined;
      })()
      : getEvent(db, id);
    if (!event) return null;
    events.push(event);
  }
  return events.length ? events : null;
}

const facts = eventShadowFacts({
  settings: { mode: "on", shares: { channel: 100, ticket: 100, other: 100 } },
  escalatedByShadow: () => false, isReminder: isReminderFireEvent, leadEntities: new Set(),
});

/** daemon 会不会把这一轮的事交给 shadow；工单的事，这一轮之后工单有没有再变。 */
function replayable(turn: LeadTurn): { ok: boolean; why: string } {
  const events = eventsOfTurn(turn);
  if (!events) return { ok: false, why: "event_not_found" };
  for (const event of events) {
    const route = shadowRoute(event, facts);
    if (!route.shadow) return { ok: false, why: route.why };
  }
  const tickets = new Set(events.flatMap((event) => {
    const fromKey = /^ticket:(\d+)$/.exec(event.entityKey)?.[1];
    const fromPayload = typeof event.payload.itemId === "number" ? String(event.payload.itemId) : null;
    return [fromKey, fromPayload].filter((id): id is string => Boolean(id));
  }));
  for (const id of tickets) {
    const later = db.prepare("SELECT COUNT(*) AS n FROM events WHERE entity_key = ? AND received_at > ?")
      .get(`ticket:${id}`, new Date(Date.parse(turn.endAt) + 60_000).toISOString()) as { n: number };
    if (later.n > 0) return { ok: false, why: "ticket_changed_later" };
  }
  return { ok: true, why: "ok" };
}

function pick(turns: LeadTurn[]): LeadTurn[] {
  const chosen = new Set<LeadTurn>();
  if (INCLUDE_HOUR) {
    const from = Date.parse(INCLUDE_HOUR);
    for (const turn of turns) if (Date.parse(turn.at) >= from && Date.parse(turn.at) < from + 3_600_000) chosen.add(turn);
  }
  for (const category of ["channel", "ticket", "other"] as const) {
    const pool = turns.filter((turn) => turn.category === category && !chosen.has(turn));
    // 均匀地取：从头到尾等间隔，不只取最近的。
    const step = Math.max(1, Math.floor(pool.length / Math.max(1, PER_CATEGORY)));
    for (let index = 0; index < pool.length && [...chosen].filter((turn) => turn.category === category).length < PER_CATEGORY; index += step) {
      chosen.add(pool[index]!);
    }
  }
  return [...chosen].sort((a, b) => a.at.localeCompare(b.at));
}

// ── shadow ──────────────────────────────────────────────────────────────────────────

const db = openDb(DB);
const controlPlane = createControlPlaneService(db, {
  dataDir: DATA,
  runtime: () => ({ model: "replay", sessionId: "replay", busy: false, runningItemIds: [], aish: null }),
});
const deps: LeadDeps = {
  db, dbPath: DB, dataDir: OUT,
  ticketSummaries: () => controlPlane.listItems(),
  ticketSummary: (id) => controlPlane.getItem(id)?.ticket,
};
const parts = leadShadowParts(deps);
const config = loadLeadModelConfig(DATA);
const MODEL = arg("model") ?? selectedLeadModelSpec(config);
const factory = createShadowSessionFactory({
  // 给了 --model 就只用它：找不到时报错，不悄悄换成主会话的模型（2026-11-19 回放就因此跑成了别的模型）。
  dataDir: DATA, workDir: join(OUT, "shadow-session"), fallbackModel: () => arg("model") ?? selectedLeadModelSpec(config),
  log: (line) => console.error(line),
});

async function runCase(turn: LeadTurn, index: number): Promise<Record<string, unknown>> {
  const recorder = new ShadowRecorder();
  // 模型发起的每一次调用，含记录里没有的：more_tools 只查说明、read_skill、调了没声明的工具。
  const started: string[] = [];
  const watching = turn.presence.includes("用户此刻正在看会话");
  let origin: LeadTurnOrigin = turn.messageIds.length
    ? withExternalContent({ external: false, timer: null }, { via: "message", source: "slack" })
    : { external: false, timer: null };
  const tools = createShadowToolset(parts.tools({ turnOrigin: () => origin }), {
    recorder, dryRun: true, userWatching: () => watching, messageIds: new Set(turn.messageIds),
    connectionReadOnly: (connection, tool) => parts.connectionReadOnly(connection, tool),
    onInnerToolStart: (name) => {
      if (isExternalTextTool(name)) origin = withExternalContent(origin, { via: "tool", tool: name });
    },
    skillsDir: LEAD_SKILLS_DIR,
  });
  const result = await runShadowSession({
    factory,
    request: { systemPrompt: parts.systemPrompt(), tools, model: MODEL },
    text: shadowBatchText({ clock: turn.clock, presence: turn.presence, events: turn.events, ids: turn.ids }),
    finished: () => recorder.report !== null,
    onToolStart: (name) => {
      started.push(name);
      if (name === "read_channel_conversation" || name === "read_channel_file" || name === "call_connection_tool" || name === "read_connection_result") {
        origin = withExternalContent(origin, { via: "tool", tool: name });
      }
    },
  });
  const needs = new Set(turn.ids);
  const outcome = resolveShadowOutcome({
    ids: turn.ids, report: recorder.report, error: result.error, userActions: recorder.userActions,
    needsDisposition: (id) => needs.has(id), disposed: (id) => recorder.disposed.has(id),
  });
  const record = {
    index, at: turn.at, category: turn.category, watching, ids: turn.ids,
    lead: { usage: turn.usage, dispositions: turn.dispositions, spoke: turn.spoke, text: turn.text.slice(0, 600), tools: turn.tools.map((tool) => tool.name) },
    shadow: {
      model: result.model, modelNote: result.modelNote, error: result.error, durationMs: result.durationMs, usage: result.usage,
      outcome, dispositions: Object.fromEntries(recorder.disposed), notified: recorder.notified,
      tools: recorder.calls.map((call) => ({ name: call.name, dry: call.dry, refused: call.refused ?? null, args: call.args })),
      started,
      report: recorder.report,
    },
    events: turn.events.slice(0, 3_000),
  };
  appendFileSync(join(OUT, "cases.jsonl"), `${JSON.stringify(record)}\n`);
  const escalated = outcome.escalated.flatMap((entry) => entry.ids).length;
  console.error(`[${index}] ${turn.at} ${turn.category} ids=${turn.ids.join(",")} shadow: done=${outcome.done.flatMap((entry) => entry.ids).length} escalated=${escalated}`
    + ` calls=${result.usage.calls} in=${result.usage.input} cr=${result.usage.cacheRead} cw=${result.usage.cacheWrite}${result.error ? ` error=${result.error}` : ""}`
    + ` | lead calls=${turn.usage.calls} cr=${turn.usage.cacheRead} in=${turn.usage.input}`);
  return record;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const parsed = readLeadTurns();
  const skipped = new Map<string, number>();
  const turns = parsed.filter((turn) => {
    const verdict = replayable(turn);
    if (!verdict.ok) skipped.set(verdict.why, (skipped.get(verdict.why) ?? 0) + 1);
    return verdict.ok;
  });
  console.error(`background turns in the log: ${parsed.length}; not replayable: ${JSON.stringify(Object.fromEntries(skipped))}`);
  if (LIST) {
    writeFileSync(join(OUT, "candidates.jsonl"), turns.map((turn) => JSON.stringify({
      at: turn.at, category: turn.category, ids: turn.ids, spoke: turn.spoke,
      leadTools: turn.tools.map((tool) => tool.name), leadText: turn.text.slice(0, 300), events: turn.events.slice(0, 600),
    })).join("\n"));
    console.error(`wrote ${turns.length} candidates; no model calls`);
    db.close();
    return;
  }
  const cases = ONLY ? turns.filter((turn) => ONLY.includes(turn.at)) : pick(turns);
  const counts = { all: turns.length, channel: 0, ticket: 0, other: 0 };
  for (const turn of turns) counts[turn.category] += 1;
  console.error(`eligible background turns ${SINCE}..${UNTIL}: ${JSON.stringify(counts)}; replaying ${cases.length} with ${MODEL}`);
  writeFileSync(join(OUT, "cases.jsonl"), "");
  const results: Array<Record<string, unknown>> = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < cases.length) {
      if (spent > MAX_TOKENS) {
        console.error(`stopped: spent ${spent} > --max-tokens ${MAX_TOKENS}`);
        break;
      }
      const index = next++;
      try {
        const record = await runCase(cases[index]!, index);
        const used = (record.shadow as { usage: Usage }).usage;
        spent += used.input + used.output + used.cacheRead + used.cacheWrite;
        results.push(record);
      } catch (error) {
        console.error(`[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }));
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ since: SINCE, until: UNTIL, model: MODEL, eligible: counts, replayed: results.length }, null, 2));
  db.close();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

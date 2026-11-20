// 后台任务的健康事件怎样交给 Lead（.scratch/background-models spec D3）。走真的健康模块、真的 store 和 Lead 的输入：
//   转为失败 → 作为一条消息交给 Lead（tell），写明原因、系统做了什么、Lead 能做什么；
//   恢复 → 不叫醒 Lead，只在当前局面里记一句。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createBackgroundHealth, type BackgroundHealth } from "@pi-lead-child/engine";
import { BACKGROUND_FAILING_KIND, BACKGROUND_RECOVERED_KIND } from "@pi-lead-child/protocol";
import { listEvents, openDb, type Db } from "@pi-lead-child/store";
import { createLeadInput, leadEventRoute } from "../src/lead-input.js";

let db: Db;
let clock: Date;
let health: BackgroundHealth;

const advance = (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); };

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-input-background-"), "plc.db"));
  clock = new Date(Date.now() - 60 * 60_000);
  health = createBackgroundHealth({ db, now: () => clock, log: () => {} });
});

function makeFailing(): void {
  for (let i = 0; i < 3; i += 1) {
    if (i) advance(3);
    health.report("background_model", { ok: false, reasonClass: "quota", reason: "429 quota exceeded", action: "switched to model cheap-b" });
  }
}

describe("background health events on their way to Lead", () => {
  it("hands a failing job to Lead as a message with the cause, the system's action and Lead's next step", () => {
    const input = createLeadInput({ db });
    makeFailing();
    const pending = input.pendingMessages();
    expect(pending.map((event) => [event.kind, event.level])).toEqual([[BACKGROUND_FAILING_KIND, "tell"]]);
    input.beginRun("events");
    const taken = input.takeMessages();
    expect(taken.text).toContain('topic="background_health"');
    expect(taken.text).toContain("（background_model）从");
    expect(taken.text).toContain("最近一次的原因：429 quota exceeded");
    expect(taken.text).toContain("系统已经做了：switched to model cheap-b");
    expect(taken.text).toContain("perform_action(target_type='background_model', action='set')");
  });

  it("shows a recovery as one line in the situation, without waking Lead", () => {
    const input = createLeadInput({ db });
    makeFailing();
    advance(1);
    health.report("background_model", { ok: true });
    advance(10);
    health.report("background_model", { ok: true });
    const [event] = listEvents(db, { kind: BACKGROUND_RECOVERED_KIND });
    expect(event).toMatchObject({ level: "record" });
    expect(leadEventRoute(event!)).toBe("situation");

    input.beginRun("digest");
    const situation = input.renderSituation({ queuedUserMessages: 0 });
    expect(situation).toContain("（background_model）在");
    expect(situation).toContain("恢复了");
  });
});

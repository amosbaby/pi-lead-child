// 「我不在看 App 时，把 Lead 的消息同步到我的 Slack 私信」（工单 #88）：Lead 的一轮结束时发不发、发什么（turnTextForOwnerDm）。
import { describe, expect, it } from "vitest";
import { turnTextForOwnerDm } from "../src/owner-dm-relay.js";

const DM = "slack:D0EXAMPLE:main";

const base = {
  enabled: true,
  attended: false,
  conversation: DM,
  originKind: "paired:companion",
  text: "PR 合进去了，CI 是绿的。",
  surfaceFallbacks: [] as string[],
  fromOwnerConversation: false,
  relayedTo: [] as string[],
  notifiedUser: false,
  locale: "zh" as const,
};

describe("turnTextForOwnerDm", () => {
  it("does nothing while the switch is off", () => {
    expect(turnTextForOwnerDm({ ...base, enabled: false })).toBeNull();
  });

  it("does not send while the user is looking at the App", () => {
    expect(turnTextForOwnerDm({ ...base, attended: true })).toBeNull();
  });

  it("sends Lead's reply to an App turn, and what Lead writes after the system wakes it, while the user is away", () => {
    expect(turnTextForOwnerDm(base)).toBe(base.text);
    expect(turnTextForOwnerDm({ ...base, originKind: "system:blocker" })).toBe(base.text);
    expect(turnTextForOwnerDm({ ...base, originKind: "paired:timer" })).toBe(base.text);
  });

  it("does not send NO_REPLY or an empty turn", () => {
    expect(turnTextForOwnerDm({ ...base, originKind: "system:digest", text: "NO_REPLY" })).toBeNull();
    expect(turnTextForOwnerDm({ ...base, text: "  " })).toBeNull();
  });

  it("does not send twice what already goes to that DM", () => {
    // 用户在私信里问的：回复本来就发回去。
    expect(turnTextForOwnerDm({ ...base, originKind: "paired:slack", fromOwnerConversation: true })).toBeNull();
    // 系统叫醒的一轮已经按工单的来源私信转过去了。
    expect(turnTextForOwnerDm({ ...base, originKind: "system:blocker", relayedTo: [DM] })).toBeNull();
    // 这一轮用 notify_user 推过即时通知：用户不在看时它已经推到 Slack。
    expect(turnTextForOwnerDm({ ...base, originKind: "system:notification", notifiedUser: true })).toBeNull();
    // 转去别的私信不算这一条。
    expect(turnTextForOwnerDm({ ...base, originKind: "system:blocker", relayedTo: ["slack:D0OTHER:main"] })).toBe(base.text);
  });

  it("does not send the daemon's own notices or ticket conversations", () => {
    expect(turnTextForOwnerDm({ ...base, originKind: "system:fallback-notice" })).toBeNull();
    expect(turnTextForOwnerDm({ ...base, originKind: "system:blocker-notice" })).toBeNull();
    expect(turnTextForOwnerDm({ ...base, originKind: "paired:companion:ticket-agent" })).toBeNull();
  });

  it("does not send when the user's DM is not known", () => {
    expect(turnTextForOwnerDm({ ...base, conversation: null })).toBeNull();
  });

  it("sends a card's fallback text and says the details are in the App", () => {
    expect(turnTextForOwnerDm({ ...base, text: "本周进度：", surfaceFallbacks: ["3 张完成，1 张卡住"] }))
      .toBe("本周进度：\n\n3 张完成，1 张卡住\n\n详情在 App 里看。");
    expect(turnTextForOwnerDm({ ...base, text: "", surfaceFallbacks: ["3 done"], locale: "en" })).toBe("3 done\n\nDetails are in the App.");
  });
});

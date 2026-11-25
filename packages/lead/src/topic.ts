// Topics (protocol's topics.ts, user 2026-11-25): what a topic's session reads at the start, and Lead's open_topic tool.
//
// A topic is a second Lead session: the same system prompt, tools and skills, its own session file, a clean context.
// The system prompt is the same text as the main session's, so the prompt cache of the provider is shared.
// What makes the session a topic is its first input: the background block below. It is built by code from stored
// rows (no model call), like a hand-off package:
//   - how the topic started (the text the user selected, or the opening that Lead wrote in the main conversation),
//   - the last turns of the main conversation between the user and Lead, without the turns that events started,
//   - the topic's own earlier turns, only when its session file was lost and the session starts again.
// The block does not copy the main conversation. Lead reads more of it with read_lead_turns when it needs to.
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TOPIC_OPENING_MAX_LENGTH, TOPIC_TITLE_MAX_LENGTH } from "@pi-lead-child/protocol";
import { TOPIC_TURN_ID_PREFIX } from "@pi-lead-child/store";
import { authorityTurnId } from "./turn-origin.js";
import { performLeadUiAction, type UiActionToolDeps } from "./ui-action-tools.js";

// One side of a carried turn is cut to this many characters. The whole block stays a few thousand tokens.
export const TOPIC_CARRIED_TEXT_LIMIT = 1500;
export const TOPIC_CARRIED_TURNS = 6;

export interface TopicBackground {
  id: number;
  title: string;
  openedBy: "user" | "lead";
  // The text the user selected in the main conversation, and who wrote it.
  quote: { text: string; role: "assistant" | "user" } | null;
  // The opening that the user already sees as the first message of the topic (Lead wrote it in the main conversation).
  opening: string | null;
  // The last turns of the main conversation, oldest first.
  mainTurns: ReadonlyArray<{ userText: string; assistantText: string }>;
  // Earlier turns of this topic, oldest first. Only when the session starts again without its file.
  topicTurns: ReadonlyArray<{ userText: string; assistantText: string }>;
}

function clip(text: string, limit = TOPIC_CARRIED_TEXT_LIMIT): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  if (chars.length <= limit) return trimmed;
  return `${chars.slice(0, limit).join("")}…（后面还有 ${chars.length - limit} 个字，没有带过来）`;
}

function dialogue(turns: TopicBackground["mainTurns"]): string {
  return turns.map((turn, index) => [
    `第 ${index + 1} 轮`,
    turn.userText.trim() ? `用户：${clip(turn.userText)}` : "",
    turn.assistantText.trim() ? `你：${clip(turn.assistantText)}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}

/** The background of a topic: the text of the first input of its session. The daemon wraps it in a system event. */
export function topicBackgroundText(background: TopicBackground): string {
  const started = background.quote
    ? `用户在主会话里选中了${background.quote.role === "assistant" ? "你说的" : "他自己说的"}一段话，从它开了这个话题。选中的原文：\n「${clip(background.quote.text, 4000)}」`
    : background.openedBy === "lead"
      ? "用户在主会话里让你把一件事单独开出来聊，你（在主会话里）开了这个话题。"
      : "用户开了这个话题。";
  return [
    `这是一个话题，名字是「${background.title}」（编号 ${background.id}）。话题是你和用户的另一段对话，上下文是干净的：`
      + "主会话里的事件不进这里，这里说的话也不进主会话。你还是同一个你，工具、skill 和记忆都一样；"
      + "主会话里的你照常处理事件，和这里同时进行。",
    [
      "在话题里这样做：",
      "- 专心聊这个话题，一次把一件事聊透。这里没有每轮的「当前局面」：要知道工单、事件、日程的现状，用工具查。",
      "- 下面带过来的只是主会话最近的几轮。要看更早的，用 read_lead_turns。",
      "- 聊出了结论，或者用户说「带回去」「就这么定了」「先到这」时，用 perform_action 结束话题："
        + `type="topic"、id="${background.id}"、action="close"，input 的 conclusion 写定了什么、没定什么、下一步是什么。`
        + "主会话里的你和用户都从这段结论知道结果，所以要写得离开这段对话也看得懂。只是先放一放时不带 conclusion。",
      `- 话题聊的事变了，用 perform_action（type="topic"、id="${background.id}"、action="rename"）改名。`,
      "- 聊的过程中要动手的事（建工单、查代码、发消息）照常做，不用等话题结束。",
      "- 这个话题已经开好了。下面带过来的对话里用户让你开话题的那句话，说的就是它：不要再开一个。",
    ].join("\n"),
    `这个话题是这样开的：${started}`,
    background.opening
      ? `你已经对用户说过的开场（这是话题里的第一条消息，用户看得到，不要重复它）：\n${clip(background.opening, 6000)}`
      : "",
    background.mainTurns.length
      ? `主会话里最近的对话（只有用户和你的话，不含系统事件；从旧到新）：\n\n${dialogue(background.mainTurns)}`
      : "主会话里没有可以带过来的对话。",
    background.topicTurns.length
      ? `这个话题里之前的对话（会话重新开始了，这是从记录里取回的；从旧到新）：\n\n${dialogue(background.topicTurns)}`
      : "",
  ].filter(Boolean).join("\n\n");
}

/** What the topic's session is asked to do when nobody wrote an opening: write it. */
export const TOPIC_OPENING_REQUEST = [
  "现在写这个话题的开场，它是用户在话题里看到的第一条消息。写这几样，要短：",
  "- 你带过来了什么：和这个话题有关的、已经定了的事，和还没定的事。只写背景里有的，不要编。",
  "- 相关的对象（工单、文件、PR），有才写；提到工单时写成对象链接。",
  "- 最后问用户想先聊哪一块，或者直接给出你认为该先聊的一点。",
  "不要调用工具去查更多东西，不要给话题改名，不要复述选中的原文：它已经显示在开场上面了。",
].join("\n");

function text(t: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: t }], details: details ?? {} };
}

/** Lead's own entry to topics.open (the page calls the same operation, engine's ui-actions/topics.ts). */
export function createTopicTools(deps: UiActionToolDeps): ToolDefinition<any>[] {
  return [
    defineTool({
      name: "open_topic",
      label: "Open Topic",
      description:
        "给用户开一个话题：你和用户的另一段对话，上下文是干净的，事件不进去，用户在右侧的面板里和话题里的你聊。"
        + "什么时候用：用户说想把一件事单独聊、沉浸式地聊（「把刚才聊的 X 单独开一个会话」「这个我们另开一个地方细聊」）。"
        + "用户没有这样要求时不要自己开；你觉得一件事值得单独聊时，先问一句。"
        + "title：话题的名字，短，一眼看得出是哪件事。"
        + "opening：话题里的第一条消息，由你现在写，因为这段对话的上下文只有你有。写你带过去的必要信息："
        + "和这件事有关的、已经定了什么，还没定什么，相关的工单或文件；最后问用户想先聊哪一块。"
        + "只写和这个话题有关的，不要把整段对话搬过去；主会话最近的几轮系统会另外带给话题里的你。"
        + "开好以后界面会在你这条回答下面画出话题的入口，你用一句话告诉用户开好了就行。",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: TOPIC_TITLE_MAX_LENGTH, description: "话题的名字" }),
        opening: Type.String({
          minLength: 1, maxLength: TOPIC_OPENING_MAX_LENGTH,
          description: "话题里的第一条消息（Markdown）：已经定了什么、还没定什么、相关的对象，最后问用户想先聊哪一块",
        }),
      }),
      execute: async (_id, params: { title: string; opening: string }) => {
        // Inside a topic there is no second topic: the user is already in a separate conversation, and what the
        // background carries over (the user's request to open this one) is not a new request. A refusal with the
        // next step, not a dead end: the user asks in the main conversation.
        if (authorityTurnId(deps)?.startsWith(TOPIC_TURN_ID_PREFIX)) {
          return {
            ...text("你现在就在一个话题里，不能在话题里再开话题。背景里用户说的「单独开一个会话」指的就是这个话题，它已经开好了。"
              + "用户确实想另开一个话题时，请他回到主会话里说，或者在主会话里选中一段话点「单独聊」。"),
            isError: true,
          };
        }
        const result = await performLeadUiAction(deps, {
          target: { type: "topics", id: "lead" }, action: "open",
          input: { title: params.title, opening: params.opening },
          reason: "用户让我把这件事单独开一个话题",
        });
        return result ?? text("没有开成。");
      },
    }),
  ];
}

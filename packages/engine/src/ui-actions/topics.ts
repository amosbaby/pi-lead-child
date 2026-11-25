// Topics (protocol's topics.ts, user 2026-11-25): open, rename, close, reopen.
// The page (POST /v1/actions/topics/lead/open …) and Lead (open_topic, perform_action) call the same definitions.
//   - open: lead_allowed, not a rule change. Lead opens one when the user asks in the main conversation and writes the
//     opening itself. The page opens one from a text selection; then the topic's own session writes the opening
//     (services.topics.generateOpening). The selected text must be in the turn it names, as for a quote (P17.2).
//   - rename, close, reopen: lead_allowed. close with a conclusion is how a topic reports to the main conversation.
// Every change sends snapshot.required (topics); only connections that declared include=topics get it.
import {
  chatQuoteAppearsIn, TOPIC_CONCLUDED_KIND, TOPIC_CONCLUDED_REPORTED, TOPIC_OPEN_LIMIT, TOPIC_OPENING_ORIGIN, TOPICS_RESOURCE, topicTitleFromQuote,
  leadModelSpec,
  type CloseTopicRequest, type OpenTopicRequest, type RenameTopicRequest, type SetTopicModelRequest, type TopicDto,
} from "@pi-lead-child/protocol";
import {
  appendEvent, closeTopic, createTopic, createTopicTurn, getTopic, getTurn, listTopicDtos, publishGatewayEvent, renameTopic,
  reopenTopic, setTopicModel, topicDto, TopicLimitError, type Db,
} from "@pi-lead-child/store";
import { AVAILABLE } from "../ticket-actions/types.js";
import { UiActionError, type UiActionDefinition, type UiActionTargetKind } from "./types.js";

export const TOPICS_WHERE = "会话 → 选中一段文字 →「单独聊」，或者左栏的「话题」";

const COMMON = {
  scope: "chat", permission: "lead_allowed", changesRules: false, external: false, irreversible: false, where: TOPICS_WHERE,
} as const;

export interface TopicsTarget {
  open: TopicDto[];
}

function topicsChanged(db: Db): void {
  publishGatewayEvent(db, { type: "snapshot.required", requiredScope: "chat", payload: { resource: TOPICS_RESOURCE } });
}

function limitError(): UiActionError {
  return new UiActionError("unavailable", `已经开着 ${TOPIC_OPEN_LIMIT} 个话题：先结束一个不用的，再开新的`);
}

export const TOPICS_TARGET: UiActionTargetKind<TopicsTarget> = {
  type: "topics",
  label: "话题的清单",
  idHint: "lead",
  load: (env, id) => (id === "lead" ? { open: listTopicDtos(env.db, { state: "open" }) } : null),
  name: () => "话题",
  describe: (target) => ({
    open: target.open.map((topic) => ({ id: topic.id, title: topic.title, turns: topic.turnCount, lastActivityAt: topic.lastActivityAt })),
  }),
};

export const TOPICS_ACTIONS = {
  open: {
    target: "topics", id: "open", label: "开一个话题", ...COMMON,
    hint: "用户想把一件大事单独聊（「把刚才聊的 X 单独开一个会话」「我想沉浸式地聊 X」）时用，一般用 open_topic 工具。"
      + "话题是你的另一段对话，上下文是干净的，事件不进去。title 写话题的名字；opening 写你带过去的内容："
      + "已经定了什么、还没定什么、相关的工单或文件，最后问用户想先聊哪一块。",
    defaultReason: "在会话里开了一个话题",
    available: () => AVAILABLE,
    run: (run): TopicDto => {
      const input = run.input as OpenTopicRequest;
      const byLead = run.by.actor === "lead";
      let originTurnId: string | null = byLead ? run.turnId : null;
      let originRole: "assistant" | "user" | null = null;
      const quote = input.quote ?? null;
      if (quote) {
        // A selection from an external message card is external content: a topic that starts from it would carry
        // it into a session that counts as the user's own. Not supported.
        if (quote.source.kind !== "turn") {
          throw new UiActionError("invalid_input", "话题只能从会话里你或 Lead 说的话开；外来消息卡里的话请先引用回复");
        }
        const turn = getTurn(run.db, quote.source.turnId);
        const source = turn ? (quote.source.role === "assistant" ? turn.assistant_text : turn.user_text) : null;
        if (source === null || !chatQuoteAppearsIn(quote.text, [source])) {
          throw new UiActionError("invalid_input", "选中的文字不在那一条消息里：重新选一次");
        }
        originRole = quote.source.role;
        if (!byLead) originTurnId = quote.source.turnId;
      }
      const title = (input.title ?? (quote ? topicTitleFromQuote(quote.text) : "")).trim();
      if (!title) throw new UiActionError("invalid_input", "话题要有名字：给 title，或者从一段选中的文字开");
      const opening = input.opening?.trim() || null;
      let row;
      try {
        row = run.db.transaction(() => {
          const created = createTopic(run.db, {
            title, openedBy: byLead ? "lead" : "user", originTurnId, originQuote: quote?.text ?? null, originRole, now: run.env.now,
          });
          // An opening that the caller wrote is the first message of the topic as written.
          if (opening) {
            createTopicTurn(run.db, {
              topicId: created.id, originKind: TOPIC_OPENING_ORIGIN, assistantText: opening, state: "completed", now: run.env.now,
            });
          }
          return created;
        })();
      } catch (error) {
        if (error instanceof TopicLimitError) throw limitError();
        throw error;
      }
      // No opening given: the topic's own session writes one. The call returns before the model answers.
      if (!opening) run.env.services.topics?.generateOpening(row.id, { bindingId: run.bindingId });
      topicsChanged(run.db);
      return topicDto(run.db, getTopic(run.db, row.id)!);
    },
    forLead: (_run, result) => {
      const topic = result as TopicDto;
      return {
        result: "opened", topicId: topic.id, title: topic.title,
        next: "话题开好了，界面已经在你这条回答下面画出它的入口。用一句话告诉用户开好了，不用重复 opening 的内容。"
          + "这以后用户在话题里说的话由话题里的你回答，不进这段对话；话题结束时它的结论会出现在你的当前局面里。",
      };
    },
    detail: (_run, result) => ({ topicId: (result as TopicDto).id, title: (result as TopicDto).title }),
  },
} satisfies Record<string, UiActionDefinition<TopicsTarget, any>>;

export const TOPIC_TARGET: UiActionTargetKind<TopicDto> = {
  type: "topic",
  label: "一个话题",
  idHint: "话题的编号（整数，topics 目标的 open 里的 id）",
  load: (env, id) => {
    const row = /^[1-9]\d{0,9}$/u.test(id) ? getTopic(env.db, Number(id)) : undefined;
    return row ? topicDto(env.db, row) : null;
  },
  name: (topic) => `话题「${topic.title}」`,
  describe: (topic) => ({
    title: topic.title, state: topic.state, turns: topic.turnCount, conclusion: topic.conclusion, lastActivityAt: topic.lastActivityAt,
  }),
};

interface TopicChange {
  changed: boolean;
  topic: TopicDto;
}

function reloaded(db: Db, id: number): TopicDto {
  const row = getTopic(db, id);
  if (!row) throw new UiActionError("not_found", "这个话题已经不在了");
  return topicDto(db, row);
}

export const TOPIC_ACTIONS = {
  rename: {
    target: "topic", id: "rename", label: "给话题改名", ...COMMON,
    hint: "话题聊的事变了，或者现在的名字说不清它在聊什么时用。名字要短，一眼看得出是哪件事。",
    defaultReason: "给话题改了名",
    available: () => AVAILABLE,
    run: (run): TopicChange => {
      const title = (run.input as RenameTopicRequest).title.trim();
      if (!title) throw new UiActionError("invalid_input", "名字不能是空的");
      if (title === run.target.title) return { changed: false, topic: run.target };
      renameTopic(run.db, run.target.id, title, run.env.now);
      topicsChanged(run.db);
      return { changed: true, topic: reloaded(run.db, run.target.id) };
    },
    forLead: (_run, result) => {
      const change = result as TopicChange;
      return { result: change.changed ? "renamed" : "unchanged", topicId: change.topic.id, title: change.topic.title };
    },
    detail: (run, result) => ({ before: run.target.title, after: (result as TopicChange).topic.title }),
  },
  close: {
    target: "topic", id: "close", label: "结束话题", ...COMMON,
    hint: "话题聊完了，或者用户说「带回去」「就这么定了」时用。conclusion 写这个话题的结论：定了什么、没定什么、下一步是什么，"
      + "主会话里的你和用户都从它知道这个话题的结果。只是先放一放、没有结论时不带 conclusion。结束以后可以用 reopen 接着聊。",
    defaultReason: "结束了话题",
    available: () => AVAILABLE,
    run: (run): TopicChange => {
      const conclusion = (run.input as CloseTopicRequest).conclusion?.trim() || null;
      if (run.target.state === "closed" && conclusion === null) return { changed: false, topic: run.target };
      run.db.transaction(() => {
        closeTopic(run.db, run.target.id, conclusion, run.env.now);
        // The conclusion goes to the event log too: Lead's main conversation reads it in its situation at the next
        // turn (record level, it wakes nobody). The event and the close commit together.
        if (conclusion !== null) {
          appendEvent(run.db, {
            source: "system",
            kind: TOPIC_CONCLUDED_KIND,
            entityKey: `topic:${run.target.id}`,
            occurredAt: run.env.now.toISOString(),
            level: "record",
            payload: { topicId: run.target.id, title: run.target.title, conclusion, actor: run.by.actor === "lead" ? "lead" : "user" },
          }, { basis: { order: null, hardRules: [TOPIC_CONCLUDED_REPORTED] }, receivedAt: run.env.now });
        }
      })();
      run.env.services.topics?.closed(run.target.id);
      topicsChanged(run.db);
      return { changed: true, topic: reloaded(run.db, run.target.id) };
    },
    forLead: (_run, result) => {
      const change = result as TopicChange;
      return {
        result: change.changed ? "closed" : "unchanged", topicId: change.topic.id,
        ...(change.changed && change.topic.conclusion
          ? { next: "结论已经带回主会话。用一句话告诉用户话题结束了、结论带回去了。" }
          : {}),
      };
    },
    detail: (_run, result) => ({ concluded: Boolean((result as TopicChange).topic.conclusion) }),
  },
  set_model: {
    target: "topic", id: "set_model", label: "换这个话题用的模型", ...COMMON,
    // The same rule as lead_model.switch: the user's own choice. Lead does it only when the user asks in this turn.
    permission: "user_only",
    where: "话题输入框右下角的模型名",
    hint: "用户要这个话题换一个模型或推理强度时用。choice 的 model 写 list_lead_models 列出的 provider/id，不带推理强度；"
      + "effort 写这个模型支持的推理强度，或者 null。choice 写 null 是跟回主会话的模型。只改这个话题，主会话的模型不变；"
      + "话题里的下一条消息起生效。",
    defaultReason: "换了话题用的模型",
    available: () => AVAILABLE,
    run: async (run): Promise<TopicChange> => {
      const { choice } = run.input as SetTopicModelRequest;
      const spec = choice ? leadModelSpec(choice) : null;
      if (spec === run.target.model) return { changed: false, topic: run.target };
      if (spec !== null) {
        const service = run.env.services.topics;
        if (!service) throw new UiActionError("unavailable", "话题还没有启动，稍后再试");
        try {
          await service.checkModel(spec);
        } catch (error) {
          throw new UiActionError("invalid_input", error instanceof Error ? error.message : String(error));
        }
      }
      setTopicModel(run.db, run.target.id, spec, run.env.now);
      topicsChanged(run.db);
      return { changed: true, topic: reloaded(run.db, run.target.id) };
    },
    forLead: (_run, result) => {
      const change = result as TopicChange;
      return { result: change.changed ? "updated" : "unchanged", topicId: change.topic.id, model: change.topic.model ?? "follows the main conversation" };
    },
    detail: (run, result) => ({ before: run.target.model, after: (result as TopicChange).topic.model }),
  },
  reopen: {
    target: "topic", id: "reopen", label: "接着聊一个结束了的话题", ...COMMON,
    hint: "用户想接着聊一个已经结束的话题时用。话题原来的对话都在。",
    defaultReason: "重新打开了话题",
    available: () => AVAILABLE,
    run: (run): TopicChange => {
      if (run.target.state === "open") return { changed: false, topic: run.target };
      try {
        reopenTopic(run.db, run.target.id, run.env.now);
      } catch (error) {
        if (error instanceof TopicLimitError) throw limitError();
        throw error;
      }
      topicsChanged(run.db);
      return { changed: true, topic: reloaded(run.db, run.target.id) };
    },
    forLead: (_run, result) => {
      const change = result as TopicChange;
      return { result: change.changed ? "reopened" : "unchanged", topicId: change.topic.id };
    },
  },
} satisfies Record<string, UiActionDefinition<TopicDto, any>>;

// Slack 的文档（2026-11-20：用户要 Lead 能写 Slack 的 canvas 和可以编辑的 Markdown 文件）：通道的 ChannelDocuments 在 Slack 里的实现。
//   - canvas：canvases.create（document_content 是 Markdown）、canvases.getContent（取 Markdown 原文）、canvases.edit（一次一步，
//     段落按 canvases.sections.lookup 找）。放进对话时传 channel_id：Slack 把它挂成这个频道的 canvas 标签页，频道里的人都能看。
//     要 canvases:read、canvases:write（可选的权限，缺了就告诉 Lead 去哪里加）。
//   - Markdown 文件（.md）：files.getUploadURLExternal 要上传地址，POST 内容，files.completeUploadExternal 完成，放进对话时
//     同时分享到那个频道或 thread。读：files.info 问下载地址，带令牌下载。要 files:write、files:read。
//     Slack 没有改文件内容的方法（官方文档里没有 files.edit），所以改 Markdown 文件就是上传一份新的，分享到旧的第一次分享的地方，
//     再删掉旧的（只删用户自己的文件；别人的留着，告诉 Lead）。文件的编号跟着变。
//   - 文档的编号是 Slack 的文件编号（F 开头；canvas 也是文件）。也认 Slack 的链接（.../docs/T…/F…、.../files/U…/F…），
//     从里面取出文件编号。
//   - 用户的令牌在对话里分享文件时，Slack 会把这条消息推回来。onShared 记下文件编号和正在分享的频道，解析时认成系统发的（echo）。
import type { ChannelAdapterContext, ChannelDocument, ChannelDocumentChange, ChannelDocumentContent, ChannelDocumentEdited, ChannelDocuments } from "../types.js";
import { ChannelFileNotFoundError } from "../types.js";
import { SLACK_FILES_HOST, slackFileUrlAllowed, type SlackWebApi } from "./slack-web-api.js";

export const SLACK_DOCUMENT_KINDS = {
  canvas: "Slack canvas：可以多人一起编辑的富文本文档（标题、清单、表格、提到人）。放进频道时挂成频道的 canvas 标签页；"
    + "不放进对话时只有用户自己能看，要给人看就把链接发给他。能按段改。",
  markdown: "Markdown 文件（.md）：Slack 里能预览、能下载的文件，放进对话时作为文件分享出去。"
    + "Slack 不能原地改文件：改时上传一份新的，替换旧的（文件编号会变）。不能按段改，只能整份换、在开头或末尾加、改名。",
} as const;

// Slack 的上限：canvas 一次的 Markdown 最多 1 MiB 个字符，snippet 最多 1 MB。
const CANVAS_MARKDOWN_MAX = 1_048_576;
const MARKDOWN_FILE_MAX_BYTES = 1_000_000;
// canvases.edit 回 canvas_editing_locked（别人正在改）时等一下再试一次。
const EDIT_LOCKED_RETRY_MS = 1_000;

const FILE_ID = /^F[A-Z0-9]{6,30}$/;
const FILE_ID_IN_URL = /\/(F[A-Z0-9]{6,30})(?:[/?#]|$)/;

const SCOPE_OF: Readonly<Record<string, string>> = {
  "canvases.create": "canvases:write", "canvases.edit": "canvases:write", "canvases.sections.lookup": "canvases:read",
  "canvases.getContent": "canvases:read", "files.info": "files:read", "files.getUploadURLExternal": "files:write",
  "files.completeUploadExternal": "files:write", "files.delete": "files:write",
};
const GONE = new Set(["canvas_not_found", "canvas_deleted", "file_not_found", "file_deleted"]);

export interface SlackDocumentsOptions {
  web: SlackWebApi;
  // 用户的令牌在一个频道里分享了一个文件（正在分享的 Promise）：解析推回来的消息时认成系统发的。
  onShared(channel: string, fileId: string, sharing: Promise<unknown>): void;
  wait?: (ms: number) => Promise<void>;
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 文档编号或者 Slack 链接里的文件编号。认不出时抛 ChannelFileNotFoundError。 */
export function slackDocumentId(ref: string): string {
  const trimmed = ref.trim();
  if (FILE_ID.test(trimmed)) return trimmed;
  const found = FILE_ID_IN_URL.exec(trimmed);
  if (found) return found[1]!;
  throw new ChannelFileNotFoundError(`不是 Slack 的文档编号或者链接：${ref}。要像 F0123ABCD，或者 canvas、文件的链接`);
}

/** 文件名：标题去掉文件名里不能有的字，加上 .md。 */
function markdownFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "document";
  return /\.(md|markdown)$/i.test(base) ? base : `${base}.md`;
}

interface SlackFileFacts {
  id: string;
  kind: "canvas" | "markdown" | null;
  title: string | null;
  url: string | null;
  owner: string | null;
  download: string | null;
  size: number;
  // 第一次分享的地方（换一份新的时分享回去）。
  share: { channel: string; threadTs: string | null } | null;
  prettyType: string;
}

function firstShare(file: Record<string, unknown>): SlackFileFacts["share"] {
  const shares = isRecord(file.shares) ? file.shares : {};
  for (const scope of ["public", "private"]) {
    const places = isRecord(shares[scope]) ? shares[scope] as Record<string, unknown> : {};
    for (const [channel, list] of Object.entries(places)) {
      const first = Array.isArray(list) && isRecord(list[0]) ? list[0] : {};
      return { channel, threadTs: isString(first.thread_ts) ? first.thread_ts : null };
    }
  }
  const channels = [file.channels, file.groups, file.ims].flatMap((list) => Array.isArray(list) ? list.filter(isString) : []);
  return channels[0] ? { channel: channels[0], threadTs: null } : null;
}

function factsOf(file: Record<string, unknown>, id: string): SlackFileFacts {
  const filetype = isString(file.filetype) ? file.filetype.toLowerCase() : "";
  const prettyType = isString(file.pretty_type) ? file.pretty_type : filetype || "file";
  const mimetype = isString(file.mimetype) ? file.mimetype.toLowerCase() : "";
  const canvas = filetype === "canvas" || filetype === "quip" || prettyType.toLowerCase().includes("canvas");
  const text = filetype === "markdown" || filetype === "text" || mimetype.startsWith("text/");
  const download = isString(file.url_private_download) ? file.url_private_download : isString(file.url_private) ? file.url_private : null;
  return {
    id,
    kind: canvas ? "canvas" : text ? "markdown" : null,
    title: isString(file.title) ? file.title : isString(file.name) ? file.name : null,
    url: isString(file.permalink) ? file.permalink : null,
    owner: isString(file.user) ? file.user : null,
    download,
    size: typeof file.size === "number" ? file.size : 0,
    share: firstShare(file),
    prettyType,
  };
}

export function createSlackDocuments(options: SlackDocumentsOptions): ChannelDocuments {
  const { web } = options;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call(method: string, args: Record<string, unknown>, context: ChannelAdapterContext): Promise<Record<string, unknown>> {
    const result = await web.call(method, args, context.credential.token);
    if (result.ok === true) return result;
    const error = isString(result.error) ? result.error : "not ok";
    if (GONE.has(error)) throw new ChannelFileNotFoundError(`Slack 里没有这份文档，或者你看不到它（${error}）`);
    if (error === "missing_scope") {
      const scope = SCOPE_OF[method] ?? (isString(result.needed) ? result.needed : "需要的权限");
      throw new Error(`用户令牌缺 ${scope} 权限（${method}）。在应用的 OAuth & Permissions 的 User Token Scopes 里加上 ${scope}，`
        + "再重新安装，把新的 User OAuth Token 填进设置页");
    }
    const detail = isString(result.detail) ? `：${result.detail}` : "";
    throw new Error(`slack ${method}: ${error}${detail}`);
  }

  async function info(id: string, context: ChannelAdapterContext): Promise<SlackFileFacts> {
    const result = await call("files.info", { file: id }, context);
    return factsOf(isRecord(result.file) ? result.file : {}, id);
  }

  // canvas 的标题和链接：files.info 问不到（例如缺 files:read）时只给编号。
  async function canvasFacts(id: string, context: ChannelAdapterContext): Promise<ChannelDocument> {
    try {
      const facts = await info(id, context);
      return { ref: id, kind: "canvas", title: facts.title, url: facts.url };
    } catch (error) {
      if (error instanceof ChannelFileNotFoundError) throw error;
      return { ref: id, kind: "canvas", title: null, url: null };
    }
  }

  async function downloadText(facts: SlackFileFacts, maxBytes: number, context: ChannelAdapterContext): Promise<string> {
    if (!facts.download) throw new Error(`Slack 没有给这个文件的下载地址：${facts.id}`);
    if (!slackFileUrlAllowed(facts.download)) throw new Error(`这个文件的下载地址不在 ${SLACK_FILES_HOST} 上，不带令牌去下载`);
    if (!web.download) throw new Error("这个 Slack 客户端不能下载文件");
    const data = await web.download(facts.download, context.credential.token, maxBytes);
    return new TextDecoder().decode(data);
  }

  // 上传一个 Markdown 文件；target 给了时分享到那个频道（和 thread）。
  async function uploadMarkdown(
    input: { title: string; markdown: string; target: { channel: string; threadTs: string | null } | null }, context: ChannelAdapterContext,
  ): Promise<ChannelDocument> {
    if (!web.upload) throw new Error("这个 Slack 客户端不能上传文件");
    const data = new TextEncoder().encode(input.markdown);
    if (data.byteLength > MARKDOWN_FILE_MAX_BYTES) throw new Error(`Markdown 文件最多 1 MB，这份有 ${data.byteLength} 字节`);
    const filename = markdownFileName(input.title);
    const started = await call("files.getUploadURLExternal", { filename, length: data.byteLength }, context);
    const url = started.upload_url;
    const fileId = started.file_id;
    if (!isString(url) || !isString(fileId)) throw new Error("slack files.getUploadURLExternal: no upload_url or file_id in the response");
    await web.upload(url, data);
    const done = call("files.completeUploadExternal", {
      files: [{ id: fileId, title: input.title }],
      ...(input.target ? { channel_id: input.target.channel } : {}),
      ...(input.target?.threadTs ? { thread_ts: input.target.threadTs } : {}),
    }, context);
    if (input.target) options.onShared(input.target.channel, fileId, done);
    const result = await done;
    const file = Array.isArray(result.files) && isRecord(result.files[0]) ? result.files[0] : {};
    return { ref: fileId, kind: "markdown", title: input.title, url: isString(file.permalink) ? file.permalink : null };
  }

  async function sectionId(canvasId: string, section: { containsText: string; types?: string[] }, context: ChannelAdapterContext): Promise<string> {
    const result = await call("canvases.sections.lookup", {
      canvas_id: canvasId,
      criteria: { contains_text: section.containsText, ...(section.types?.length ? { section_types: section.types } : {}) },
    }, context);
    const ids = (Array.isArray(result.sections) ? result.sections : [])
      .map((entry) => isRecord(entry) ? entry.id : null).filter(isString);
    if (ids.length === 0) throw new Error(`canvas 里没有包含「${section.containsText}」的段落。先读一遍原文，照抄段里的一句`);
    if (ids.length > 1) throw new Error(`canvas 里有 ${ids.length} 段都包含「${section.containsText}」。换一句只在那一段里有的话，或者限定段的种类`);
    return ids[0]!;
  }

  async function editCanvas(id: string, change: ChannelDocumentChange, context: ChannelAdapterContext): Promise<void> {
    let step: Record<string, unknown>;
    if (change.operation === "rename") {
      step = { operation: "rename", title_content: { type: "markdown", markdown: change.title } };
    } else {
      if ("markdown" in change && change.markdown.length > CANVAS_MARKDOWN_MAX) throw new Error("canvas 一次最多 1 MiB 的 Markdown");
      const section = "section" in change && change.section ? await sectionId(id, change.section, context) : null;
      step = {
        operation: change.operation,
        ...(section ? { section_id: section } : {}),
        ...("markdown" in change ? { document_content: { type: "markdown", markdown: change.markdown } } : {}),
      };
    }
    const args = { canvas_id: id, changes: [step] };
    try {
      await call("canvases.edit", args, context);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("canvas_editing_locked")) throw error;
      await wait(EDIT_LOCKED_RETRY_MS);
      await call("canvases.edit", args, context);
    }
  }

  return {
    kinds: SLACK_DOCUMENT_KINDS,

    async create(input, context) {
      const channel = isString(input.target?.channel) ? input.target.channel : null;
      if (input.kind === "canvas") {
        if (input.markdown.length > CANVAS_MARKDOWN_MAX) throw new Error("canvas 一次最多 1 MiB 的 Markdown");
        const result = await call("canvases.create", {
          title: input.title, document_content: { type: "markdown", markdown: input.markdown }, ...(channel ? { channel_id: channel } : {}),
        }, context);
        if (!isString(result.canvas_id)) throw new Error("slack canvases.create: no canvas_id in the response");
        const facts = await canvasFacts(result.canvas_id, context);
        return { ...facts, title: facts.title ?? input.title };
      }
      if (input.kind === "markdown") {
        const threadTs = isString(input.target?.thread_ts) ? input.target.thread_ts : null;
        return uploadMarkdown({ title: input.title, markdown: input.markdown, target: channel ? { channel, threadTs } : null }, context);
      }
      throw new Error(`Slack 没有「${input.kind}」这种文档`);
    },

    async read(ref, readOptions, context): Promise<ChannelDocumentContent> {
      const id = slackDocumentId(ref);
      let facts: SlackFileFacts | null = null;
      try {
        facts = await info(id, context);
      } catch (error) {
        // 缺 files:read 时还可以按 canvas 读（canvases:read）。
        if (error instanceof ChannelFileNotFoundError) throw error;
      }
      if (!facts || facts.kind === "canvas") {
        const result = await call("canvases.getContent", { canvas_id: id, content_type: "markdown" }, context);
        const markdown = isString(result.content) ? result.content : "";
        return { ref: id, kind: "canvas", title: facts?.title ?? null, url: facts?.url ?? null, markdown };
      }
      if (facts.kind !== "markdown") {
        throw new Error(`这不是文档，是 ${facts.prettyType} 文件。看文件用 read_channel_file`);
      }
      if (facts.size > readOptions.maxBytes) throw new Error(`文件有 ${facts.size} 字节，超过了上限 ${readOptions.maxBytes}`);
      return { ref: id, kind: "markdown", title: facts.title, url: facts.url, markdown: await downloadText(facts, readOptions.maxBytes, context) };
    },

    async edit(ref, change, context): Promise<ChannelDocumentEdited> {
      const id = slackDocumentId(ref);
      let facts: SlackFileFacts | null = null;
      try {
        facts = await info(id, context);
      } catch (error) {
        if (error instanceof ChannelFileNotFoundError) throw error;
      }
      if (!facts || facts.kind === "canvas") {
        await editCanvas(id, change, context);
        return canvasFacts(id, context);
      }
      if (facts.kind !== "markdown") throw new Error(`这不是文档，是 ${facts.prettyType} 文件，改不了`);
      if ("section" in change && change.section) {
        throw new Error("Markdown 文件不能按段改：先读原文，改好以后用 replace 换掉整份");
      }
      if (change.operation === "delete" || change.operation === "insert_before" || change.operation === "insert_after") {
        throw new Error(`Markdown 文件不能 ${change.operation}：先读原文，改好以后用 replace 换掉整份`);
      }
      const title = change.operation === "rename" ? change.title : facts.title ?? "document";
      let markdown: string;
      if (change.operation === "replace") {
        markdown = change.markdown;
      } else {
        const current = await downloadText(facts, MARKDOWN_FILE_MAX_BYTES, context);
        markdown = change.operation === "rename" ? current
          : change.operation === "insert_at_start" ? `${change.markdown}\n${current}` : `${current.replace(/\n*$/, "\n")}${change.markdown}`;
      }
      const created = await uploadMarkdown({ title, markdown, target: facts.share }, context);
      let oldKept: string | undefined;
      if (facts.owner && facts.owner !== context.credential.account) {
        oldKept = "旧的文件是别人的，没有删，两份都在";
      } else {
        try {
          await call("files.delete", { file: id }, context);
        } catch (error) {
          oldKept = `旧的文件没删掉（${error instanceof Error ? error.message : String(error)}），两份都在`;
        }
      }
      return { ...created, replacedRef: id, ...(oldKept ? { oldKept } : {}) };
    },
  };
}

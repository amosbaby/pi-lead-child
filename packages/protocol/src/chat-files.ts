// 发给 Lead 的文件（2026-11-19）。
//
// 用户在会话的输入框里选文件（日志、PDF、CSV、压缩包，什么类型都行），chat.send 带上 files：每个文件是名字、MIME 类型和
// base64 的内容。daemon 把文件和这一轮一起存下，再写进这一轮自己的文件夹（数据目录的 chat-files/<轮次>/），Lead 用 read、
// bash 读那里的文件。交给 Lead 的消息只列每个文件的名字、类型、大小和路径，不放文件的内容。会话快照里列出文件，
// 客户端按 id 取文件（GET /v1/chat/files/:id）。
//
// 线上契约（和图片一样，chat-images.ts）：
//   · 旧 daemon 严格校验命令、不认识 files：客户端只在 hello.v2 的 capabilities 里有 CHAT_FILES_CAPABILITY 时带它。
//   · 会话快照的 files 只在 ?include=files 时才有：旧客户端严格校验整条记录。
//   · 只有 Lead 的会话收文件。工单对话交给工单的 agent，带文件的工单消息被拒收。
//
// 大小：一条消息最多 5 个文件，每个最多 10 MB（解码后的字节）。不另设合计上限：5 个满额的文件要能和 8 张满额的图片
// 一起放进一条 chat.send。CHAT_SEND_MAX_BYTES（chat-images.ts）按两者的合计算，网关的 WebSocket 帧和 HTTP 兜底的请求体
// 都用它。客户端发之前按同样的上限检查（chatFileInputProblem），超了不发，告诉用户哪个文件太大。
//
// 名字：网关清理名字（sanitizeChatFileName）：去掉目录部分，拒收 . 和 ..、控制字符。写进文件夹时再去重、限长
// （chatFileDiskNames）。名字只是标签，路径由 daemon 定，名字跑不出这一轮的文件夹。
import { Type, type Static } from "typebox";

export const CHAT_FILES_CAPABILITY = "chat.files.v1";
// GET /v1/conversation/turns?include=files：每一轮带上用户发的文件（不带内容）。
export const CHAT_FILES_INCLUDE = "files";

// 一条消息最多带几个文件。
export const CHAT_FILE_MAX_COUNT = 5;
// 一个文件最多多少字节（解码后）。
export const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
// 一个文件的 base64 最长多少个字符：CHAT_FILE_MAX_BYTES 个字节编码以后的长度。
export const CHAT_FILE_MAX_BASE64_LENGTH = Math.ceil(CHAT_FILE_MAX_BYTES / 3) * 4;
// 一条消息所有文件的 base64 加起来最长多少个字符：不另设合计上限，就是每个满额的合计。
export const CHAT_FILES_MAX_TOTAL_BASE64_LENGTH = CHAT_FILE_MAX_COUNT * CHAT_FILE_MAX_BASE64_LENGTH;
// 文件名最长多少个字符。
export const CHAT_FILE_NAME_MAX_LENGTH = 255;
// MIME 类型最长多少个字符。
export const CHAT_FILE_MIME_TYPE_MAX_LENGTH = 255;
// 客户端没给类型、或者给的不像 MIME 类型时用它。
export const CHAT_FILE_DEFAULT_MIME_TYPE = "application/octet-stream";
// 一个文件名在磁盘上最多多少字节（macOS、Linux 常见的上限）。
export const CHAT_FILE_DISK_NAME_MAX_BYTES = 255;

// chat.send 里的一个文件。mimeType 可以不带，daemon 按 application/octet-stream 存。空文件也收（data 是空字符串）。
export const ChatFileInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: CHAT_FILE_NAME_MAX_LENGTH }),
  mimeType: Type.Optional(Type.String({ maxLength: CHAT_FILE_MIME_TYPE_MAX_LENGTH })),
  data: Type.String({ maxLength: CHAT_FILE_MAX_BASE64_LENGTH }),
}, { additionalProperties: false });
export type ChatFileInput = Static<typeof ChatFileInputSchema>;

export const ChatFilesInputSchema = Type.Array(ChatFileInputSchema, { minItems: 1, maxItems: CHAT_FILE_MAX_COUNT });

// 会话快照里用户的一轮带的一个文件（include=files），按发送时的顺序。按 id 取内容。
// name 是清理过的名字（sanitizeChatFileName），size 是字节数。
export const ChatFileRefSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  size: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type ChatFileRef = Static<typeof ChatFileRefSchema>;

// GET /v1/chat/files/:id 的回答。data 是 base64。
export const ChatFileSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  mimeType: Type.String({ minLength: 1 }),
  size: Type.Integer({ minimum: 0 }),
  data: Type.String(),
}, { additionalProperties: false });
export type ChatFile = Static<typeof ChatFileSchema>;

export const CHAT_FILE_ID_PATTERN = /^file_[A-Za-z0-9_-]{1,64}$/;

// 控制字符（C0、DEL、C1）：名字里有就拒收。
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export type SanitizedChatFileName = { ok: true; name: string } | { ok: false; error: string };

// 清理用户给的文件名：去掉目录部分（/ 和 \ 前面的都不要），去掉首尾空白。
// 有控制字符、清理后是空的、是 . 或 .. 的拒收。例如 "../../x" 清理成 "x"，"C:\\logs\\a.log" 清理成 "a.log"。
export function sanitizeChatFileName(raw: string): SanitizedChatFileName {
  if (CONTROL_CHARACTERS.test(raw)) return { ok: false, error: "file name contains control characters" };
  const name = (raw.split(/[\\/]/u).pop() ?? "").normalize("NFC").trim();
  if (!name || name === "." || name === "..") return { ok: false, error: "file name is empty or not a file name" };
  if (name.length > CHAT_FILE_NAME_MAX_LENGTH) return { ok: false, error: "file name is too long" };
  return { ok: true, name };
}

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

// 客户端给的 MIME 类型：去掉参数、转小写。没给或不像 MIME 类型时是 application/octet-stream。
export function normalizeChatFileMimeType(raw: string | undefined): string {
  const bare = (raw ?? "").split(";")[0]!.trim().toLowerCase();
  return MIME_TYPE.test(bare) ? bare : CHAT_FILE_DEFAULT_MIME_TYPE;
}

// base64 解码后有多少字节（不解码）。客户端用它算文件大小，和 daemon 存的一样。
export function chatFileBase64Size(data: string): number {
  if (!data) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

// 给人和 Lead 看的大小：512 B、1.2 KB、3.4 MB。
export function formatChatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

// 客户端发之前的检查：一条消息的文件有什么问题（个数、单个大小、名字）。没有问题时返回 null。
// 网关按同样的规则再查一次。
export function chatFileInputProblem(files: readonly ChatFileInput[]): string | null {
  if (files.length > CHAT_FILE_MAX_COUNT) return `at most ${CHAT_FILE_MAX_COUNT} files per message`;
  for (const file of files) {
    const name = sanitizeChatFileName(file.name);
    if (!name.ok) return `${file.name}: ${name.error}`;
    if (file.data.length > CHAT_FILE_MAX_BASE64_LENGTH || chatFileBase64Size(file.data) > CHAT_FILE_MAX_BYTES) {
      return `${name.name}: a file can be at most ${formatChatFileSize(CHAT_FILE_MAX_BYTES)}`;
    }
  }
  return null;
}

// 一段文字的 UTF-8 字节数。protocol 也在浏览器和手机上跑，不用 Buffer。
const encoder = new TextEncoder();
function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

// 把名字截到 maxBytes 个 UTF-8 字节以内，保留扩展名（扩展名本身太长时不保留）。
function fitBytes(name: string, maxBytes: number): string {
  if (utf8Length(name) <= maxBytes) return name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && utf8Length(name.slice(dot)) <= 32 ? name.slice(dot) : "";
  const budget = maxBytes - utf8Length(extension);
  let stem = "";
  for (const char of name.slice(0, extension ? dot : name.length)) {
    if (utf8Length(stem + char) > budget) break;
    stem += char;
  }
  return `${stem}${extension}`;
}

// 一轮的文件写进文件夹时用的名字，按给的顺序：已经清理过的名字，截到磁盘的上限，再去重。
// 重名（不分大小写：macOS 的磁盘默认不分）的第二个起加「 (2)」「 (3)」，加在扩展名前面。
export function chatFileDiskNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = fitBytes(name, CHAT_FILE_DISK_NAME_MAX_BYTES);
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      const dot = base.lastIndexOf(".");
      const extension = dot > 0 ? base.slice(dot) : "";
      const stem = fitBytes(dot > 0 ? base.slice(0, dot) : base, CHAT_FILE_DISK_NAME_MAX_BYTES - utf8Length(suffix + extension));
      candidate = `${stem}${suffix}${extension}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

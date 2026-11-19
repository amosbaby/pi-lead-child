import {
  CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_MIME_TYPES, type ChatImageInput, type ChatImageMimeType,
} from '@pi-lead-child/protocol';

// 输入框里一张待发的图片：发出去的数据（base64），和画小图用的地址。
export interface ComposerImage extends ChatImageInput {
  key: string;
  uri: string;
}

// 从哪里选图：系统相册（可以多选），或者打开相机拍一张。
export type ChatImageSource = 'library' | 'camera';

// 手机上系统选择器给的一张图：本机地址、格式、尺寸和字节数（不知道字节数时按很大算，一定重新编码）。
export interface NativePickedImage {
  uri: string;
  mimeType: string;
  width: number;
  height: number;
  size: number;
}

// 选出来、还没处理的一张图：web 上是 Blob（文件框、粘贴），手机上是 NativePickedImage。
export type PickedImage = Blob | NativePickedImage;

// 这张图片发不了（不是图片、打不开、压缩以后还是太大）。message 直接显示给用户。
export class ChatImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatImageError';
  }
}

// 原图不超过这么大、长边不超过 CHAT_IMAGE_MAX_EDGE、格式模型收时原样发，不重新编码（截图里的字保持清楚）。
export const KEEP_ORIGINAL_MAX_BYTES = 1024 * 1024;

export type ChatImagePlan =
  | { keep: true; mimeType: ChatImageMimeType }
  | { keep: false; width: number; height: number };

// 一张图片怎么处理：原样发，或者缩到长边 CHAT_IMAGE_MAX_EDGE 以内重新编码。
// 动图（GIF）原样发时保留动画；太大的动图只能重画成静止的第一帧。
export function planChatImage(input: { mimeType: string; bytes: number; width: number; height: number }): ChatImagePlan {
  const edge = Math.max(input.width, input.height);
  const accepted = (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(input.mimeType);
  if (accepted && edge <= CHAT_IMAGE_MAX_EDGE && input.bytes <= KEEP_ORIGINAL_MAX_BYTES) {
    return { keep: true, mimeType: input.mimeType as ChatImageMimeType };
  }
  const scale = edge > CHAT_IMAGE_MAX_EDGE ? CHAT_IMAGE_MAX_EDGE / edge : 1;
  return {
    keep: false,
    width: Math.max(1, Math.round(input.width * scale)),
    height: Math.max(1, Math.round(input.height * scale)),
  };
}

export function composerImage(key: string, image: ChatImageInput): ComposerImage {
  return { key, ...image, uri: `data:${image.mimeType};base64,${image.data}` };
}

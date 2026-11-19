// 发给 Lead 的文件（2026-11-19，加号面板的「文件」）：选出来的文件，和输入框里一份待发的文件。
// 选出来的是图片时按图片处理（缩小、显示小图），见 chatImagePicker；别的类型原样发。

// 选出来、还没读的一个文件。web 上带着 Blob；手机上是系统文件选择给的本机地址。
export interface PickedFile {
  name: string;
  mimeType: string;
  size: number;
  blob?: Blob;
  uri?: string;
}

// 输入框里一份待发的文件：发出去的数据（base64）和显示用的名字、类型、大小。
export interface ComposerFile {
  key: string;
  name: string;
  mimeType: string;
  size: number;
  data: string;
}

// 这个文件发不了（读不出来、太大）。message 直接显示给用户。
export class ChatFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatFileError';
  }
}

// 模型能当图片看的文件：按图片处理。SVG 是文字，按文件发。
export function isPickedImage(file: Pick<PickedFile, 'mimeType'>): boolean {
  return file.mimeType.startsWith('image/') && file.mimeType !== 'image/svg+xml';
}

let sequence = 0;
export function composerFileKey(): string {
  sequence += 1;
  return `file-${Date.now().toString(36)}-${sequence}`;
}

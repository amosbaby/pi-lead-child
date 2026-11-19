import type { PickedImage } from './chatImagePicker.types';
import { ChatFileError, type PickedFile } from './chatFilePicker.types';

export { ChatFileError, formatFileSize, isPickedImage, type ComposerFile, type PickedFile } from './chatFilePicker.types';

// 兜底实现：Metro 在 web 上选 .web.ts，在手机上选 .native.ts。
export const canPickFiles = false;

export async function pickChatFiles(): Promise<PickedFile[]> {
  return [];
}

export async function readChatFile(_file: PickedFile): Promise<string> {
  throw new ChatFileError('cannot read files on this platform');
}

export async function pickedFileAsImage(_file: PickedFile): Promise<PickedImage> {
  throw new ChatFileError('cannot read files on this platform');
}

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator } from 'expo-image-manipulator';

import type { PickedImage } from './chatImagePicker.types';
import { ChatFileError, type PickedFile } from './chatFilePicker.types';

export { ChatFileError, composerFileKey, isPickedImage, type ComposerFile, type PickedFile } from './chatFilePicker.types';

// 手机上（2026-11-19，加号面板的「文件」）：系统的文件选择（iOS 的「文件」、Android 的文档选择器），什么类型都能选，可以多选。
export const canPickFiles = true;

export async function pickChatFiles(): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    name: asset.name,
    mimeType: asset.mimeType ?? 'application/octet-stream',
    size: asset.size ?? new File(asset.uri).size ?? 0,
    uri: asset.uri,
  }));
}

export async function readChatFile(file: PickedFile): Promise<string> {
  if (!file.uri) throw new ChatFileError(file.name);
  return new File(file.uri).base64().catch(() => { throw new ChatFileError(file.name); });
}

// 选到的是图片：量出尺寸，交给选图的规则（缩小、重新编码）。
export async function pickedFileAsImage(file: PickedFile): Promise<PickedImage> {
  const uri = file.uri;
  if (!uri) throw new ChatFileError(file.name);
  const rendered = await ImageManipulator.manipulate(uri).renderAsync().catch(() => { throw new ChatFileError(file.name); });
  const { width, height } = rendered;
  return { uri, mimeType: file.mimeType, width, height, size: file.size };
}

import { CHAT_IMAGE_MAX_BASE64_LENGTH, CHAT_IMAGE_MAX_COUNT } from '@pi-lead-child/protocol';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { DEFAULT_LOCALE, type Locale } from '@/i18n';

import {
  ChatImageError, composerImage, planChatImage, type ChatImageSource, type ComposerImage, type NativePickedImage, type PickedImage,
} from './chatImagePicker.types';
import { imagePickerMessages } from './imagePicker.messages';

export { ChatImageError, type ChatImageSource, type ComposerImage, type PickedImage } from './chatImagePicker.types';

// 手机上（2026-11-19，加号面板的「拍照」「图片」）：系统的照片选择器（可以多选，不用相册权限）和系统相机。
export const canPickImages = true;
export const canTakePhoto = true;

export async function pickImageFiles(source: ChatImageSource = 'library', locale: Locale = DEFAULT_LOCALE): Promise<PickedImage[]> {
  const m = imagePickerMessages(locale);
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 1,
    exif: false,
    allowsMultipleSelection: source === 'library',
    selectionLimit: CHAT_IMAGE_MAX_COUNT,
  };
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new ChatImageError(m.cameraDenied);
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options).catch(() => {
      throw new ChatImageError(m.photosDenied);
    });
  }
  if (result.canceled) return [];
  return result.assets.map((asset): NativePickedImage => ({
    uri: asset.uri,
    mimeType: asset.mimeType ?? 'image/jpeg',
    width: asset.width,
    height: asset.height,
    // 不知道多大：按很大算，一定缩小重新编码。
    size: asset.fileSize ?? Number.MAX_SAFE_INTEGER,
  }));
}

let sequence = 0;

// 和 web 一样的规则（planChatImage）：格式模型收、长边不超过 1568、不太大的原样发；
// 别的（包括 iPhone 的 HEIC）缩到长边 1568 以内，重新编码成 JPEG，还太大就再缩小。
export async function prepareChatImage(picked: PickedImage, locale: Locale = DEFAULT_LOCALE): Promise<ComposerImage> {
  const m = imagePickerMessages(locale);
  if (picked instanceof Blob) throw new ChatImageError(m.cannotOpen);
  sequence += 1;
  const key = `image-${Date.now().toString(36)}-${sequence}`;
  const plan = planChatImage({ mimeType: picked.mimeType, bytes: picked.size, width: picked.width, height: picked.height });
  if (plan.keep) {
    const data = await new File(picked.uri).base64().catch(() => { throw new ChatImageError(m.unreadable); });
    return composerImage(key, { mimeType: plan.mimeType, data });
  }
  for (const scale of [1, 0.75, 0.5]) {
    const width = Math.max(1, Math.round(plan.width * scale));
    const height = Math.max(1, Math.round(plan.height * scale));
    const rendered = await ImageManipulator.manipulate(picked.uri).resize({ width, height }).renderAsync()
      .catch(() => { throw new ChatImageError(m.cannotOpen); });
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
    if (saved.base64 && saved.base64.length <= CHAT_IMAGE_MAX_BASE64_LENGTH) {
      return composerImage(key, { mimeType: 'image/jpeg', data: saved.base64 });
    }
  }
  throw new ChatImageError(m.tooLarge);
}

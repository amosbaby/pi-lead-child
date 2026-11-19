import { DEFAULT_LOCALE, type Locale } from '@/i18n';

import { ChatImageError, type ChatImageSource, type ComposerImage, type PickedImage } from './chatImagePicker.types';
import { imagePickerMessages } from './imagePicker.messages';

export { ChatImageError, type ChatImageSource, type ComposerImage, type PickedImage } from './chatImagePicker.types';

// 兜底实现：Metro 在 web 上选 .web.ts，在手机上选 .native.ts。别的地方（测试以外）不会用到它。
export const canPickImages = false;
export const canTakePhoto = false;

export async function pickImageFiles(_source: ChatImageSource = 'library', _locale: Locale = DEFAULT_LOCALE): Promise<PickedImage[]> {
  return [];
}

export async function prepareChatImage(_file: PickedImage, locale: Locale = DEFAULT_LOCALE): Promise<ComposerImage> {
  throw new ChatImageError(imagePickerMessages(locale).chatUnsupported);
}

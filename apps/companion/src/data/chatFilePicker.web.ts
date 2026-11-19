import type { PickedImage } from './chatImagePicker.types';
import { ChatFileError, type PickedFile } from './chatFilePicker.types';

export { ChatFileError, formatFileSize, isPickedImage, type ComposerFile, type PickedFile } from './chatFilePicker.types';

export const canPickFiles = true;

// 打开浏览器的文件选择：什么类型都能选，可以多选。浏览器要求在用户的点按里调用。
export function pickChatFiles(): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    const done = (files: File[]) => {
      input.remove();
      resolve(files.map((file) => ({ name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, blob: file })));
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => done([]), { once: true });
    // iOS Safari 只打开挂在页面上的文件框。
    document.body.appendChild(input);
    input.click();
  });
}

export function readChatFile(file: PickedFile): Promise<string> {
  const blob = file.blob;
  if (!blob) return Promise.reject(new ChatFileError(file.name));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new ChatFileError(file.name));
    reader.readAsDataURL(blob);
  });
}

export async function pickedFileAsImage(file: PickedFile): Promise<PickedImage> {
  if (!file.blob) throw new ChatFileError(file.name);
  return file.blob;
}

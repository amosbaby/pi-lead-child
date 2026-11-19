// 打开你随消息发出的文件（2026-11-19，主题 A-4）：web 上下载，手机上交给系统的分享面板（能预览、存到「文件」、发给别的 App）。
// 和产物下载走同一个出口（presentArtifactDownload）。
import type { ChatFile } from '@pi-lead-child/protocol';

import { presentArtifactDownload } from './artifactDownload';

export async function presentChatFile(file: ChatFile): Promise<void> {
  const binary = atob(file.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  await presentArtifactDownload({
    artifactId: 0,
    filename: file.name,
    mediaType: file.mimeType,
    bytes: bytes.buffer,
    byteLength: bytes.byteLength,
    sha256: '',
  });
}

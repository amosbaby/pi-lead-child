// 文件卡（主题 11.23 A-2、A-4，2026-11-19）：组件库的 FileCard，说明一行写「大小 · 类型」。
//   · 输入框里待发的（waiting）：右上角 × 去掉。
//   · 你发出的（sent）：点开用系统预览或分享（web 上下载）。
import { FileCard } from '@pi-lead-child/components';
import { formatChatFileSize } from '@pi-lead-child/protocol';

import { useMessages } from '@/i18n';

import { fileMessages } from './file.messages';

export function FileChip({ name, mimeType, size, variant, onPress, onRemove, testID }: {
  name: string;
  mimeType: string;
  size: number;
  variant: 'waiting' | 'sent';
  onPress?: () => void;
  onRemove?: () => void;
  testID?: string;
}) {
  const m = useMessages(fileMessages);
  return (
    <FileCard
      testID={testID}
      variant={variant}
      name={name}
      meta={`${formatChatFileSize(size)} · ${m.kind(name, mimeType)}`}
      {...(onPress ? { onPress, openLabel: m.open(name) } : {})}
      {...(onRemove ? { onRemove, removeLabel: m.remove(name) } : {})}
    />
  );
}

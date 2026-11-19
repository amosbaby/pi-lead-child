import { View } from '@tamagui/core';

import { Pressable } from '../primitives/Pressable';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';

// 一个文件的卡片（主题 11.23 A-2、A-4）：左边 40 的类型图标格子，右边文件名（一行，放不下省略）和一行说明（例如「48 KB · 文本」）。
//   · waiting：输入框里待发的，64 高，surface-subtle 底，右上角 × 去掉（和 ImageThumbnail 的删除按钮一样）。
//   · sent：会话里发出去的，56 高，surface 底，点开（预览、分享或下载由调用方决定）。
export type FileCardProps = {
  name: string;
  meta: string;
  variant: 'waiting' | 'sent';
  onPress?: () => void;
  openLabel?: string;
  onRemove?: () => void;
  removeLabel?: string;
  testID?: string;
};

// 组件规格：卡片的高和宽、图标格子、删除按钮（20 的深色圆，离边 4，底色 text 的 64%，和 ImageThumbnail 一样）。
const WAITING_HEIGHT = 64;
const SENT_HEIGHT = 56;
const WIDTH = 220;
const ICON_WELL = 40;
const REMOVE_SIZE = 20;
const REMOVE_INSET = 4;
const REMOVE_BG = 'rgba(16,19,26,0.64)';

export function FileCard({ name, meta, variant, onPress, openLabel, onRemove, removeLabel, testID }: FileCardProps) {
  const sent = variant === 'sent';
  const body = (
    <View flexDirection="row" items="center" gap="icon-label" flex={1} minW={0}>
      <View w={ICON_WELL} h={ICON_WELL} rounded="lg" bg="accent-soft" items="center" justify="center" shrink={0}>
        <Icon name="file" size={20} color="accent-strong" />
      </View>
      <View flex={1} minW={0}>
        <Text size="secondary" weight="semibold" numberOfLines={1}>{name}</Text>
        <Text size="meta" tone="secondary" numberOfLines={1}>{meta}</Text>
      </View>
    </View>
  );
  return (
    <View
      testID={testID}
      position="relative"
      w={WIDTH}
      h={sent ? SENT_HEIGHT : WAITING_HEIGHT}
      shrink={0}
      rounded="xl"
      bg={sent ? 'surface' : 'surface-subtle'}
      borderWidth={1}
      borderColor={sent ? 'border-strong' : 'border-soft'}
    >
      {onPress ? (
        <Pressable testID={testID ? `${testID}-open` : undefined} aria-label={openLabel ?? name} onPress={onPress} flex={1} px="pill-x" justify="center">
          {body}
        </Pressable>
      ) : (
        <View flex={1} px="pill-x" justify="center" aria-label={name}>{body}</View>
      )}
      {onRemove ? (
        <Pressable
          testID={testID ? `${testID}-remove` : undefined}
          aria-label={removeLabel ?? name}
          onPress={onRemove}
          position="absolute"
          t={REMOVE_INSET}
          r={REMOVE_INSET}
          w={REMOVE_SIZE}
          h={REMOVE_SIZE}
          rounded="full"
          items="center"
          justify="center"
          style={{ backgroundColor: REMOVE_BG }}
        >
          <Icon name="close" size={12} color="surface" weight="bold" />
        </Pressable>
      ) : null}
    </View>
  );
}

import { FloatingSheet, Icon, Pressable, Row, Text, type IconName } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { homeMessages } from './home.messages';

export type PlusTile = { id: string; icon: IconName; label: string; onPress: () => void };

// 加号面板（主题 H-7，2026-11-14 方案 F，画板 FPlus）：悬浮在底部的面板，没有标题。
// 一排方块（拍照、图片、文件，只放这台设备和 daemon 现在能用的）。换模型不在这里（模型配置方案 C 的 S4，2026-11-16）：
// 手机上点首页顶部的模型名，或者在输入框里输入 /model。
export function LeadPlusSheet({ open, onClose, tiles }: {
  open: boolean;
  onClose: () => void;
  tiles: readonly PlusTile[];
}) {
  const m = useMessages(homeMessages);
  return (
    <FloatingSheet testID="lead-plus" inset="menu" open={open} onClose={onClose} label={m.plusTitle}>
      {tiles.length ? (
        <Row gap="card-row">
          {tiles.map((tile) => (
            <Pressable
              key={tile.id}
              testID={`lead-plus-${tile.id}`}
              aria-label={tile.label}
              onPress={() => { onClose(); tile.onPress(); }}
              flex={1}
              h={76} // 组件规格：方块的高度
              rounded="3xl"
              bg={{ default: 'surface-subtle', press: 'surface-muted' }}
              items="center"
              justify="center"
              gap="icon-label"
            >
              <Icon name={tile.icon} size={20} color="text" />
              <Text size="label" weight="semibold">{tile.label}</Text>
            </Pressable>
          ))}
        </Row>
      ) : null}
    </FloatingSheet>
  );
}

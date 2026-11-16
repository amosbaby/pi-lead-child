import { FloatingSheet, Icon, Pressable, Row, Spacer, Text, type IconName } from '@pi-lead-child/components';

import { useMessages } from '@/i18n';

import { homeMessages } from './home.messages';

export type PlusTile = { id: string; icon: IconName; label: string; onPress: () => void };

// 加号面板（主题 H-7，2026-11-14 方案 F，画板 FPlus）：悬浮在底部的面板，没有标题。
// 上面一排方块（拍照、图片、文件，只放这台设备和 daemon 现在能用的），下面一行「模型」和正在用的模型。
// 点「模型」：加号面板收起，换模型的面板升起（11.18，模型配置方案 C；用户 2026-11-16「就在消息输入框的加号按钮里面的浮层」）。
// modelText 是 leadModelTriggerText 的结果（模型 · 推理强度 · 接入）；还不知道在用哪个模型时为 null。
export function LeadPlusSheet({ open, onClose, tiles, modelText, onOpenModel }: {
  open: boolean;
  onClose: () => void;
  tiles: readonly PlusTile[];
  modelText: string | null;
  onOpenModel: () => void;
}) {
  const m = useMessages(homeMessages);
  const shown = modelText ?? m.modelUnknown;
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
      <Pressable
        testID="lead-plus-model"
        aria-label={`${m.model}, ${shown}`}
        onPress={() => { onClose(); onOpenModel(); }}
        feedback="highlight"
        rounded="3xl"
        px="row-x"
        py="row-y"
      >
        <Row items="center" gap="inline-item">
          <Text size="card-title" weight="semibold" numberOfLines={1} shrink={0}>{m.model}</Text>
          <Spacer />
          <Text size="body" tone="secondary" numberOfLines={1} shrink={1} minW={0}>{shown}</Text>
          <Icon name="chevron-right" size={16} color="text-secondary" />
        </Row>
      </Pressable>
    </FloatingSheet>
  );
}

import { FloatingSheet, Icon, Pressable, Row, Spacer, Text, type IconName } from '@pi-lead-child/components';
import { parseLeadModelSpec } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useMessages } from '@/i18n';
import { LeadModelPanel, useModelAccounts } from '@/features/chat/LeadModelPicker';
import { leadModelLabel } from '@/features/chat/leadModelGroups';

import { homeMessages } from './home.messages';

export type PlusTile = { id: string; icon: IconName; label: string; onPress: () => void };

// 加号面板（主题 H-7，2026-11-14 方案 F，画板 FPlus）：悬浮在底部的面板，没有标题。
// 上面一排方块（拍照、图片、文件，只放这台设备和 daemon 现在能用的），下面一行「模型」和正在用的模型、推理强度。
// 点「模型」在同一个面板里换成模型列表（11.18 的内容），面板不关。
export function LeadPlusSheet({ open, onClose, tiles, currentModel }: {
  open: boolean;
  onClose: () => void;
  tiles: readonly PlusTile[];
  currentModel: string | null | undefined;
}) {
  const m = useMessages(homeMessages);
  const accounts = useModelAccounts();
  const [page, setPage] = useState<'menu' | 'model'>('menu');
  const close = () => {
    onClose();
    setPage('menu');
  };
  const known = Boolean(currentModel?.trim()) && currentModel !== 'unknown';
  const label = known ? leadModelLabel(currentModel!, accounts.get(parseLeadModelSpec(currentModel!).model) ?? null) : null;
  const modelText = label ? (label.effort ? m.modelWithEffort(label.id, label.effort) : label.id) : m.modelUnknown;

  return (
    <FloatingSheet testID="lead-plus" inset="menu" open={open} onClose={close} label={page === 'model' ? m.changeModel : m.plusTitle}>
      {page === 'model' ? (
        // 模型列表可能很长：面板最高占屏幕的六成，列表在面板里滚动（FloatingSheet）。
        <LeadModelPanel close={close} />
      ) : (
        <>
          {tiles.length ? (
            <Row gap="card-row">
              {tiles.map((tile) => (
                <Pressable
                  key={tile.id}
                  testID={`lead-plus-${tile.id}`}
                  aria-label={tile.label}
                  onPress={() => { close(); tile.onPress(); }}
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
          <Pressable testID="lead-plus-model" aria-label={`${m.model}, ${modelText}`} onPress={() => setPage('model')} feedback="highlight" rounded="3xl" px="row-x" py="row-y">
            <Row items="center" gap="inline-item">
              <Text size="card-title" weight="semibold">{m.model}</Text>
              <Spacer />
              <Text size="body" tone="secondary" numberOfLines={1} shrink={1}>{modelText}</Text>
              <Icon name="chevron-right" size={16} color="text-secondary" />
            </Row>
          </Pressable>
        </>
      )}
    </FloatingSheet>
  );
}

import { FloatingButton, Icon, LeadAvatar, Pressable, Row, Spacer, Text } from '@pi-lead-child/components';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { leadSubtitleTone, useLeadPresence } from '@/components/LeadIdentity';
import { leadFairy } from '@/components/leadPresence';
import { useLeadAvatarSource } from '@/components/useLeadAvatarSource';
import { useMessages } from '@/i18n';
import { useLeadBusy, useLeadName } from '@/state/hooks';

import { homeMessages } from './home.messages';
import { WaitingButton } from './WaitingButton';

// 手机首页顶部的一行（主题 H-2）：左边是 Lead 的形象，点了打开抽屉；右边是「等你」，没有事等你时不显示。
// 正常状态不写出来：不写「在线」，不写名字。连不上、降级时，形象旁边写一句说明（leadPresence 的同一份文字）。
// 正常时形象旁边是 Lead 现在用的模型（模型配置方案 C 的 S4，输入框和加号面板上不再放模型）：点了升起换模型的面板。
export function HomeTopBar({ waitingCount, onOpenMenu, onOpenWaiting, modelText, onOpenModel }: {
  waitingCount: number;
  onOpenMenu: () => void;
  onOpenWaiting: () => void;
  modelText?: string | null;
  onOpenModel?: () => void;
}) {
  const m = useMessages(homeMessages);
  const name = useLeadName();
  const presence = useLeadPresence();
  const fairy = leadFairy(presence, useLeadBusy());
  const source = useLeadAvatarSource(fairy);
  const abnormal = presence.state !== 'online';
  // 进了别的页面（工单、设置……）时首页还在栈里：形象暂停，不在看不见的地方一直转。
  const [focused, setFocused] = useState(true);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => setFocused(false);
  }, []));
  return (
    <Row testID="home-top-bar" items="center" gap="inline-item" px="page-x" py="float-row-y">
      <FloatingButton testID="home-menu" label={m.openMenu(name)} onPress={onOpenMenu}>
        <LeadAvatar testID="home-menu-avatar" size={36} name={name} state={fairy.state} tone={fairy.tone} source={source} paused={!focused} />
      </FloatingButton>
      {abnormal && presence.subtitle ? (
        <Text testID="home-presence" shrink={1} size="secondary" tone={leadSubtitleTone(presence)} numberOfLines={2}>{presence.subtitle}</Text>
      ) : modelText && onOpenModel ? (
        <Pressable testID="home-model" aria-label={m.changeModelFrom(modelText)} feedback="highlight" onPress={onOpenModel} shrink={1} minW={0} rounded="full" px="pill-x" py="row-y">
          <Row items="center" gap="icon-label" minW={0}>
            <Text size="secondary" tone="secondary" numberOfLines={1} shrink={1} minW={0}>{modelText}</Text>
            <Icon name="chevron-down" size={12} color="text-secondary" />
          </Row>
        </Pressable>
      ) : null}
      <Spacer />
      <WaitingButton />
    </Row>
  );
}

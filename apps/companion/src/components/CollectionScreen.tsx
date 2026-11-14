import { Column, Density, Icon, Pressable, Row, ScrollArea, Screen, Text } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';
import type { PropsWithChildren } from 'react';

import { useMessages } from '@/i18n';
import { navigationMessages } from '@/navigation/navigation.messages';

// 工单、项目、日程的页面骨架：标题栏加一个滚动的内容区。扫读的列表，用紧凑密度（2026-10-22）。
// 原生上它们从首页的抽屉用栈打开（主题 11.20 H-1），标题上面一行「‹ 对话」回到会话。
export function CollectionScreen({ title, subtitle, children }: PropsWithChildren<{ title: string; subtitle: string }>) {
  const router = useRouter();
  const nav = useMessages(navigationMessages);
  return (
    <Density zone="workspace"><Screen edges={['top']}>
      <Column gap="text-stack" px="page-x" pt="page-top" pb="page-section" borderBottomWidth={1} borderBottomColor="border-soft" bg="surface">
        {router.canGoBack() ? (
          <Pressable testID="collection-back" aria-label={nav.conversation} onPress={() => router.back()} self="flex-start" rounded="sm" py="pill-y">
            <Row items="center" gap="text-stack">
              <Icon name="chevron-left" size={16} color="accent" />
              <Text size="body" weight="semibold" tone="accent">{nav.conversation}</Text>
            </Row>
          </Pressable>
        ) : null}
        <Text size="page-title" weight="extrabold" letterSpacing={-0.4}>{title}</Text>
        <Text size="secondary" tone="muted">{subtitle}</Text>
      </Column>
      <ScrollArea>
        <Column px="page-x" pt="page-top" pb="page-bottom">{children}</Column>
      </ScrollArea>
    </Screen></Density>
  );
}

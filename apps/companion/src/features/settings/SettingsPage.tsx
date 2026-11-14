import { Column, Text, useBreakpoint } from '@pi-lead-child/components';

import { SecondaryScreen } from '@/components/SecondaryScreen';
import { useRouter, type Href } from 'expo-router';
import type { ReactNode } from 'react';

import { useMessages } from '@/i18n';

import { settingsMessages } from './settings.messages';

type SettingsPageProps = {
  // 不给时不画标题：内容自己有标题（例如手机上一个连接的详情）。
  title?: string;
  // 标题下面的一句说明。
  description?: string;
  // 手机上左上角的返回：回到哪一页、按钮上写什么。缺省回到设置首页。
  back?: { label: string; href: string } | undefined;
  children?: ReactNode;
};

// 设置里一个分组的页面。
// 桌面上侧栏和滚动区由 SettingsDesktopShell 提供，这里只画标题和内容。
// 手机上是二级页面：左上角返回、标题居中（SecondaryScreen）。
export function SettingsPage({ title, description, back: backTo, children }: SettingsPageProps) {
  const { desktop } = useBreakpoint();
  const m = useMessages(settingsMessages);
  const back = backTo ?? { label: m.title, href: '/settings' };
  const router = useRouter();
  const heading = title === undefined ? null : (
    <Column gap="group-label" mb="page-section">
      <Text testID="settings-page-title" size="page-title" weight="extrabold" letterSpacing={-0.4}>{title}</Text>
      {description ? <Text size="secondary" tone="secondary" maxW={520}>{description}</Text> : null}
    </Column>
  );

  if (desktop) {
    return <Column testID="settings-page">{heading}{children}</Column>;
  }

  // 手机：二级页面的骨架（主题 11.20 H-10，2026-11-14 方案 F）：左上角返回、标题居中、浅底、悬浮的卡片。
  // 栈里有那一页时退回去；没有时（从别处直接打开这一页）换成那一页，不会退出设置。
  return (
    <SecondaryScreen testID="settings-page" zone="settings" title={title ?? back.label} onBack={() => router.dismissTo(back.href as Href)}>
      {description ? <Text size="secondary" tone="secondary" px="section-label-x">{description}</Text> : null}
      <Column gap="page-section">{children}</Column>
    </SecondaryScreen>
  );
}

import { CardDefaults, Column, Density, KeyboardArea, PageTopBar, Screen, ScrollArea } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';

import { WaitingButton } from '@/features/home/WaitingButton';
import { PageComposer } from '@/features/home/PageComposer';
import { useMessages } from '@/i18n';

import { secondaryScreenMessages } from './secondaryScreen.messages';

// 二级页面的骨架（主题 11.20 H-10、H-11，2026-11-14 方案 F）：设置、工单、日程、项目都用它。
// 浅底；顶栏左上角返回、标题居中、右上角是「等你」；下面是滚动的内容；页面要时，底部是一行发给 Lead 的输入框。
// 里面的卡片缺省是悬浮的（主题 A-1，CardDefaults）。
// 返回：有上一页就回上一页；直接打开的（例如深链接）回到对话。
export function SecondaryScreen({ title, composerPlaceholder, footer, children, testID, zone = 'workspace', onBack }: {
  title: string;
  /** 密度区域：设置页用 settings，列表页用 workspace。 */
  zone?: 'workspace' | 'settings';
  /** 返回去哪里。不给时回上一页，没有上一页时回到对话。 */
  onBack?: () => void;
  /** 底部输入框的提示语。不给时没有输入框（例如有悬浮按钮的设置子页）。 */
  composerPlaceholder?: string;
  /** 不跟内容滚动、贴在底部的东西，例如设置子页的「保存」。 */
  footer?: ReactNode;
  children: ReactNode;
  testID?: string;
}) {
  const router = useRouter();
  const m = useMessages(secondaryScreenMessages);
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  return (
    <Density zone={zone}><CardDefaults variant="float"><Screen edges={['top', 'bottom']} bg="page">
      <KeyboardArea bg="page">
        <PageTopBar testID={testID ? `${testID}-top-bar` : 'page-top-bar'} title={title} onBack={back} backLabel={m.back} trailing={<WaitingButton />} />
        <ScrollArea testID={testID}>
          <Column px="page-x" pt="float-row-y" pb="page-bottom" gap="page-section">{children}</Column>
        </ScrollArea>
        {footer ?? null}
        {composerPlaceholder ? <PageComposer placeholder={composerPlaceholder} /> : null}
      </KeyboardArea>
    </Screen></CardDefaults></Density>
  );
}

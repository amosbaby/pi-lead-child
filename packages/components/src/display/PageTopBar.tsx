import type { ReactNode } from 'react';

import { FloatingButton } from '../controls/FloatingButton';
import { Box, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { Icon } from './Icon';

export type PageTopBarProps = {
  /** 页面标题。绝对居中，单行，不能点。 */
  title: string;
  /** 左上角的返回。 */
  onBack: () => void;
  /** 返回按钮给读屏的说法，例如「返回对话」。 */
  backLabel: string;
  /** 右上角的内容，例如「等你」的那一叠。没有时右边空着。 */
  trailing?: ReactNode;
  testID?: string;
};

// 二级页面的顶栏（主题 11.20 H-10，2026-11-14 方案 F）：设置、工单、日程、项目都用它。
// 左上角是 48 的悬浮返回圆钮，中间是绝对居中的标题（不受左右宽度影响），右上角放调用方给的内容。
// 没有分隔线，没有底色：页面的浅底从顶栏下面一直铺下来。只有对话页的左上角是 Lead 的形象（HomeTopBar）。
export function PageTopBar({ title, onBack, backLabel, trailing, testID }: PageTopBarProps) {
  return (
    <Row testID={testID} items="center" px="page-x" py="float-row-y" position="relative">
      <FloatingButton testID={testID ? `${testID}-back` : undefined} label={backLabel} onPress={onBack}>
        <Icon name="chevron-left" size={20} color="text" weight="semibold" />
      </FloatingButton>
      {/* 标题绝对居中：左右各让出一颗圆钮的宽度，长标题截断，不压到圆钮上。 */}
      <Box position="absolute" l={0} r={0} t={0} b={0} items="center" justify="center" px="page-title-gutter" pointerEvents="none">
        <Text size="nav-label" weight="semibold" numberOfLines={1} role="heading">{title}</Text>
      </Box>
      <Box flex={1} />
      {trailing ?? null}
    </Row>
  );
}

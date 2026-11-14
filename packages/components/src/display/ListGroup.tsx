import { Children, Fragment, isValidElement, type ReactNode } from 'react';

import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { Card } from './Card';

export type ListGroupProps = {
  /** 小标题。没有时只有卡片。 */
  title?: string;
  /** 小标题后面的数量（等宽）。 */
  count?: number;
  /** warning：小标题用 warning-dark，例如「等你」那一组。 */
  tone?: 'default' | 'warning';
  /** 一行一个子元素。行和行之间由组件画细线。 */
  children: ReactNode;
  testID?: string;
};

// 列表页的一组（主题 11.20 H-11，2026-11-14 方案 F）：一个小标题加一张白色悬浮卡，卡里的行之间是 border-soft 的细线，
// 细线左右各缩进一个 row-x。工单、日程、设置首页都用它。行自己定高度和内边距。
export function ListGroup({ title, count, tone = 'default', children, testID }: ListGroupProps) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <Column testID={testID} gap="group-label">
      {title ? (
        <Row items="center" gap="icon-label" px="section-label-x">
          <Text size="label" weight="semibold" tone={tone === 'warning' ? 'warning-dark' : 'strong'}>{title}</Text>
          {count !== undefined ? <Text size="meta" mono tone="secondary">{String(count)}</Text> : null}
        </Row>
      ) : null}
      <Card variant="float" overflow="hidden">
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 ? <Box h={1} mx="row-x" bg="border-soft" /> : null}
            {row}
          </Fragment>
        ))}
      </Card>
    </Column>
  );
}

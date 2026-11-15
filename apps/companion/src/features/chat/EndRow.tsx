import { Box, Icon, Pressable, Row, Text, type ColorToken, type IconName } from '@pi-lead-child/components';

// 会话里结束了的事一行（patterns P4.4，主题 11.5 结束行）：用会话里一行的格子（主题 11.10「一行的对齐」）——
// 左边 18 宽的图标列，后面对象（600）、一句结果（截断）、时间，最右边箭头；行本身不另加左右留白。
// 结束了的提醒、还没取到是什么的事项都画成这一行。
export function EndRow({ icon, iconColor = 'text-muted', title, line = null, meta = null, onPress, label, testID, struck = false }: {
  icon: IconName;
  iconColor?: ColorToken;
  title: string;
  line?: string | null;
  meta?: string | null;
  onPress?: () => void;
  label: string;
  testID?: string;
  struck?: boolean;
}) {
  return (
    <Pressable testID={testID} aria-label={label} onPress={onPress} disabled={!onPress} feedback="opacity" w="100%">
      <Row items="center" gap="icon-label" py="card-row" minW={0}>
        <Box w={18} shrink={0} items="center">
          <Icon name={icon} size={13} color={iconColor} />
        </Box>
        <Text size="label" weight="bold" tone={struck ? 'muted' : 'default'} shrink={1} minW={0} numberOfLines={1}
          {...(struck ? { textDecorationLine: 'line-through' as const } : {})}>
          {title}
        </Text>
        <Box flex={1} minW={0}>
          {line ? <Text size="secondary" tone="strong" numberOfLines={1}>{line}</Text> : null}
        </Box>
        {meta ? <Text size="meta" tone="secondary" shrink={0}>{meta}</Text> : null}
        {onPress ? <Icon name="chevron-right" size={12} color="text-muted" /> : null}
      </Row>
    </Pressable>
  );
}

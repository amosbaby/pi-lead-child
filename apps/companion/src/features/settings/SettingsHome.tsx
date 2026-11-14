import { Box, Column, Icon, ListGroup, Pressable, Row, Text } from '@pi-lead-child/components';
import { useRouter, type Href } from 'expo-router';
import type { ConnectionDto, MemorySettingsDto } from '@pi-lead-child/protocol';

import { SecondaryScreen } from '@/components/SecondaryScreen';
import type { LeadPresence } from '@/components/leadPresence';
import { useMessages } from '@/i18n';
import { useConnectionPhase, useLeadName } from '@/state/hooks';

import { PendingSwitchBanner } from './MemorySection';
import { settingsMessages } from './settings.messages';
import { isDevicePaired, SETTINGS_GROUPS, settingsGroupLabel, type SettingsBadges, type SettingsSectionId } from './settingsNav';

// 手机上的设置首页（主题 11.20，画板 FSettings，2026-11-14 方案 F）：左上角返回、标题居中；
// 四组，组名和条目用现有的文案（Lead 那一组的组名是 Lead 的名字）。一行高 48：条目名，右边是当前值的摘要和箭头。
// 只有要你处理的条目在最左边带琥珀点（例如连接有一个要重新授权），旁边的摘要写有几个，不只靠颜色（P13.3）。
// 摘要只写现在拿得到的值，没有的不写。底部是发给 Lead 的输入框。
export function SettingsHome({ badges = {}, connections, memory }: {
  badges?: SettingsBadges;
  connections?: readonly ConnectionDto[] | null;
  memory?: MemorySettingsDto | null;
}) {
  const router = useRouter();
  const leadName = useLeadName();
  const phase = useConnectionPhase();
  const m = useMessages(settingsMessages);
  // 还没配对时，「本设备」一行打开配对页（以前设置首页最上面的 Lead 卡片也是这样）。
  const hrefFor = (id: SettingsSectionId, href: string) => (id === 'device' && !isDevicePaired(phase) ? '/pair' : href);
  const connected = connections?.filter((item) => item.state === 'connected').length ?? null;
  const summary = (id: SettingsSectionId): string | null => {
    const count = badges[id];
    if (count) return m.needsYou(count);
    if (id === 'profile') return leadName;
    if (id === 'connections' && connected !== null) return m.connectedCount(connected);
    return null;
  };

  return (
    <SecondaryScreen testID="settings-home" zone="settings" title={m.title} composerPlaceholder={m.composer(leadName)}
      onBack={() => router.dismissTo('/' as Href)}>
      {/* 要你处理的连接只在「连接」那一行带琥珀点和件数（画板 FSettings），不再在最上面放健康条。
          记忆有要你确认的切换时，最上面照旧先说：那是一个要你按的确认。 */}
      {memory ? <PendingSwitchBanner memory={memory} /> : null}
      {SETTINGS_GROUPS.map((group) => (
        <ListGroup key={group.id} testID={`settings-group-${group.id}`} title={settingsGroupLabel(group, leadName, m)}>
          {group.items.map((item) => {
            const attention = (badges[item.id] ?? 0) > 0;
            const value = summary(item.id);
            return (
              <Pressable key={item.id} testID={`settings-row-${item.id}`} feedback="highlight" onPress={() => router.push(hrefFor(item.id, item.href) as Href)} px="row-x" py="row-y">
                <Row items="center" gap="inline-item" minH={32} // 组件规格：一行高 48（32 加上下各 8）
                >
                  {attention ? <Box testID={`settings-row-${item.id}-badge`} w={7} h={7} rounded="full" bg="warning" /> : null}
                  <Text size="card-title" weight="semibold" numberOfLines={1}>{m.items[item.id]}</Text>
                  <Column flex={1} minW={0} items="flex-end">
                    {value ? <Text size="body" tone={attention ? 'warning-dark' : 'secondary'} numberOfLines={1}>{value}</Text> : null}
                  </Column>
                  <Icon name="chevron-right" size={16} color="text-secondary" />
                </Row>
              </Pressable>
            );
          })}
        </ListGroup>
      ))}
    </SecondaryScreen>
  );
}

// 名字下面的一行字：在线时写「在线」和最近一次巡检，别的状态和会话顶栏写的一样。设置的「身份与风格」页还在用。
export function paimonCardSubtitle(presence: LeadPresence, m: { online: string; onlineWith: (detail: string) => string }): string {
  if (presence.state === 'online') return presence.subtitle ? m.onlineWith(presence.subtitle) : m.online;
  return presence.subtitle ?? presence.label;
}

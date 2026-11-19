import { settingsMessages } from '@/features/settings/settings.messages';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { ShadowSection } from '@/features/settings/ShadowSection';
import { useMessages } from '@/i18n';

// 设置 → Shadow（2026-11-19）：Lead 的分身 shadow 的开关、交给它的比例、模型和合批等待。
export default function ShadowRoute() {
  const m = useMessages(settingsMessages);
  return (
    <SettingsPage title={m.items.shadow}>
      <ShadowSection />
    </SettingsPage>
  );
}

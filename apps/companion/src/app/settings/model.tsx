import { Button } from '@pi-lead-child/components';
import { useCallback, useState } from 'react';

import { AddModelPanel } from '@/features/settings/AddModelPanel';
import { modelDescription } from '@/features/settings/memoryModel';
import { modelMessages } from '@/features/settings/model.messages';
import { ModelSection } from '@/features/settings/ModelSection';
import { settingsMessages } from '@/features/settings/settings.messages';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLocale, useMessages } from '@/i18n';
import { useLeadName, useModelSettings } from '@/state/hooks';

// 设置 → 模型。页面头上是「添加模型」（方案 C，2026-11-16）：桌面上从右边的抽屉打开，手机上是悬浮底部面板。
export default function ModelRoute() {
  const m = useMessages(settingsMessages);
  const leadName = useLeadName();
  const locale = useLocale();
  const { modelSettings } = useModelSettings();
  const [adding, setAdding] = useState(false);
  const close = useCallback(() => setAdding(false), []);
  return (
    <SettingsPage
      title={m.items.model}
      description={modelDescription(leadName, locale)}
      action={(
        <Button testID="model-add-open" label={modelMessages(locale).addModel} icon="plus" variant="outline" tone="neutral" size="sm"
          disabled={!modelSettings} onPress={() => setAdding(true)} />
      )}
    >
      <ModelSection />
      <AddModelPanel open={adding} onClose={close} />
    </SettingsPage>
  );
}

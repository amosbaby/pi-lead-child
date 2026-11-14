import { Host, Switch as ExpoSwitch } from '@expo/ui';

import { palette } from '../theme/tokens';
import type { SwitchProps } from './Switch.types';

export type { SwitchProps } from './Switch.types';

// iOS 实现：SwiftUI Toggle（Expo UI）。Android 见 Switch.android.tsx：标签不能交给 Expo UI。
export function Switch({ value, onValueChange, label, disabled = false, testID }: SwitchProps) {
  return (
    <Host matchContents seedColor={palette.accent}>
      <ExpoSwitch value={value} onValueChange={onValueChange} label={label} disabled={disabled} testID={testID} />
    </Host>
  );
}

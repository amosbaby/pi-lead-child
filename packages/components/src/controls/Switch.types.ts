// 开关。web 上由 Tamagui 渲染；iOS 和 Android 上是 SwiftUI Toggle / Compose Switch（Expo UI）。Android 的标签由 Text 画。
export type SwitchProps = {
  value: boolean;
  onValueChange: (value: boolean) => void;
  label?: string;
  disabled?: boolean;
  testID?: string;
};

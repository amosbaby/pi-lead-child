import { palette } from '@pi-lead-child/components';
import { Stack } from 'expo-router';

import { FirstRunGate } from '@/features/onboarding/FirstRunGate';

// 原生上没有底部标签栏（主题 11.20 H-1，2026-11-14 方案 F）：首页是会话，工单、项目、日程从抽屉进，
// 用栈打开，iOS 右滑、Android 返回键回到会话。
export default function RootTabs() {
  return (
    <FirstRunGate>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.page } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="tickets" />
        <Stack.Screen name="projects" />
        <Stack.Screen name="agenda" />
      </Stack>
    </FirstRunGate>
  );
}

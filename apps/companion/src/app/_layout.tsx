import { ActivityBoundary, palette, UIProvider, useUIFonts } from '@pi-lead-child/components';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { DesignPreferencesBridge } from '@/components/DesignPreferencesBridge';
import { ChannelCardSlot } from '@/features/chat/ChannelMessageCard';
import { ObjectLinkProvider } from '@/features/chat/ObjectLinkProvider';
import { CompanionStateProvider } from '@/state/CompanionStateProvider';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useUIFonts();

  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [error, loaded]);

  if (!loaded && !error) return null;

  return (
    <UIProvider>
      <CompanionStateProvider>
        <DesignPreferencesBridge>
        <StatusBar style="dark" />
        {/* 原生上收集触摸，用来判断最近有没有人在看；web 上不加元素。 */}
        <ActivityBoundary>
          {/* 文字里外来消息卡的链接（P14.7）在这里的浮层里打开那张卡。 */}
          <ObjectLinkProvider renderCard={(cardId) => <ChannelCardSlot cardId={cardId} />}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.workspace } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="ticket/[id]" />
            {/* 视图面板（2026-10-30）：原生上是自己的一页，网页上在工作台的右侧（Workbench.web.tsx）。 */}
            <Stack.Screen name="views" />
            <Stack.Screen name="pair" options={{ presentation: 'modal' }} />
            {/* 设置：桌面上整页替换工作台，手机上是自己的栈（app/settings/_layout.tsx）。 */}
            <Stack.Screen name="settings" />
          </Stack>
          </ObjectLinkProvider>
        </ActivityBoundary>
        </DesignPreferencesBridge>
      </CompanionStateProvider>
    </UIProvider>
  );
}

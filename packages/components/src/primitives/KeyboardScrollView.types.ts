import type { Ref } from 'react';
import type { ScrollView, ScrollViewProps } from 'react-native';

// ScrollArea 里用的滚动视图：props 和 React Native 的 ScrollView 一样。
export type KeyboardScrollViewProps = ScrollViewProps & { ref?: Ref<ScrollView> };

import { TamaguiList, TamaguiListItem } from './ListItem.tamagui';
import type { ListItemProps, ListProps } from './ListItem.types';

export type { ListItemProps, ListProps } from './ListItem.types';

// Android 实现：Tamagui 渲染，见 ListItem.tamagui.tsx。iOS 见 ListItem.native.tsx。
export function List(props: ListProps) {
  return <TamaguiList {...props} />;
}

export function ListItem(props: ListItemProps) {
  return <TamaguiListItem {...props} />;
}

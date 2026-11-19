import { Platform, TextInput } from 'react-native';

import { palette, textLeading, textSizes } from '../theme/tokens';

// 一段只读的字，用系统选区拖两端选出其中一段（手机上缩小引用的范围，主题 Q-5）。
// 用只读的 TextInput：它的 onSelectionChange 给得出选区，Text 给不出；键盘不弹，改字不生效。
export type RangeSelectTextProps = {
  text: string;
  start: number;
  end: number;
  onSelect: (start: number, end: number) => void;
  testID?: string;
};

export function RangeSelectText({ text, start, end, onSelect, testID }: RangeSelectTextProps) {
  return (
    <TextInput
      testID={testID}
      value={text}
      multiline
      showSoftInputOnFocus={false}
      editable={Platform.OS === 'web' ? false : undefined}
      onChangeText={() => {}}
      selection={{ start, end }}
      onSelectionChange={(event) => {
        const { start: from, end: to } = event.nativeEvent.selection;
        if (to > from) onSelect(from, to);
      }}
      style={{ fontSize: textSizes['message-body'], lineHeight: textLeading['message-body'], color: palette.text, padding: 0 }}
      selectionColor={palette.accent}
    />
  );
}

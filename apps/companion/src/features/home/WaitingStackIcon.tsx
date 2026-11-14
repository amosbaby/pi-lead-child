import { fontFaces, palette } from '@pi-lead-child/components';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';

// 「等你」圆钮里的图标（主题 H-2）：一叠三张卡片，最上面一张写件数。描边用 C-11 的三档琥珀，数字是等宽的 warning-dark。
// 图标是组件规格：28 的画布，卡片的位置和圆角按画板。
export function WaitingStackIcon({ count }: { count: number }) {
  return (
    <Svg width={28} height={28} viewBox="0 0 28 28" accessible={false}>
      <Rect x={7} y={3} width={14} height={10} rx={3.5} fill={palette.surface} stroke={palette['warning-line']} strokeWidth={1.5} />
      <Rect x={5} y={6} width={18} height={12} rx={4} fill={palette.surface} stroke={palette['warning-border']} strokeWidth={1.5} />
      <Rect x={3} y={9.5} width={22} height={15} rx={4.5} fill={palette.surface} stroke={palette.warning} strokeWidth={1.75} />
      <SvgText x={14} y={21} textAnchor="middle" fontFamily={fontFaces['mono-medium']} fontSize={11} fill={palette['warning-dark']}>
        {count > 99 ? '99' : String(count)}
      </SvgText>
    </Svg>
  );
}

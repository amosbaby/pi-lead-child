import { createContext } from 'react';

// 为 true 时，外层的 KeyboardArea 已经把内容顶到键盘上面，里面的滚动区不再给键盘留位置。
export const InsideKeyboardArea = createContext(false);

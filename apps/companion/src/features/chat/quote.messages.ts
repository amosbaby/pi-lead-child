// 引用回复的文字（设计规范 P17、主题 11.22）：气泡里的引用、选区上的「回复」、引用浮层、托盘、手机的「正在引用」。
import { defineMessages } from '@/i18n';

export const quoteMessages = defineMessages({
  en: {
    jumpToSource: (text: string) => `Go to the quoted text: ${text}`,
    reply: 'Reply',
  },
  zh: {
    jumpToSource: (text: string) => `跳到原文：${text}`,
    reply: '回复',
  },
});

// 发给 Lead 的文件（文件卡、加文件时的提示）。
import { defineMessages } from '@/i18n';

// 文件的类型写给人看：按扩展名和 MIME 类型认几种常见的，认不出时写扩展名。
function kindOf(name: string, mimeType: string, words: { text: string; pdf: string; archive: string; data: string; file: string }): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/u.exec(name)?.[1]?.toLowerCase() ?? '';
  if (mimeType === 'application/pdf' || ext === 'pdf') return words.pdf;
  if (['zip', 'gz', 'tgz', 'tar', '7z', 'rar'].includes(ext)) return words.archive;
  if (['json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'sql'].includes(ext)) return ext.toUpperCase();
  if (mimeType.startsWith('text/') || ['txt', 'log', 'md'].includes(ext)) return words.text;
  return ext ? ext.toUpperCase() : words.file;
}

export const fileMessages = defineMessages({
  en: {
    kind: (name: string, mimeType: string) => kindOf(name, mimeType, { text: 'Text', pdf: 'PDF', archive: 'Archive', data: 'Data', file: 'File' }),
    open: (name: string) => `Open ${name}`,
    remove: (name: string) => `Remove ${name}`,
    tooMany: (max: number) => `You can send at most ${max} files at a time.`,
    tooLarge: (name: string, max: string) => `${name} is larger than ${max}.`,
    unreadable: (name: string) => `Cannot read ${name}.`,
    openFailed: (name: string) => `Cannot open ${name}.`,
  },
  zh: {
    kind: (name, mimeType) => kindOf(name, mimeType, { text: '文本', pdf: 'PDF', archive: '压缩包', data: '数据', file: '文件' }),
    open: (name) => `打开 ${name}`,
    remove: (name) => `去掉 ${name}`,
    tooMany: (max) => `一次最多发 ${max} 个文件`,
    tooLarge: (name, max) => `${name} 超过 ${max}`,
    unreadable: (name) => `${name} 读不出来`,
    openFailed: (name) => `${name} 打不开`,
  },
});

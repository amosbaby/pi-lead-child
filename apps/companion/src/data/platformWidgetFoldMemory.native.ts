import { File, Paths } from 'expo-file-system';

import type { WidgetFoldStorage } from './platformWidgetFoldMemory';

// 视图面板里你折叠起来的控件（工单 #54）：存在应用文档目录的一个小文件里，不进后端。
const memoryFile = () => new File(Paths.document, 'folded-widgets.json');

export const platformWidgetFoldMemory: WidgetFoldStorage = {
  async load() {
    const file = memoryFile();
    return file.exists ? file.text() : null;
  },
  async save(value) {
    const file = memoryFile();
    if (!file.exists) file.create();
    file.write(value);
  },
};

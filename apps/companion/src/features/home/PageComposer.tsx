import { elevation, IconButton, Row, TextField } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useMessages } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { composerMessages } from '@/features/chat/composer.messages';

// 二级页面底部的一行输入框（主题 11.20 H-11，2026-11-14 方案 F）：高 60、圆角 30 的白色悬浮条，
// 左边加号，中间提示语（按页面变化），右边发送。发出以后回到对话，消息已经在会话里。
// 加号回到对话再用：附件和换模型都在对话页的加号面板里。
export function PageComposer({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const runtime = useCompanionRuntime();
  const m = useMessages(composerMessages);
  const [text, setText] = useState('');
  const ready = text.trim().length > 0;
  const toConversation = () => (router.canGoBack() ? router.dismissTo('/') : router.replace('/'));
  const send = () => {
    if (!ready) return;
    void runtime.sendChat(text.trim()).catch(() => {});
    setText('');
    toConversation();
  };
  return (
    <Row testID="page-composer" mx="dock-x" mt="float-row-y" mb="dock-bottom" items="center" gap="inline-item" p="float-composer" rounded="full" bg="surface" boxShadow={elevation.float}>
      <IconButton testID="page-composer-plus" icon="plus" label={m.plus} variant="soft" tone="neutral" size="xl" rounded="full" iconColor="text" onPress={toConversation} />
      <Row flex={1} minW={0}>
        {/* 单行：提示语长时截断，不折成两行（画板里这一条高 60）。回车发送。 */}
        <TextField value={text} onChangeText={setText} placeholder={placeholder} variant="plain" size="lg" fontSize="16" grow returnKeyType="send" onSubmit={send} testID="page-composer-input" />
      </Row>
      <IconButton
        testID="page-composer-send"
        icon="arrow-up"
        label={m.send}
        variant={ready ? 'solid' : 'soft'}
        tone={ready ? 'accent' : 'neutral'}
        size="xl"
        rounded="full"
        iconColor={ready ? 'surface' : 'text-secondary'}
        onPress={send}
      />
    </Row>
  );
}

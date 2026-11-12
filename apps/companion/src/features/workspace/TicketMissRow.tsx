import { Button, Column, Row, Text, TextField } from '@pi-lead-child/components';
import { TICKET_MISS_TEXT_MAX } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useMessages } from '@/i18n';

import { ticketMissMessages } from './ticketMiss.messages';

/**
 * 工单列表页上的「找不到」（计划 Task 14）：用户没在列表里找到要找的工单时，点一下，写一句原话，记一行。
 * 记的是操作 ticket_miss.record（和 plc miss、Lead 的 perform_action 同一个）；这些记录是 S1 成不成功的一个数。
 * 一行里原地换样子：收起时是一个小的次要按钮，点开是一行输入框加「发送」（主按钮）和「取消」，列表不被挤开（设计规范 P1）。
 * 进行中写「正在发送…」，同行按钮停用；失败时在下面写原因，输入框里的字还在（P5.4）。
 */
export function TicketMissRow({ onReport }: { onReport: (text: string) => Promise<unknown> }) {
  const m = useMessages(ticketMissMessages);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();

  const send = async (value: string) => {
    const body = value.trim();
    if (pending || body === '') return;
    setPending(true);
    setError(null);
    try {
      await onReport(body);
      setText('');
      setOpen(false);
      setSaved(true);
    } catch (cause) {
      setError(m.failed(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <Row testID="ticket-miss" items="center" gap="actions">
        <Button
          testID="ticket-miss-open"
          label={m.open}
          size="xs"
          variant="ghost"
          tone="neutral"
          onPress={() => { setSaved(false); setOpen(true); }}
        />
        {saved ? <Text testID="ticket-miss-saved" size="secondary" tone="muted">{m.saved}</Text> : null}
      </Row>
    );
  }
  return (
    <Column testID="ticket-miss" gap="text-stack">
      <Row items="center" gap="actions">
        <TextField
          testID="ticket-miss-input"
          value={text}
          onChangeText={setText}
          placeholder={m.placeholder}
          accessibilityLabel={m.label}
          variant="filled"
          size="sm"
          grow
          autoFocus
          maxLength={TICKET_MISS_TEXT_MAX}
          returnKeyType="send"
          disabled={pending}
          onSubmit={(value) => { void send(value); }}
        />
        <Button
          testID="ticket-miss-send"
          label={pending ? m.sending : m.send}
          size="xs"
          tone="accent"
          disabled={pending || trimmed === ''}
          onPress={() => { void send(text); }}
        />
        <Button
          testID="ticket-miss-cancel"
          label={m.cancel}
          size="xs"
          variant="ghost"
          tone="neutral"
          disabled={pending}
          onPress={() => { setOpen(false); setError(null); }}
        />
      </Row>
      {error ? <Text testID="ticket-miss-error" size="secondary" color="danger-dark">{error}</Text> : null}
    </Column>
  );
}

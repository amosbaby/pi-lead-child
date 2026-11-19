import type { ConversationTurn } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { createOptimisticUserMessage, optimisticUserMessageId, resolveOptimisticUserMessage } from './actions';
import { createControlPlaneStore } from './store';

// 2026-11-19：用户发给 Lead 的文件（protocol 的 chat-files.ts）。本机刚发的消息带着文件的部件（名字、类型、大小、本机的数据），
// 送达以后搬到 daemon 开的那一轮上；快照（include=files）补上 daemon 存下的 id。

const SESSION = 'session-1';
const AT = '2026-11-19T08:00:00.000Z';

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1', originBindingId: 7, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '看日志', assistantText: '看过了', error: null, createdAt: AT, updatedAt: AT, ...overrides,
  };
}

function userParts(store: ReturnType<typeof createControlPlaneStore>, messageId: string) {
  const state = store.getState();
  return (state.partIdsByMessage[messageId] ?? []).map((id) => state.messagePartsById[id]!);
}

describe('files on user messages', () => {
  it('shows a file part on the optimistic message, and keeps its local data when the message is delivered', () => {
    const store = createControlPlaneStore();
    const messageId = createOptimisticUserMessage(store, {
      sessionId: SESSION, commandId: 'cmd-1', message: '看日志', createdAt: AT,
      files: [{ name: '../logs/app.log', mimeType: 'Text/Plain', data: 'aGVsbG8=' }, { name: 'bundle.zip', data: '' }],
    });
    expect(messageId).toBe(optimisticUserMessageId('cmd-1'));
    expect(userParts(store, messageId).filter((part) => part.kind === 'file')).toEqual([
      { kind: 'file', id: `${messageId}:file:0`, name: 'app.log', mimeType: 'text/plain', size: 5, data: 'aGVsbG8=' },
      { kind: 'file', id: `${messageId}:file:1`, name: 'bundle.zip', mimeType: 'application/octet-stream', size: 0, data: '' },
    ]);

    store.getState().mergeConversation(SESSION, [turn()], { kind: 'merge' });
    resolveOptimisticUserMessage(store, { sessionId: SESSION, commandId: 'cmd-1', turnId: 'turn-1', optimisticMessageId: messageId });
    const targetId = `${SESSION}:turn-1:user`;
    expect(userParts(store, targetId).filter((part) => part.kind === 'file')).toEqual([
      { kind: 'file', id: `${targetId}:file:0`, name: 'app.log', mimeType: 'text/plain', size: 5, data: 'aGVsbG8=' },
      { kind: 'file', id: `${targetId}:file:1`, name: 'bundle.zip', mimeType: 'application/octet-stream', size: 0, data: '' },
    ]);
  });

  it('normalizes the files of a snapshot, keeps local data for the same file, and keeps them when the snapshot has none', () => {
    const store = createControlPlaneStore();
    const targetId = `${SESSION}:turn-1:user`;
    const withFiles = turn({ userText: '', files: [{ id: 'file_a', name: 'app.log', mimeType: 'text/plain', size: 5 }] });
    store.getState().mergeConversation(SESSION, [withFiles], { kind: 'window', complete: true });
    expect(store.getState().messageIdsBySession[SESSION]).toContain(targetId);
    expect(userParts(store, targetId).filter((part) => part.kind === 'file')).toEqual([
      { kind: 'file', id: `${targetId}:file:0`, name: 'app.log', mimeType: 'text/plain', size: 5, fileId: 'file_a' },
    ]);

    // 本机还留着这个文件的数据：下一份快照不丢掉它。
    const partId = `${targetId}:file:0`;
    store.setState({
      messagePartsById: { ...store.getState().messagePartsById, [partId]: { ...store.getState().messagePartsById[partId]!, data: 'aGVsbG8=' } as never },
    });
    store.getState().mergeConversation(SESSION, [withFiles], { kind: 'merge' });
    expect(store.getState().messagePartsById[partId]).toMatchObject({ fileId: 'file_a', data: 'aGVsbG8=' });

    // 退回了不带 files 的请求：已有的文件留着。
    store.getState().mergeConversation(SESSION, [turn({ userText: '' })], { kind: 'merge' });
    expect(store.getState().messagePartsById[partId]).toMatchObject({ kind: 'file', fileId: 'file_a' });
    expect(store.getState().partIdsByMessage[targetId]).toContain(partId);
  });
});

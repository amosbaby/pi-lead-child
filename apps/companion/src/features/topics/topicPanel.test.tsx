// @vitest-environment happy-dom
// The panel of a topic draws the main conversation's own input and messages (user, 2026-11-25: one implementation,
// not two). Here: the input of a topic has the controls of the main input (the attach button, the model name), the
// same dock around it, and a message sent from it carries the images and the files; your message in a topic shows
// its images and files as in the main conversation; a topic's fixed error has its own words and "Resend".
import {
  CHAT_FILES_CAPABILITY, CHAT_IMAGES_CAPABILITY, LEAD_TOPICS_CAPABILITY, TOPIC_TURN_ERRORS,
  type ConversationTurn, type LeadStatus, type Overview, type TopicDto,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { pickChatFiles } from '@/data/chatFilePicker';

import { renderUI } from '../../../test/render';
import { LeadConversation } from '../chat/LeadConversation';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { TopicPanel } from './TopicPanel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Picking and shrinking an image in the browser (canvas, createImageBitmap) is not in happy-dom: a stand-in gives one
// image for a file name, as in the main input's test (messageComposer.test.tsx).
vi.mock('@/data/chatImagePicker', async () => {
  const types = await vi.importActual<typeof import('@/data/chatImagePicker.types')>('@/data/chatImagePicker.types');
  return {
    ChatImageError: types.ChatImageError,
    canPickImages: true,
    canTakePhoto: true,
    pickImageFiles: vi.fn(async () => []),
    prepareChatImage: vi.fn(async (file: File) => types.composerImage(`key-${file.name}`, { mimeType: 'image/png', data: btoa(file.name) })),
  };
});
vi.mock('@/data/chatFilePicker', async () => {
  const actual = await vi.importActual<typeof import('@/data/chatFilePicker')>('@/data/chatFilePicker');
  return { ...actual, pickChatFiles: vi.fn(async () => []) };
});
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};
const overview: Overview = {
  model: 'acme/main-model', sessionId: 'lead-session', busy: false, runningTicketIds: [],
  counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
  aish: null, lead: online,
};

function topic(overrides: Partial<TopicDto> = {}): TopicDto {
  return {
    id: 5, title: '评审的轮次', state: 'open', openedBy: 'lead', originTurnId: null, originQuote: null, originRole: null,
    model: null, conclusion: null, concludedAt: null, turnCount: 2, lastTurnId: 'tturn_2', lastActivityAt: '2026-11-25T02:00:05.000Z',
    createdAt: '2026-11-25T02:00:00.000Z', updatedAt: '2026-11-25T02:00:05.000Z',
    ...overrides,
  };
}

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: 1, originKind: 'paired:companion:topic', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-11-25T02:00:00.000Z', updatedAt: '2026-11-25T02:00:01.000Z',
    ...overrides,
  };
}

function setup(turns: ConversationTurn[], options: { topic?: TopicDto; client?: Partial<CompanionRuntimeDependencies['client']> } = {}) {
  const shown = options.topic ?? topic();
  const runtime = createCompanionStateRuntime({
    client: (options.client ?? {}) as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview,
    capabilities: [CHAT_IMAGES_CAPABILITY, CHAT_FILES_CAPABILITY, LEAD_TOPICS_CAPABILITY],
    topics: [shown],
  });
  runtime.control.getState().replaceConversation('lead-session', []);
  runtime.control.getState().replaceConversation(`topic:${shown.id}`, turns);
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <LeadConversation />
      <TopicPanel topicId={shown.id} onClose={() => {}} />
    </CompanionRuntimeProvider>,
  );
  return runtime;
}

describe('the input of a topic', () => {
  it('is the input of the main conversation: the same dock, the attach button and the model name', () => {
    setup([turn('tturn_1', { originKind: 'system:topic-opening', assistantText: '开场。' })]);
    const main = screen.getByTestId('conversation-footer-column');
    const side = screen.getByTestId('topic-composer-column');
    for (const dock of [main, side]) {
      expect(within(dock).getByTestId('composer')).toBeTruthy();
      expect(within(dock).getByTestId('composer-attach')).toBeTruthy();
      expect(within(dock).getByTestId('composer-input')).toBeTruthy();
      expect(within(dock).getByTestId('send-message')).toBeTruthy();
      // A topic without a model of its own shows the model of the main conversation.
      expect(within(dock).getByText(/main-model/)).toBeTruthy();
    }
    // The two docks are drawn by one component: the wrappers around the two inputs have the same styles.
    expect(side.parentElement!.className).toBe(main.parentElement!.className);
    expect(side.className).toBe(main.className);
    expect(within(side).getByTestId('composer').className).toBe(within(main).getByTestId('composer').className);
  });

  it('sends the file that you picked with its attach button to the topic, also with no text', async () => {
    const sendTopicMessage = vi.fn(async () => ({ topicId: 5, turnId: 'tturn_3', state: 'streaming' as const }));
    const sendChat = vi.fn(async () => ({}));
    setup([turn('tturn_1', { originKind: 'system:topic-opening', assistantText: '开场。' })], { client: { sendTopicMessage, sendChat } as never });
    const side = within(screen.getByTestId('topic-composer-column'));
    // The daemon accepts files: "+" picks any file (a picture still goes as an image).
    const notes = new File(['notes'], 'notes.txt', { type: 'text/plain' });
    vi.mocked(pickChatFiles).mockResolvedValue([{ name: 'notes.txt', mimeType: 'text/plain', size: notes.size, blob: notes }]);
    await act(async () => { fireEvent.click(side.getByTestId('composer-attach')); });
    await waitFor(() => expect(side.getByTestId('composer-file-0')).toBeTruthy());
    await act(async () => { fireEvent.click(side.getByTestId('send-message')); });
    await waitFor(() => expect(sendTopicMessage).toHaveBeenCalledWith(
      5, '', { images: [], files: [{ name: 'notes.txt', mimeType: 'text/plain', data: btoa('notes') }] },
    ));
    // Nothing went to the main conversation.
    expect(sendChat).not.toHaveBeenCalled();
    // The file shows on your message at once.
    await waitFor(() => expect(within(within(screen.getByTestId('topic-panel')).getByTestId('user-message-files')).getByText('notes.txt')).toBeTruthy());
  });

  it('shows one line and "Continue" in place of the input when the topic is closed', () => {
    setup([turn('tturn_1', { originKind: 'system:topic-opening', assistantText: '开场。' })], { topic: topic({ state: 'closed' }) });
    const side = screen.getByTestId('topic-composer-column');
    expect(within(side).queryByTestId('composer')).toBeNull();
    expect(within(side).getByTestId('topic-reopen')).toBeTruthy();
  });
});

describe('a message of a topic', () => {
  it('shows your images and files as in the main conversation, and draws no message for the opening turn\'s empty user side', () => {
    setup([
      turn('tturn_1', { originKind: 'system:topic-opening', assistantText: '开场。' }),
      turn('tturn_2', {
        userText: '看这张图', assistantText: '看到了。',
        images: [{ id: 'img_1', mimeType: 'image/png' }],
        files: [{ id: 'file_1', name: 'notes.txt', mimeType: 'text/plain', size: 12 }],
      }),
    ]);
    const panel = within(screen.getByTestId('topic-panel'));
    expect(panel.getAllByTestId('user-message')).toHaveLength(1);
    expect(panel.getByTestId('user-message-images')).toBeTruthy();
    expect(within(panel.getByTestId('user-message-files')).getByText('notes.txt')).toBeTruthy();
    expect(panel.getByText('看这张图')).toBeTruthy();
    expect(panel.getByText('开场。')).toBeTruthy();
    expect(panel.getByText('看到了。')).toBeTruthy();
  });

  it('writes a fixed error of the topic in the topic\'s words, and "Resend" sends the same words to the topic again', async () => {
    const sendTopicMessage = vi.fn(async () => ({ topicId: 5, turnId: 'tturn_3', state: 'streaming' as const }));
    setup([
      turn('tturn_2', { userText: '再想一想', state: 'failed', error: TOPIC_TURN_ERRORS.restarted }),
    ], { client: { sendTopicMessage } });
    const panel = within(screen.getByTestId('topic-panel'));
    expect(panel.getByText('This message got no answer.')).toBeTruthy();
    await act(async () => { fireEvent.click(panel.getByText('Resend')); });
    expect(sendTopicMessage).toHaveBeenCalledWith(5, '再想一想', { images: [], files: [] });
  });

  it('has no "Resend" on a failed message when the topic is closed', () => {
    setup([
      turn('tturn_2', { userText: '再想一想', state: 'failed', error: TOPIC_TURN_ERRORS.restarted }),
    ], { topic: topic({ state: 'closed' }) });
    const panel = within(screen.getByTestId('topic-panel'));
    expect(panel.getByText('This message got no answer.')).toBeTruthy();
    expect(panel.queryByText('Resend')).toBeNull();
  });
});

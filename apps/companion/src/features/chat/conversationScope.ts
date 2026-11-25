import type { ChatFileInput, ChatImageInput } from '@pi-lead-child/protocol';
import { createContext, useContext } from 'react';

// Which conversation with Lead a message belongs to. The main conversation and a topic (features/topics) draw their
// messages with the same component (LeadConversation's ConversationMessage); this says what differs in a topic.
// null: the main conversation.
export interface ConversationScope {
  // "Send again" on a message that got no answer: the words, the images and the files go to this conversation once
  // more. null: nothing can be sent now (a closed topic), so there is no "Send again".
  send: ((text: string, attachments: { images: ChatImageInput[]; files: ChatFileInput[] }) => Promise<unknown>) | null;
  // An error that this conversation writes as a fixed code (protocol's TOPIC_TURN_ERRORS): what the card says.
  // null: not one of them; the error gets the same wording as in the main conversation.
  fixedFailure: (code: string) => { headline: string; details: string } | null;
}

export const ConversationScopeContext = createContext<ConversationScope | null>(null);

export function useConversationScope(): ConversationScope | null {
  return useContext(ConversationScopeContext);
}

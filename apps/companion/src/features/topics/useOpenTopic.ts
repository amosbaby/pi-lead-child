import { isWeb } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { useWorkspaceStore } from '@/state/CompanionStateProvider';

// Open the panel of a topic (design rules P16, P18). On the web it takes the place on the right (a column on the
// desktop, a page that covers the conversation on a phone width). On the native apps it is its own page.
export function useOpenTopic(): (topicId: number) => void {
  const router = useRouter();
  const openTopic = useWorkspaceStore((state) => state.openTopic);
  return (topicId) => {
    if (!isWeb) {
      router.push({ pathname: '/topic/[id]', params: { id: String(topicId) } });
      return;
    }
    openTopic(topicId);
  };
}

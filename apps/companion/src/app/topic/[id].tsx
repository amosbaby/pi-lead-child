import { KeyboardArea, Screen } from '@pi-lead-child/components';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { TopicPanel } from '@/features/topics/TopicPanel';

// The panel of a topic on the native apps (design rules P16.3, P13.2d): its own page, with Back at the top left.
// On the web the panel is in the workbench (Workbench.web.tsx).
export default function TopicScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const topicId = Number(id);
  return (
    <Screen edges={['top', 'bottom']}>
      {/* The input is at the bottom: the page moves up with the keyboard, as the ticket page does. */}
      <KeyboardArea>
        {Number.isSafeInteger(topicId) && topicId > 0 ? <TopicPanel topicId={topicId} standalone onClose={() => router.back()} /> : null}
      </KeyboardArea>
    </Screen>
  );
}

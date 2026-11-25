import {
  Column, ConversationColumn, measureSheetCover, PopoverAnchorView,
  type PopoverAnchor, type PopoverAnchorHandle, type SheetCover,
} from '@pi-lead-child/components';
import { CHAT_FILES_CAPABILITY, CHAT_IMAGES_CAPABILITY } from '@pi-lead-child/protocol';
import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';

import { canPickFiles } from '@/data/chatFilePicker';
import { canPickImages, canTakePhoto } from '@/data/chatImagePicker';
import { useLocale, useMessages } from '@/i18n';
import { useControlPlaneStore } from '@/state/CompanionStateProvider';

import { LeadPlusSheet, type PlusTile } from '../home/LeadPlusSheet';
import { homeMessages } from '../home/home.messages';
import {
  LeadModelComposerTrigger, LeadModelPicker, leadModelTriggerText, useModelAccounts, type LeadModelPickerProps,
} from './LeadModelPicker';
import { MessageComposer, type MessageComposerHandle, type MessageComposerProps } from './MessageComposer';

// The input of a conversation with Lead, with everything around it (theme 11.13, 11.18, H-6, H-7): the same paddings
// and content column as the conversation above it, images and files, the model name that opens the model picker,
// /model, and on a phone the floating input with the plus sheet.
//
// One component for every conversation with Lead: the main conversation and the panel of a topic (features/topics)
// both draw it, so the two inputs have the same controls, the same height and the same bottom edge. A conversation
// gives what differs: where a message goes (onSend), the model it shows and what the picker changes (model, picker),
// and the parts only it has (composer: quotes, /compact, the queue tray, "only this message").
export type LeadComposerDockProps = {
  // Phone width: the floating input, the plus sheet, the model in the plus sheet.
  compact: boolean;
  testID?: string;
  contextKey: string;
  placeholder: string;
  disabled?: boolean;
  onSend: MessageComposerProps['onSend'];
  // The model this conversation uses now (provider/id with an optional effort suffix).
  model: string | null | undefined;
  // What the model picker changes. Not given: Lead's model. onTurnModel adds "only this message"; topic makes the
  // picker change that topic only (LeadModelPicker).
  picker?: Pick<LeadModelPickerProps, 'onTurnModel' | 'topic' | 'testID'>;
  // Lines above the input: the interrupt banner of the main conversation, the error line of a topic.
  above?: ReactNode;
  // Shown in place of the input (a closed topic: one line and "Continue").
  replacement?: ReactNode;
  // The parts that only some conversations have.
  composer?: Pick<
    MessageComposerProps,
    'quotes' | 'onSideTopic' | 'onCompactCommand' | 'chip' | 'tray' | 'placement' | 'placementStatus'
  >;
  // The page focuses the input through it (a quote gesture on a phone).
  composerRef?: RefObject<MessageComposerHandle | null>;
};

export function LeadComposerDock({
  compact, testID = 'conversation-footer-column', contextKey, placeholder, disabled, onSend, model, picker, above,
  replacement, composer, composerRef,
}: LeadComposerDockProps) {
  const locale = useLocale();
  const homeText = useMessages(homeMessages);
  // The daemon accepts images: the input has "+" and takes pasted images (protocol's chat-images.ts). It accepts
  // files (chat.files.v1): the plus sheet has "Files", and "+" on the desktop picks any file.
  const canSendImages = useControlPlaneStore((state) => state.capabilities.includes(CHAT_IMAGES_CAPABILITY));
  const canSendFiles = useControlPlaneStore((state) => state.capabilities.includes(CHAT_FILES_CAPABILITY));
  const modelAccounts = useModelAccounts();
  // The model picker: on the desktop it points at what opened it (the model name on the input, or the input when you
  // typed /model); on a phone it is a bottom sheet. One at a time (P2.8).
  const [pickerOpen, setPickerOpen] = useState<{ anchor: PopoverAnchor | null } | null>(null);
  const anchorRef = useRef<PopoverAnchorHandle>(null);
  const ownRef = useRef<MessageComposerHandle | null>(null);
  const inputRef = composerRef ?? ownRef;
  // The plus sheet covers the input (user, 2026-11-19): the keyboard goes down first, then the input is measured.
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusCover, setPlusCover] = useState<SheetCover | null>(null);
  const openPlus = useCallback(() => {
    measureSheetCover(anchorRef.current?.measure, (cover) => {
      setPlusCover(cover);
      setPlusOpen(true);
    });
  }, []);
  // The top row of the plus sheet (theme H-7): only what this device and the daemon can do now.
  const plusTiles = useMemo(() => {
    const tiles: PlusTile[] = [];
    if (canSendImages && canPickImages) {
      if (canTakePhoto) tiles.push({ id: 'camera', icon: 'camera', label: homeText.camera, onPress: () => inputRef.current?.pickImages('camera') });
      tiles.push({ id: 'photos', icon: 'image', label: homeText.photos, onPress: () => inputRef.current?.pickImages('library') });
    }
    if (canSendFiles && canPickFiles) tiles.push({ id: 'files', icon: 'file', label: homeText.files, onPress: () => inputRef.current?.pickFiles() });
    return tiles;
  }, [canSendFiles, canSendImages, homeText, inputRef]);

  return (
    <>
      {/* The input sits in the same content column as the conversation: the same paddings, at most 700 wide, centered,
          so its left and right edges line up with the messages above it. */}
      <Column
        shrink={0}
        px="page-x"
        {...(compact
          // On a phone the input card floats on the page (theme H-6): no divider, space on all sides.
          ? { px: 'dock-x', py: 'float-row-y' } as const
          // spacing-exempt: the dock's own spec, the space between the conversation and the bottom edge
          : { pt: 8, pb: 20 } as const)}
      >
        {/* spacing-exempt: the dock's own spec, the gap between the banner and the input */}
        <ConversationColumn testID={testID} gap={compact ? 0 : 11}>
          {above}
          {replacement ?? (
            // The input is measured here: the picker that /model opens points at it, and the plus sheet covers it.
            <PopoverAnchorView ref={anchorRef} layout="block">
              <MessageComposer
                compact={compact}
                contextKey={contextKey}
                placeholder={placeholder}
                onSend={onSend}
                {...(disabled ? { disabled: true } : {})}
                attachImages={canSendImages}
                attachFiles={canSendFiles}
                // /model opens the model picker; the text does not go to Lead.
                onModelCommand={() => anchorRef.current?.measure((anchor) => setPickerOpen({ anchor }))}
                {...composer}
                {...(compact
                  ? { float: true, onPlus: openPlus, ref: inputRef }
                  : {
                      ref: inputRef,
                      modelControl: <LeadModelComposerTrigger current={model} accounts={modelAccounts} onOpen={(anchor) => setPickerOpen({ anchor })} />,
                    })}
              />
            </PopoverAnchorView>
          )}
        </ConversationColumn>
      </Column>
      {compact ? (
        <LeadPlusSheet
          open={plusOpen}
          onClose={() => setPlusOpen(false)}
          tiles={plusTiles}
          cover={plusCover}
          // On a phone the model is changed from here (theme H-7, 11.18): the plus sheet goes down, the picker comes up.
          modelText={leadModelTriggerText(model, modelAccounts, locale)}
          onOpenModel={() => setPickerOpen({ anchor: null })}
        />
      ) : null}
      <LeadModelPicker
        open={pickerOpen !== null}
        anchor={pickerOpen?.anchor ?? null}
        onClose={() => setPickerOpen(null)}
        {...picker}
      />
    </>
  );
}

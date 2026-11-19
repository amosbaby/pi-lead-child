import { createPortal } from 'react-dom';

import { elevation, radius } from '../theme/tokens';
import type { ViewportOverlayProps } from './ViewportOverlay';

export type { ViewportOverlayProps } from './ViewportOverlay';

// 组件规格：盖在会话和输入框上面，低于模态框。
const Z_INDEX = 1000;

export function ViewportOverlay({
  top, left, centerX = false, width, raised = false, passThrough = false, keepSelection = false,
  role, label, testID, onKeyDownCapture, nodeRef, children,
}: ViewportOverlayProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={nodeRef}
      role={role}
      aria-label={label}
      data-testid={testID}
      onKeyDownCapture={onKeyDownCapture}
      onMouseDown={keepSelection ? (event) => event.preventDefault() : undefined}
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: Z_INDEX,
        ...(width !== undefined ? { width } : {}),
        ...(centerX ? { transform: 'translateX(-50%)' } : {}),
        ...(passThrough ? { pointerEvents: 'none' as const } : {}),
        ...(raised ? { boxShadow: elevation.raised, borderRadius: radius.xl } : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

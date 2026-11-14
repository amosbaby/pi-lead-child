import type { ReactNode } from 'react';

import type { ColorToken } from '../theme/tokens';

export type KeyboardAreaProps = {
  children?: ReactNode;
  bg?: ColorToken;
  testID?: string;
};

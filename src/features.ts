import type { SupportedFeatures } from './native';
import type { BarMode } from './urlbar';

export const features = {
  current: undefined as SupportedFeatures | undefined,
  searchEngine: 'https://duckduckgo.com/?q=',
  // Terminal-native row-0 URL/find bar (07-03).
  bar: {
    mode: 'normal' as BarMode,
    buffer: '',
    cursor: 0,
    url: '',
  },
};

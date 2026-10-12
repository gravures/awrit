import type { SupportedFeatures } from './native';
import type { BarLock, BarMode, BarTheme } from './urlbar';

export const features = {
  current: undefined as SupportedFeatures | undefined,
  searchEngine: 'https://duckduckgo.com/?q=',
  // Terminal-native row-0 URL/find bar (07-03), extended with a scheme lock
  // indicator, a live find counter and a theme preset (07-04).
  bar: {
    mode: 'normal' as BarMode,
    buffer: '',
    cursor: 0,
    url: '',
    lock: 'none' as BarLock,
    findCount: { index: 0, total: 0 },
    theme: 'reverse' as BarTheme,
  },
};

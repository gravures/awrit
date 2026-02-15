export const rawArgs = process.argv.slice(2);

export const possibleOptions = {
  url: { short: 'u', description: 'Set the initial URL', string: true, arg: true },

  help: { short: 'h', description: 'Show help' },
  version: { short: 'v', description: 'Show version' },
  dev: { short: 'd', description: 'Run in development mode' },
  'no-paint': { short: 'n', description: 'Disable painting' },
  transparent: { short: 't', description: 'Make the window transparent' },
  'debug-paint': { short: 'p', description: 'Debug paint' },
  'tmux-dump': { short: 'm', description: 'Dump tmux graphics and placeholder output to /tmp' },
  'tmux-renderer': {
    short: 'R',
    description: 'Select tmux renderer backend: native or timg',
    string: true,
  },
  rebuild: { short: 'r', description: 'Rebuild the toolbar' },
} as const;

export type Option = keyof typeof possibleOptions;
type ShortOption = (typeof possibleOptions)[Option]['short'];

const shortOptions = Object.fromEntries(
  Object.entries(possibleOptions).map(([key, value]) => [value.short, key]),
) as {
  [K in ShortOption]: Option;
};

export const options: {
  [K in Option]?: (typeof possibleOptions)[K] extends { string: true } ? string : boolean;
} = {};

const supportedSchemes = ['http', 'https', 'file', 'data'];

for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  if (arg.startsWith('-')) {
    const keyValue = arg.slice(arg.startsWith('--') ? 2 : 1);
    const equalsIndex = keyValue.indexOf('=');
    const rawKey = equalsIndex === -1 ? keyValue : keyValue.slice(0, equalsIndex);
    let value = equalsIndex === -1 ? undefined : keyValue.slice(equalsIndex + 1);

    if (!(rawKey in possibleOptions) && !(rawKey in shortOptions)) {
      continue;
    }

    const key = shortOptions[rawKey as ShortOption] ?? rawKey;
    if ('string' in possibleOptions[key]) {
      if (value == null) {
        const nextArg = rawArgs[index + 1];
        if (nextArg != null && !nextArg.startsWith('-')) {
          value = nextArg;
          index++;
        }
      }
      options[key] = value as any;
    } else {
      options[key] = true as any;
    }
  } else {
    options.url = arg;
  }

  if (
    typeof options.url === 'string' &&
    !supportedSchemes.some((scheme) => (options.url as string).startsWith(scheme))
  ) {
    options.url = `https://${options.url}`;
  }
}

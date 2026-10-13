// @ts-expect-error
export function abort(): never {
  // cheap trick to trigger the cleanup function from anywhere
  process.emit('SIGINT');
}

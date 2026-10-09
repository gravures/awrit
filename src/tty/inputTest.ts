import { listenForInput, type TermEvent } from '../native';
import * as out from './output';

let quitListening = () => {};

const cleanup = (signum = 1) => {
  quitListening();
  out.cleanup();
  process.exit(signum);
};

function main() {
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGABRT', cleanup);
  out.setup();
  process.stdout.write('Awrit Input Test\r\n');
  quitListening = listenForInput((evt: TermEvent) => {
    if (
      evt.eventType === 'key' &&
      evt.keyEvent?.code === 'c' &&
      evt.keyEvent?.modifiers.includes('ctrl')
    ) {
      quitListening();
      cleanup(0);
    }
    process.stdout.write(`${JSON.stringify(evt)}\r\n`);
  });
}

main();

import { randomBytes } from 'node:crypto';

const MAX_IMAGE_ID = 0xffffffff;

function randomImageId() {
  const id = randomBytes(4).readUInt32BE(0);
  return id === 0 ? 1 : id;
}

export function createImageIdAllocator(initialId = randomImageId()) {
  let nextId = initialId >>> 0;
  if (nextId === 0) nextId = 1;

  return () => {
    const id = nextId;
    nextId = nextId === MAX_IMAGE_ID ? 1 : nextId + 1;
    return id;
  };
}

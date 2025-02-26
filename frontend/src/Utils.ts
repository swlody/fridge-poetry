const BOX_SIZE = 30000;

export function makeNewHash() {
  const randomX = Math.round(Math.random() * BOX_SIZE - BOX_SIZE / 2);
  const randomY = Math.round(Math.random() * BOX_SIZE - BOX_SIZE / 2);
  globalThis.location.replace(`#x=${randomX}&y=${randomY}`);
}

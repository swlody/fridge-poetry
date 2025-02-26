export function makeNewHash() {
  const randomX = Math.round(Math.random() * 20000 - 10000);
  const randomY = Math.round(Math.random() * 20000 - 10000);
  globalThis.location.replace(`#x=${randomX}&y=${randomY}`);
}

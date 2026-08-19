export const START_ANIMATION_DURATION = 2000;
export const WS_URL =
  import.meta.env.VITE_WS_BASE_URL ||
  `${globalThis.location.protocol === "https:" ? "wss:" : "ws:"}//${globalThis.location.host}/ws`;

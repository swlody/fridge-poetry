import { Window } from "./Window.ts";
import { ReconnectingWebSocket } from "./ReconnectingWebSocket.ts";
import * as Config from "./Config.ts";
import * as Utils from "./Utils.ts";
import { App } from "./App.ts";

export let scale = 1.0;
export let viewWindow = new Window(0, 0, 0, 0);
export let centerX = 0;
export let centerY = 0;
// Elements that are currently in a transition animation
// because it was moved by someone else...
export const transitioning = new Map<number, HTMLElement>();
export let resizeTimer: number | null = null;
export let isInLoadingAnimation = false;
export const webSocket = new ReconnectingWebSocket(Config.WS_URL);

export function setScale(newScale: number) {
  scale = newScale;
}

export function setCenter(x: number, y: number) {
  centerX = x;
  centerY = y;
}

export function setIsInLoadingAnimation(thing: boolean) {
  isInLoadingAnimation = thing;
}

export function updateCoordinatesFromHash() {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
  }

  const params = new URLSearchParams(globalThis.location.hash.slice(1));

  centerX = parseInt(params.get("x") || "NaN");
  centerY = parseInt(params.get("y") || "NaN");
  if (isNaN(centerX) || isNaN(centerY)) {
    Utils.makeNewHash();
    return;
  }

  App.door.style.setProperty("--center-x", `${centerX}px`);
  App.door.style.setProperty("--center-y", `${centerY}px`);

  // request magnets within the bounds of our new window
  viewWindow = new Window(
    Math.round(centerX - (1.5 * globalThis.innerWidth) / scale - 15),
    Math.round(centerY - (1.5 * globalThis.innerHeight) / scale - 15),
    Math.round(centerX + (1.5 * globalThis.innerWidth) / scale + 15),
    Math.round(centerY + (1.5 * globalThis.innerHeight) / scale + 15),
  );

  webSocket.send(viewWindow.pack());
}

export function startResizeTimer() {
  if (resizeTimer !== null) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(function () {
    updateCoordinatesFromHash();
  }, 500);
}

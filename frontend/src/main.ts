import { pack, unpack } from "msgpackr";
import * as ease from "easing-utils";

import {
  clickedElement,
  hideRotationDot,
  isDraggingMagnet,
  Magnet,
} from "./magnet.ts";

import "./style.css";

const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

export let scale = 1.0;

// Window that represents the total area of magnets in the DOM
// This is a 3x3 grid of [viewport area] centered at the actual viewport
class Window {
  x1: number;
  y1: number;
  x2: number;
  y2: number;

  constructor(x1: number, y1: number, x2: number, y2: number) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
  }

  contains(x: number, y: number): boolean {
    return x >= this.x1 && x <= this.x2 && y >= this.y1 && y <= this.y2;
  }

  pack() {
    return pack([this.x1, this.y1, this.x2, this.y2]);
  }
}

// Elements that are currently in a transition animation
// because it was moved by someone else...
const transitioning = new Map<number, HTMLElement>();

function chooseRandomEdgeCoords() {
  let x = 0;
  let y = 0;
  const rand = Math.random();
  if (rand < 0.25) {
    x = viewWindow.x1;
    y =
      Math.floor(Math.random() * (viewWindow.y2 - viewWindow.y1 + 1)) +
      viewWindow.y2;
  } else if (rand < 0.5) {
    x = viewWindow.x2;
    y =
      Math.floor(Math.random() * (viewWindow.y2 - viewWindow.y1 + 1)) +
      viewWindow.y2;
  } else if (rand < 0.75) {
    y = viewWindow.y1;
    x =
      Math.floor(Math.random() * (viewWindow.x2 - viewWindow.x1 + 1)) +
      viewWindow.x2;
  } else {
    y = viewWindow.y2;
    x =
      Math.floor(Math.random() * (viewWindow.x2 - viewWindow.x1 + 1)) +
      viewWindow.x2;
  }

  return [x, y];
}

function transitionElement(
  element: HTMLElement,
  registerTimout: boolean,
  x: string,
  y: string,
  rotation: number | null = null,
  zIndex: number | null = null,
) {
  const id = parseInt(element.id);
  element.style.transition = "0.5s";
  element.style.setProperty("--x", x);
  element.style.setProperty("--y", y);

  if (rotation) {
    element.style.setProperty("--rotation", `${rotation}deg`);
  }
  if (zIndex) {
    element.style.zIndex = zIndex.toString();
  }

  if (registerTimout) {
    transitioning.set(id, element);
    setTimeout(() => {
      if (transitioning.has(id)) {
        element.style.transition = "";
        transitioning.delete(id);
      }
    }, 500);
  }
}

const door = document.getElementById("door")!;
let viewWindow: Window;

// Add new elements to DOM, remove old elements
function replaceMagnets(magnetArray: Magnet[]) {
  // Add new elements to document fragment to be added as a batch
  const newElements = new DocumentFragment();
  for (const magnet of magnetArray) {
    const element = document.getElementById(`${magnet.id}`);
    if (element) {
      element.style.setProperty("--x", `${magnet.x}px`);
      element.style.setProperty("--y", `${magnet.y}px`);
      element.style.setProperty("--rotation", `${magnet.rotation}deg`);
      element.style.zIndex = magnet.zIndex.toString();
    } else {
      newElements.append(magnet.toElement(webSocket));
    }
  }

  // remove all now-out-of-bounds magnets
  door.querySelectorAll(".magnet").forEach((element) => {
    const magnet = element as HTMLElement;
    if (
      !viewWindow.contains(
        parseInt(magnet.style.getPropertyValue("--x")),
        parseInt(magnet.style.getPropertyValue("--y")),
      )
    ) {
      door.removeChild(magnet);
    }
  });

  // add new magnets after removing old ones so we don't have to iterate over them
  door.append(newElements);
}

// TODO reconnect logic
// TODO kick people off after some idle time and reconnect on interaction
const webSocket = new WebSocket(WS_URL);

const loaderElement = document.getElementById("loader")!;
webSocket.onclose = () => {
  while (door.lastChild) {
    door.removeChild(door.lastChild);
  }
  door.innerHTML = `<div class="error">
    <div class="fake-magnet" style="--rotation: 2deg">Lost</div>
    <div class="fake-magnet" style="--rotation: 1deg">connection</div>
    <div class="fake-magnet" style="--rotation: 2deg">:(</div>
    <div class="fake-magnet" style="--rotation: -3deg">please</div>
    <div class="fake-magnet" style="--rotation: 2deg">refresh</div>
  </div>`;
};

webSocket.onerror = () => {
  webSocket.close();
};

// TODO consider race conditions between this and mouseup replaceMagnets
// We receive an update to a magnet within our window
webSocket.onmessage = async (e) => {
  // gross untyped nonsense, yuck yuck yuck
  const update = unpack(await e.data.arrayBuffer());

  // inferring the type of the update based on structure 🤢
  if (update[0] instanceof Array) {
    // Received list of new magnets to add to DOM
    const magnets = [];
    for (const val of update) {
      magnets.push(new Magnet(val[0], val[1], val[2], val[3], val[4], val[5]));
    }
    replaceMagnets(magnets);
  } else if (update[5] !== undefined) {
    // New object arriving from out of bounds, create it
    const [x, y] = chooseRandomEdgeCoords();

    const element = new Magnet(
      update[0],
      x,
      y,
      update[3],
      update[4],
      update[5],
    ).toElement(webSocket);

    requestAnimationFrame(() => {
      door.append(element);

      requestAnimationFrame(() => {
        transitionElement(element, true, update[1], update[2]);
      });
    });
  } else if (update[4] !== undefined) {
    // Received update for magnet within our window
    const element = document.getElementById(`${update[0]}`)!;

    const newX = `${update[1]}px`;
    const newY = `${update[2]}px`;
    const zIndex = update[4];

    if (
      element.style.getPropertyValue("--x") === newX &&
      element.style.getPropertyValue("--y") === newY
    ) {
      // don't transition if magnet hasn't moved
      // in most cases this should be because we initiated the update
      element.style.zIndex = zIndex.toString();
      return;
    }

    transitionElement(element, true, newX, newY, update[3], zIndex);
  } else if (update && update.length !== 0) {
    // Received indication that magnet was removed from our window
    const element = document.getElementById(`${update}`)!;

    const [x, y] = chooseRandomEdgeCoords();

    transitionElement(element, false, `${x}px`, `${y}px`);

    setTimeout(() => {
      door.removeChild(element);
    }, 500);
  }
};

const refreshButton = document.getElementById(
  "refresh-button",
)! as HTMLButtonElement;

// Don't rerun all this logic if we are reconnecting to lost websocket connection
let hasAlreadyOpened = false;
webSocket.onopen = () => {
  if (hasAlreadyOpened) {
    // Re-request the whole window in case stuff was lost while disconnected
    updateCoordinatesFromHash();
    return;
  }
  hasAlreadyOpened = true;

  let isDraggingWindow = false;

  // starting x, y of cursor relative to world origin
  let startingX = 0;
  let startingY = 0;

  // current coordinates of viewport center relative to world origin
  let centerX = 0;
  let centerY = 0;

  let originalCenterX = 0;
  let originalCenterY = 0;

  let resizeTimer: number | null = null;

  function makeNewHash() {
    const randomX = Math.round(Math.random() * 20000 - 10000);
    const randomY = Math.round(Math.random() * 20000 - 10000);
    globalThis.location.replace(`#x=${randomX}&y=${randomY}`);
  }

  function startResizeTimer() {
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }
    resizeTimer = setTimeout(function () {
      updateCoordinatesFromHash();
    }, 500);
  }

  function updateCoordinatesFromHash() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
    }

    const params = new URLSearchParams(globalThis.location.hash.slice(1));

    centerX = parseInt(params.get("x") || "NaN");
    centerY = parseInt(params.get("y") || "NaN");
    if (isNaN(centerX) || isNaN(centerY)) {
      makeNewHash();
      return;
    }

    door.style.setProperty("--center-x", `${centerX}px`);
    door.style.setProperty("--center-y", `${centerY}px`);

    // request magnets within the bounds of our new window
    viewWindow = new Window(
      Math.round(centerX - (1.5 * globalThis.innerWidth) / scale - 15),
      Math.round(centerY - (1.5 * globalThis.innerHeight) / scale - 15),
      Math.round(centerX + (1.5 * globalThis.innerWidth) / scale + 15),
      Math.round(centerY + (1.5 * globalThis.innerHeight) / scale + 15),
    );

    webSocket.send(viewWindow.pack());
  }

  globalThis.addEventListener("hashchange", updateCoordinatesFromHash);
  updateCoordinatesFromHash();

  document.body.removeChild(loaderElement);

  const evCache: PointerEvent[] = [];
  let prevDiff = -1;

  setupDocumentEventListeners();

  door.style.setProperty("--scale", "0.5");
  let startTime = 0;
  const animationDuration = 2000;
  let isInLoadingAnimation = false;
  function zoomAnimation(now: number) {
    if (startTime === 0) {
      isInLoadingAnimation = true;
      startTime = now;
    }

    const percentDone = (now - startTime) / animationDuration;
    if (percentDone >= 1) {
      door.style.setProperty("--scale", "1");
      isInLoadingAnimation = false;
    } else {
      door.style.setProperty(
        "--scale",
        `${0.5 + ease.easeOutCubic(percentDone) * 0.5}`,
      );
      requestAnimationFrame(zoomAnimation);
    }
  }

  requestAnimationFrame(zoomAnimation);

  function setupDocumentEventListeners() {
    refreshButton.addEventListener("click", () => {
      makeNewHash();
      updateCoordinatesFromHash();

      refreshButton.disabled = true;
      refreshButton.style.color = "darkgray";

      setTimeout(() => {
        refreshButton.style.color = "";
        refreshButton.disabled = false;
      }, 1000);
    });

    document.addEventListener(
      "pointerdown",
      (e) => {
        // ignore right clicks
        if (e.button !== 0) return;

        // store multiple finger presses for pinch/zoom
        evCache.push(e);
        if (evCache.length > 1) return;

        transitioning.forEach((element) => {
          element.style.transition = "";
        });
        transitioning.clear();

        const target = e.target as HTMLElement;

        // remove rotation dot if it's showing on any magnet
        if (clickedElement && !clickedElement.contains(target)) {
          hideRotationDot();
        }

        if (e.target !== door || isDraggingWindow) {
          return;
        }

        door.setPointerCapture(e.pointerId);
        isDraggingWindow = true;

        originalCenterX = centerX;
        originalCenterY = centerY;

        // starting coordinates of mouse relative to world origin
        startingX = centerX + (e.clientX - globalThis.innerWidth / 2) / scale;
        startingY = -centerY + (e.clientY - globalThis.innerHeight / 2) / scale;
      },
      { passive: true },
    );

    document.addEventListener(
      "pointermove",
      (e) => {
        if (isDraggingMagnet) return;

        const index = evCache.findIndex(
          (cachedEv) => cachedEv.pointerId == e.pointerId,
        );
        evCache[index] = e;

        if (evCache.length === 2 && !isInLoadingAnimation) {
          const xDiff = evCache[0].clientX - evCache[1].clientX;
          const yDiff = evCache[0].clientY - evCache[1].clientY;
          const curDiff = Math.sqrt(xDiff * xDiff + yDiff * yDiff);

          if (prevDiff > 0) {
            scale += (curDiff - prevDiff) / 500;
            scale = Math.min(Math.max(0.5, scale), 1.5);
            requestAnimationFrame(() => {
              startResizeTimer();
              door.style.setProperty("--scale", `${scale}`);
            });
          }

          prevDiff = curDiff;
        } else if (evCache.length === 1 && isDraggingWindow) {
          centerX = Math.floor(
            startingX - (e.clientX - globalThis.innerWidth / 2) / scale,
          );
          centerY = -Math.floor(
            startingY - (e.clientY - globalThis.innerHeight / 2) / scale,
          );

          requestAnimationFrame(() => {
            door.style.setProperty("--center-x", `${centerX}px`);
            door.style.setProperty("--center-y", `${centerY}px`);
          });
        }
      },
      { passive: true },
    );

    document.addEventListener(
      "pointerup",
      (e) => {
        const index = evCache.findIndex(
          (cachedEv) => cachedEv.pointerId === e.pointerId,
        );
        evCache.splice(index, 1);

        if (evCache.length < 2) {
          prevDiff = -1;
        }

        if (!isDraggingWindow) return;
        door.releasePointerCapture(e.pointerId);
        isDraggingWindow = false;

        const xDiff = Math.abs(centerX - originalCenterX);
        const yDiff = Math.abs(centerY - originalCenterY);

        if (xDiff >= 1.0 || yDiff >= 1.0) {
          globalThis.location.replace(
            `#x=${Math.round(centerX)}&y=${Math.round(centerY)}`,
          );
        }
      },
      { passive: true },
    );

    document.addEventListener(
      "dblclick",
      (e) => {
        e.preventDefault();
      },
      { passive: false },
    );

    globalThis.addEventListener("resize", () => {
      requestAnimationFrame(startResizeTimer);
    });

    document.addEventListener(
      "wheel",
      (e) => {
        if (isInLoadingAnimation) return;
        scale += e.deltaY * -0.001;
        scale = Math.min(Math.max(0.5, scale), 1.5);
        requestAnimationFrame(() => {
          door.style.setProperty("--scale", `${scale}`);

          startResizeTimer();
        });
      },
      { passive: true },
    );
  }
};

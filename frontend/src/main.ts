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

const loaderElement = document.getElementById("loader")!;

export class ReconnectingWebSocket {
  private url: string;
  private protocols: string | string[];
  private socket: WebSocket | null;
  private isConnected: boolean;
  private reconnectAttempts: number;
  private maxReconnectAttempts: number;
  private reconnectInterval: number;
  private maxReconnectInterval: number;

  public onopen: ((event: Event) => void) | null;
  public onclose: ((event: CloseEvent) => void) | null;
  public onreconnect: ((event: Event) => void) | null;
  public onmessage: ((event: MessageEvent) => void) | null;
  public onerror: ((event: Event) => void) | null;

  constructor(url: string, protocols: string | string[] = []) {
    this.url = url;
    this.protocols = protocols;
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 100;
    this.reconnectInterval = 1000; // Start with 1 second
    this.maxReconnectInterval = 30000; // Max 30 seconds

    // Initialize event handlers
    this.onopen = null;
    this.onclose = null;
    this.onreconnect = null;
    this.onmessage = null;
    this.onerror = null;

    // Initial connection
    this.connect();
  }

  private connect(): void {
    this.socket = new WebSocket(this.url, this.protocols);

    this.socket.onopen = (event: Event) => {
      this.reconnectAttempts = 0;
      this.reconnectInterval = 1000;

      if (!this.isConnected) {
        // First connection
        this.isConnected = true;
        if (this.onopen) this.onopen(event);
      } else {
        // Reconnection
        if (this.onreconnect) this.onreconnect(event);
      }
    };

    this.socket.onclose = (event: CloseEvent) => {
      if (this.onclose) this.onclose(event);

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        const timeout = this.reconnectInterval;
        this.reconnectInterval = Math.min(
          this.reconnectInterval * 1.5,
          this.maxReconnectInterval,
        );
        this.reconnectAttempts++;

        setTimeout(() => this.connect(), timeout);
      }
    };

    this.socket.onmessage = (event: MessageEvent) => {
      if (this.onmessage) this.onmessage(event);
    };

    this.socket.onerror = (event: Event) => {
      if (this.onerror) this.onerror(event);
    };
  }

  public send(
    data: string | ArrayBufferLike | Blob | ArrayBufferView,
  ): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(data);
      return true;
    }
    return false;
  }

  public close(code: number = 1000, reason: string = ""): void {
    if (this.socket) {
      this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect
      this.socket.close(code, reason);
    }
  }
}

const webSocket = new ReconnectingWebSocket(WS_URL);
webSocket.onopen = setupWebSocket;

async function handleWebsocketMessage(e: MessageEvent) {
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
}

const refreshButton = document.getElementById(
  "refresh-button",
)! as HTMLButtonElement;

const shareButton = document.getElementById(
  "share-button",
)! as HTMLButtonElement;

shareButton.onclick = async () => {
  console.log(navigator.share, " + ", navigator.canShare());
  if (
    navigator.share &&
    navigator.canShare({
      title: "Fridge Poem",
      text: "Collaborative fridge poetry",
      url: globalThis.location.href,
    })
  ) {
    await navigator.share({
      title: "Fridge Poem",
      text: "Collaborative fridge poetry",
      url: globalThis.location.href,
    });
  } else {
    await navigator.clipboard.writeText(globalThis.location.href);
    shareButton.innerText = "Copied!";
    setTimeout(() => {
      shareButton.innerText = "Share location";
    }, 2000);
  }
};

// Don't rerun all this logic if we are reconnecting to lost websocket connection
function setupWebSocket() {
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

  webSocket.onmessage = handleWebsocketMessage;
  webSocket.onclose = () => {
    while (door.lastElementChild) {
      door.removeChild(door.lastElementChild);
    }
    door.appendChild(loaderElement);
  };

  webSocket.onreconnect = () => {
    updateCoordinatesFromHash();
    door.removeChild(loaderElement);
  };

  // Re-request the whole window in case stuff was lost while disconnected
  updateCoordinatesFromHash();

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
}

import { pack, unpack } from "msgpackr";

import { clickedElement, hideRotationDot, Magnet } from "./magnet.ts";

import "./style.css";

const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

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

const door = document.getElementById("door")!;

const dialog = document.getElementById("about-dialog")! as HTMLElement;
document.getElementById("about-button")!.addEventListener(
  "pointerdown",
  (e) => {
    e.stopPropagation();
    dialog.hidden = !dialog.hidden;
    dialog.classList.toggle("children-hidden");
  },
  { passive: true },
);

let webSocket = new WebSocket(WS_URL);

webSocket.onerror = (err) => {
  console.error("Socket encountered error: ", err, "Closing socket");
  webSocket.close();
};

webSocket.onclose = () => {
  while (!webSocket.OPEN) {
    setTimeout(() => {
      webSocket = new WebSocket(WS_URL);
    }, 1000);
  }
};

// TODO consider race conditions between this and mouseup replaceMagnets
// We receive an update to a magnet within our window
webSocket.onmessage = async (e) => {
  // gross untyped nonsense, yuck yuck yuck
  const update = unpack(await e.data.arrayBuffer());

  // inferring the type of the update based on structure 🤢
  if (update[0] instanceof Array) {
    const magnets = [];
    for (const val of update) {
      magnets.push(new Magnet(val[0], val[1], val[2], val[3], val[4], val[5]));
    }
    replaceMagnets(magnets);
  } else if (update[5] !== undefined) {
    // New object arriving from out of bounds, create it
    door.append(
      new Magnet(
        update[0],
        update[1],
        update[2],
        update[3],
        update[4],
        update[5],
      ).toElement(webSocket),
    );
  } else if (update[4] !== undefined) {
    // Received update for magnet within our window
    const element = document.getElementById(`${update[0]}`)!;

    // Object is moving within bounds, update its values
    element.style.setProperty("--local-x", `${update[1]}px`);
    element.style.setProperty("--local-y", `${update[2]}px`);
    element.style.setProperty("--rotation", `${update[3]}deg`);
    element.style.zIndex = update[4].toString();
  } else if (update && update.length !== 0) {
    // Received indication that magnet was removed from our window
    const element = document.getElementById(`${update}`)!;
    door.removeChild(element);
  }
};

let viewWindow: Window;

const rotateCursor = document.getElementById("rotate-cursor")!;

// Add new elements to DOM, remove old elements
function replaceMagnets(magnetArray: Magnet[]) {
  const newElements = new DocumentFragment();
  for (const magnet of magnetArray) {
    const element = document.getElementById(`${magnet.id}`);
    if (element) {
      element.style.setProperty("--local-x", `${magnet.x}px`);
      element.style.setProperty("--local-y", `${magnet.y}px`);
      element.style.setProperty("--rotation", `${magnet.rotation}deg`);
      element.style.zIndex = magnet.zIndex.toString();
    } else {
      newElements.append(magnet.toElement(webSocket));
    }
  }

  door.querySelectorAll(".magnet").forEach((element) => {
    const magnet = element as HTMLElement;
    if (
      !viewWindow.contains(
        parseInt(magnet.style.getPropertyValue("--local-x")),
        parseInt(magnet.style.getPropertyValue("--local-y")),
      )
    ) {
      door.removeChild(magnet);
    }
  });

  door.append(newElements);
}

// Don't rerun all this logic if we are reconnecting to lost websocket connection
let hasAlreadyOpened = false;
webSocket.onopen = () => {
  if (hasAlreadyOpened) {
    // Re-request the whole window in case stuff was lost while disconnected
    updateCoordinatesFromHash();
    return;
  }
  hasAlreadyOpened = true;

  let canvasX: number;
  let canvasY: number;

  let isDraggingWindow = false;

  let clickOffsetX = 0;
  let clickOffsetY = 0;

  let centerX = 0;
  let centerY = 0;

  function updateCoordinatesFromHash() {
    const params = new URLSearchParams(globalThis.location.hash.slice(1));
    centerX = parseInt(params.get("x") ?? "0");
    centerY = parseInt(params.get("y") ?? "0");

    canvasX = Math.round(centerX - globalThis.innerWidth / 2);
    canvasY = Math.round(-centerY - globalThis.innerHeight / 2);

    document.documentElement.style.setProperty("--canvas-x", `${canvasX}px`);
    document.documentElement.style.setProperty("--canvas-y", `${canvasY}px`);

    viewWindow = new Window(
      Math.round(canvasX - globalThis.innerWidth),
      Math.round(canvasY - globalThis.innerHeight),
      Math.round(canvasX + 2 * globalThis.innerWidth),
      Math.round(canvasY + 2 * globalThis.innerHeight),
    );

    webSocket.send(viewWindow.pack());
  }

  if (!globalThis.location.hash) {
    const randomX = Math.round(Math.random() * 100000);
    const randomY = Math.round(Math.random() * 100000);
    globalThis.location.replace(`#x=${randomX}&y=${randomY}`);
  }

  updateCoordinatesFromHash();
  globalThis.addEventListener("hashchange", updateCoordinatesFromHash);

  document.body.removeChild(document.getElementById("loader")!);

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement;
      if (!dialog.contains(target) && !dialog.hidden) {
        dialog.hidden = true;
        dialog.classList.toggle("children-hidden");
      }

      if (clickedElement && !clickedElement.contains(target)) {
        hideRotationDot(clickedElement);
      }

      if (e.target !== document.body || isDraggingWindow) return;
      door.setPointerCapture(e.pointerId);
      isDraggingWindow = true;

      clickOffsetX = canvasX + e.clientX;
      clickOffsetY = canvasY + e.clientY;
    },
    { passive: true },
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (clickedElement) {
        if (e.target === clickedElement.firstElementChild) {
          // show cursor when we enter the dot
          requestAnimationFrame(() => {
            if (!clickedElement) return;
            rotateCursor.hidden = false;
            rotateCursor.style.transform = `translate3d(${e.clientX - 8}px, ${
              e.clientY - 8
            }px, 0) rotate(${
              parseInt(clickedElement.style.getPropertyValue("--rotation")) - 45
            }deg)`;
          });
        } else {
          // hide cursor when we leave the dot
          rotateCursor.hidden = true;
        }
      }

      if (isDraggingWindow) {
        canvasX = Math.floor(clickOffsetX - e.clientX);
        canvasY = Math.floor(clickOffsetY - e.clientY);

        requestAnimationFrame(() => {
          document.documentElement.style.setProperty(
            "--canvas-x",
            `${canvasX}px`,
          );
          document.documentElement.style.setProperty(
            "--canvas-y",
            `${canvasY}px`,
          );
        });
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerup",
    (e) => {
      if (!isDraggingWindow) return;
      door.releasePointerCapture(e.pointerId);
      isDraggingWindow = false;

      const newCenterX = canvasX + globalThis.innerWidth / 2;
      const newCenterY = -(canvasY + globalThis.innerHeight / 2);

      const xDiff = Math.abs(centerX - newCenterX);
      const yDiff = Math.abs(centerY - newCenterY);

      if (xDiff >= 1.0 || yDiff >= 1.0) {
        globalThis.location.replace(
          `#x=${Math.round(newCenterX)}&y=${Math.round(newCenterY)}`,
        );
      }
    },
    { passive: true },
  );
};

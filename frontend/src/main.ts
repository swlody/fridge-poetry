import { pack, unpack } from "msgpackr";

import "./style.css";

const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

interface Magnet {
  id: number;
  x: number;
  y: number;
  rotation: number;
  zIndex: number;
  word: string;
}

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

  constains(x: number, y: number): boolean {
    return x >= this.x1 && x <= this.x2 && y >= this.y1 && y <= this.y2;
  }
}

const door = document.getElementById("door")!;
function createMagnet(magnet: Magnet): HTMLElement {
  const element = document.createElement("div");
  element.className = "magnet";
  element.id = String(magnet.id);
  element.style.setProperty("--local-x", `${magnet.x}px`);
  element.style.setProperty("--local-y", `${magnet.y}px`);
  element.style.setProperty("--rotation", `${magnet.rotation}deg`);
  element.style.zIndex = String(magnet.zIndex);
  element.innerHTML = `<div hidden class="dot rotate">
    </div><div hidden class="rotate-link"></div>
    ${magnet.word}`;
  return element;
}

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
  setTimeout(() => {
    webSocket = new WebSocket(WS_URL);
  });
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
      magnets.push({
        id: val[0],
        x: val[1],
        y: val[2],
        rotation: val[3],
        zIndex: val[4],
        word: val[5],
      });
    }
    replaceMagnets(magnets);
  } else if (update[5] !== undefined) {
    // New object arriving from out of bounds, create it
    door.append(
      createMagnet({
        id: update[0],
        x: update[1],
        y: update[2],
        rotation: update[3],
        zIndex: update[4],
        word: update[5],
      }),
    );
  } else if (update[4] !== undefined) {
    // Received update for magnet within our window
    const element = document.getElementById(`${update[0]}`)!;

    // Object is moving within bounds, update its values
    element.style.setProperty("--local-x", `${update[1]}px`);
    element.style.setProperty("--local-y", `${update[2]}px`);
    element.style.setProperty("--rotation", `${update[3]}deg`);
    element.style.zIndex = update[4].toString();
  } else {
    // Received indication that magnet was removed from our window
    const element = document.getElementById(`${update}`)!;
    door.removeChild(element);
  }
};

let viewWindow: Window;

let clickedElement: HTMLElement | null = null;
let rotating = false;
const rotateCursor = document.getElementById("rotate-cursor")!;

function showRotationDot(element: HTMLElement) {
  for (const child of element.children) {
    const div = child as HTMLDivElement;
    div.hidden = false;
  }

  clickedElement = element;
}

function hideRotationDot(element: HTMLElement) {
  for (const child of element.children) {
    const div = child as HTMLDivElement;
    div.hidden = true;
  }

  clickedElement = null;
}

// Add new elements to DOM, remove old elements
function replaceMagnets(magnetArray: Magnet[]) {
  // Keep track of which IDs are missing from the update for later deletion
  const missingMagnetIds = new Set();
  door.querySelectorAll(".magnet").forEach((element) => {
    missingMagnetIds.add(element.id);
  });

  const newElements = new DocumentFragment();
  for (const magnet of magnetArray) {
    const element = document.getElementById(`${magnet.id}`);
    if (element) {
      missingMagnetIds.delete(String(magnet.id));

      element.style.setProperty("--local-x", `${magnet.x}px`);
      element.style.setProperty("--local-y", `${magnet.y}px`);
      element.style.setProperty("--rotation", `${magnet.rotation}deg`);
      element.style.zIndex = magnet.zIndex.toString();
    } else {
      newElements.append(createMagnet(magnet));
    }
  }

  // Remove all magnets not present in update
  for (const id of missingMagnetIds) {
    door.removeChild(document.getElementById(`${id}`)!);
  }

  // Add listeners to new elements
  newElements.querySelectorAll(".magnet").forEach((magnet) => {
    const element = magnet as HTMLElement;

    let clickOffsetX = 0;
    let clickOffsetY = 0;

    let originalX = 0;
    let originalY = 0;

    let newX = 0;
    let newY = 0;

    let isDragging = false;
    let hasChanged = false;

    let initialRotation = 0;
    let initialAngle = 0;

    function getAngle(element: HTMLElement, clientX: number, clientY: number) {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      // Calculate angle in radians, then convert to degrees
      return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
    }

    element.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0) return;

        element.setPointerCapture(e.pointerId);

        if (clickedElement && e.target === element.firstElementChild) {
          rotating = true;
          initialRotation =
            parseInt(element.style.getPropertyValue("--rotation")) || 0;
          initialAngle = getAngle(element, e.clientX, e.clientY);
        } else {
          isDragging = true;
          hasChanged = false;

          element.style.zIndex = "2147483647";

          clickOffsetX = e.clientX - element.offsetLeft;
          clickOffsetY = e.clientY - element.offsetTop;

          originalX = parseInt(element.style.getPropertyValue("--local-x"));
          originalY = parseInt(element.style.getPropertyValue("--local-y"));
        }
      },
      { passive: true },
    );

    element.addEventListener(
      "pointermove",
      (e) => {
        if (isDragging) {
          if (clickedElement) {
            hideRotationDot(clickedElement);
          }

          hasChanged = true;

          newX = originalX + e.clientX - clickOffsetX;
          newY = originalY + e.clientY - clickOffsetY;

          requestAnimationFrame(() => {
            element.style.setProperty("--local-x", `${Math.round(newX)}px`);
            element.style.setProperty("--local-y", `${Math.round(newY)}px`);
          });
        } else if (rotating) {
          const currentAngle = getAngle(element, e.clientX, e.clientY);
          const angleDiff = currentAngle - initialAngle;
          const newRotation = (initialRotation + angleDiff) % 360;

          hasChanged = true;

          requestAnimationFrame(() => {
            element.style.setProperty(
              "--rotation",
              `${Math.round(newRotation)}deg`,
            );
            // Update cursor rotation
            if (!rotateCursor.hidden) {
              rotateCursor.style.transform = `translate3d(${e.clientX - 8}px, ${
                e.clientY - 8
              }px, 0) rotate(${Math.round(newRotation) - 45}deg)`;
            }
          });
        }
      },
      { passive: true },
    );

    element.addEventListener(
      "pointerup",
      (e) => {
        if (isDragging) {
          element.releasePointerCapture(e.pointerId);

          isDragging = false;

          if (
            !hasChanged ||
            (Math.abs(newX - originalX) < 0.5 &&
              Math.abs(newY - originalY) < 0.5)
          ) {
            if (!clickedElement) {
              showRotationDot(element);
            } else {
              hideRotationDot(element);
            }
          } else {
            const magnetUpdate = pack({
              id: parseInt(element.id),
              x: Math.round(newX),
              y: Math.round(newY),
              rotation: parseInt(element.style.getPropertyValue("--rotation")),
            });
            webSocket.send(magnetUpdate);
          }
        } else if (rotating) {
          element.releasePointerCapture(e.pointerId);

          rotating = false;

          const magnetUpdate = pack({
            id: parseInt(element.id),
            x: parseInt(element.style.getPropertyValue("--local-x")),
            y: parseInt(element.style.getPropertyValue("--local-y")),
            rotation: parseInt(element.style.getPropertyValue("--rotation")),
          });

          webSocket.send(magnetUpdate);
        }
      },
      { passive: true },
    );
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

    webSocket.send(pack(viewWindow));
  }

  if (!globalThis.location.hash) {
    const randomX = Math.round(Math.random() * 100000);
    const randomY = Math.round(Math.random() * 100000);
    globalThis.location.replace(`#x=${randomX}&y=${randomY}`);
  }

  updateCoordinatesFromHash();
  globalThis.addEventListener("hashchange", updateCoordinatesFromHash);

  document.body.removeChild(document.getElementById("loader")!);

  function updateWindow() {
    document.documentElement.style.setProperty("--canvas-x", `${canvasX}px`);
    document.documentElement.style.setProperty("--canvas-y", `${canvasY}px`);
  }

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

        requestAnimationFrame(updateWindow);
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

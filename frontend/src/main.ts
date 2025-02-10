import { pack, unpack } from "msgpackr";

import "./style.css";

const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

class Magnet {
  id: number;
  x: number;
  y: number;
  rotation: number;
  zIndex: number;
  word: string;

  constructor(
    id: number,
    x: number,
    y: number,
    rotation: number,
    zIndex: number,
    word: string,
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.rotation = rotation;
    this.word = word;
    this.zIndex = zIndex;
  }
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
    return (
      x >= this.x1 &&
      x <= this.x2 &&
      y >= this.y1 &&
      y <= this.y2
    );
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
  element.innerText = magnet.word;
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

document.addEventListener("pointerdown", (e) => {
  if (e.target === document.body && !dialog.hidden) {
    dialog.hidden = true;
    dialog.classList.toggle("children-hidden");
  }
}, { passive: true });

const webSocket = new WebSocket(WS_URL);

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
    const magnet = new Magnet(
      update[0],
      update[1],
      update[2],
      update[3],
      update[4],
      update[5],
    );
    door.append(createMagnet(magnet));
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

function replaceMagnets(magnetArray: Magnet[]) {
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

  for (const id of missingMagnetIds) {
    door.removeChild(document.getElementById(`${id}`)!);
  }

  newElements.querySelectorAll(".magnet").forEach((magnet) => {
    const element = magnet as HTMLElement;

    let clickOffsetX = 0;
    let clickOffsetY = 0;

    let originalX = 0;
    let originalY = 0;

    let newX = 0;
    let newY = 0;

    let isDragging = false;
    let hasMoved = false;

    function updateMagnet() {
      element.style.setProperty("--local-x", `${Math.round(newX)}px`);
      element.style.setProperty("--local-y", `${Math.round(newY)}px`);
    }

    element.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      element.setPointerCapture(e.pointerId);
      isDragging = true;
      hasMoved = false;

      element.style.zIndex = String(Number.MAX_SAFE_INTEGER);

      clickOffsetX = e.clientX - element.offsetLeft;
      clickOffsetY = e.clientY - element.offsetTop;

      originalX = parseInt(element.style.getPropertyValue("--local-x"));
      originalY = parseInt(element.style.getPropertyValue("--local-y"));
    }, { passive: true });

    element.addEventListener("pointermove", (e) => {
      if (!isDragging) return;
      hasMoved = true;

      newX = originalX + e.clientX - clickOffsetX;
      newY = originalY + e.clientY - clickOffsetY;

      requestAnimationFrame(updateMagnet);
    }, { passive: true });

    element.addEventListener("pointerup", (e) => {
      if (!isDragging) return;
      e.stopPropagation();
      element.releasePointerCapture(e.pointerId);
      isDragging = false;

      if (!hasMoved) {
        return;
      }

      updateMagnet();

      const magnetUpdate = pack(
        {
          id: parseInt(element.id),
          x: Math.round(newX),
          y: Math.round(newY),
          rotation: parseInt(element.style.getPropertyValue("--rotation")),
        },
      );
      webSocket.send(magnetUpdate);
    });
  }, { passive: true });

  door.append(newElements);
}

webSocket.onopen = () => {
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
    const randomX = Math.round(Math.random() * 10000);
    const randomY = Math.round(Math.random() * 10000);
    globalThis.location.hash = `x=${randomX}&y=${randomY}`;
  }

  updateCoordinatesFromHash();
  globalThis.addEventListener("hashchange", updateCoordinatesFromHash);

  document.body.removeChild(document.getElementById("loader")!);

  function updateWindow() {
    document.documentElement.style.setProperty(
      "--canvas-x",
      `${canvasX}px`,
    );
    document.documentElement.style.setProperty(
      "--canvas-y",
      `${canvasY}px`,
    );
  }

  document.addEventListener("pointerdown", (e) => {
    if (isDraggingWindow) return;
    door.setPointerCapture(e.pointerId);
    isDraggingWindow = true;

    clickOffsetX = canvasX + e.clientX;
    clickOffsetY = canvasY + e.clientY;
  }, { passive: true });

  document.addEventListener("pointermove", (e) => {
    if (!isDraggingWindow) return;

    canvasX = Math.floor(clickOffsetX - e.clientX);
    canvasY = Math.floor(clickOffsetY - e.clientY);

    requestAnimationFrame(updateWindow);
  }, { passive: true });

  document.addEventListener("pointerup", (e) => {
    if (!isDraggingWindow) return;
    door.releasePointerCapture(e.pointerId);
    isDraggingWindow = false;

    const newCenterX = canvasX + globalThis.innerWidth / 2;
    const newCenterY = -(canvasY + globalThis.innerHeight / 2);

    const xDiff = Math.abs(centerX - newCenterX);
    const yDiff = Math.abs(centerY - newCenterY);
    if (
      xDiff >= 1.0 || yDiff >= 1.0
    ) {
      globalThis.location.hash = `x=${Math.round(newCenterX)}&y=${
        Math.round(
          newCenterY,
        )
      }`;
    }
  }, { passive: true });
};

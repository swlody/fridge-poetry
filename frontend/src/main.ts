import { pack, unpack } from "msgpackr";

import "./style.css";

const API_URL = import.meta.env.VITE_API_BASE_URL || "api";
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

let door: HTMLElement;

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

const webSocket = new WebSocket(WS_URL);

// TODO consider race conditions between this and mouseup replaceMagnets
// We receive an update to a magnet within our window
webSocket.onmessage = async (e) => {
  const arrayBuffer = await e.data.arrayBuffer(); // Convert Blob to ArrayBuffer
  const uint8Array = new Uint8Array(arrayBuffer);

  const update = unpack(uint8Array);

  if (update.Move) {
    // Received update for magnet within our window
    const move = update.Move;
    const element = document.getElementById(`${move[0]}`)!;

    // Object is moving within bounds, update its values
    element.style.setProperty("--local-x", `${move[1]}px`);
    element.style.setProperty("--local-y", `${move[2]}px`);
    element.style.setProperty("--rotation", `${move[3]}deg`);
    element.style.zIndex = move[4].toString();
  } else if (update.Remove) {
    // Magnet left our window, remove it
    const remove = update.Remove;
    const element = document.getElementById(`${remove}`)!;
    door.removeChild(element);
  } else {
    // New object arriving from out of bounds, create it
    // Since we received the update, it must be for a removal
    const create = update.Create;
    const magnet = new Magnet(
      create[0],
      create[1],
      create[2],
      create[3],
      create[4],
      create[5],
    );
    door.append(createMagnet(magnet));
  }
};

let viewWindow: Window;

async function replaceMagnets() {
  webSocket.send(pack(viewWindow));

  const magnetArray = await fetch(
    `${API_URL}/magnets?x1=${viewWindow.x1}&y1=${viewWindow.y1}&x2=${viewWindow.x2}&y2=${viewWindow.y2}`,
  ).then((r) => r.json());

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
      element.style.zIndex = magnet.z_index;
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

    function updateMagnet() {
      element.style.setProperty("--local-x", `${newX}px`);
      element.style.setProperty("--local-y", `${newY}px`);
    }

    element.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      element.setPointerCapture(e.pointerId);
      isDragging = true;

      element.style.cursor = "grabbing";
      element.style.zIndex = String(Number.MAX_SAFE_INTEGER);

      clickOffsetX = Math.floor(e.clientX - element.offsetLeft);
      clickOffsetY = Math.floor(e.clientY - element.offsetTop);

      originalX = parseInt(element.style.getPropertyValue("--local-x"));
      originalY = parseInt(element.style.getPropertyValue("--local-y"));
    }, { passive: true });

    element.addEventListener("pointermove", (e) => {
      if (!isDragging) return;

      newX = Math.floor(originalX + e.clientX - clickOffsetX);
      newY = Math.floor(originalY + e.clientY - clickOffsetY);

      requestAnimationFrame(updateMagnet);
    }, { passive: true });

    element.addEventListener("pointerup", async (e) => {
      if (!isDragging) return;
      e.stopPropagation();
      element.releasePointerCapture(e.pointerId);
      isDragging = false;

      element.style.cursor = "grab";

      updateMagnet();

      const id = parseInt(element.id);
      const rotation = parseInt(element.style.getPropertyValue("--rotation"));

      const update = {
        id: id,
        x: newX,
        y: newY,
        rotation: rotation,
      };

      const newZIndex = await fetch(`${API_URL}/magnet`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(update, (key, value) => {
          if (key == "word" || key == "zIndex") return undefined;
          else return value;
        }),
      }).then((r) => r.text());

      element.style.zIndex = newZIndex;
    });
  }, { passive: true });

  door.append(newElements);
}

webSocket.onopen = () => {
  door = document.getElementById("door")!;

  let canvasX: number;
  let canvasY: number;

  let isDraggingWindow = false;

  let clickOffsetX = 0;
  let clickOffsetY = 0;

  async function updateCoordinatesFromHash() {
    const params = new URLSearchParams(globalThis.location.hash.slice(1));
    const centerX = parseInt(params.get("x") ?? "0");
    const centerY = parseInt(params.get("y") ?? "0");

    canvasX = Math.floor(centerX - globalThis.innerWidth / 2);
    canvasY = Math.floor(-centerY - globalThis.innerHeight / 2);

    document.documentElement.style.setProperty("--canvas-x", `${canvasX}px`);
    document.documentElement.style.setProperty("--canvas-y", `${canvasY}px`);

    viewWindow = new Window(
      Math.floor(canvasX - globalThis.innerWidth),
      Math.floor(canvasY - globalThis.innerHeight),
      Math.floor(canvasX + 2 * globalThis.innerWidth),
      Math.floor(canvasY + 2 * globalThis.innerHeight),
    );

    await replaceMagnets();
  }

  globalThis.addEventListener("hashchange", updateCoordinatesFromHash);

  updateCoordinatesFromHash();
  door.removeChild(document.getElementById("loader")!);

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

    clickOffsetX = Math.floor(canvasX + e.clientX);
    clickOffsetY = Math.floor(canvasY + e.clientY);
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

    const centerX = Math.floor(canvasX + globalThis.innerWidth / 2);
    const centerY = -1 * Math.floor(canvasY + globalThis.innerHeight / 2);
    globalThis.location.hash = `x=${centerX}&y=${centerY}`;
  }, { passive: true });
};

webSocket.onclose = () => {
  console.log("WebSocket connection closed");
};

import "./style.css";

const API_URL = import.meta.env.VITE_API_BASE_URL || "api";
const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

class Magnet {
  id: number;
  x: number;
  y: number;
  rotation: number;
  word: string;
  zIndex: number;

  constructor(
    id: number,
    x: number,
    y: number,
    rotation: number,
    word: string,
    zIndex: number,
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
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;

  constructor(minX: number, minY: number, maxX: number, maxY: number) {
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  contains(x: number, y: number): boolean {
    return (
      x >= this.minX &&
      x <= this.maxX &&
      y >= this.minY &&
      y <= this.maxY
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
webSocket.onmessage = (e) => {
  // TODO what if it's something else?
  const update = JSON.parse(e.data);
  const element = document.getElementById(`${update.id}`);

  // Received update for magnet within our window
  if (element && viewWindow.contains(update.new_x, update.new_y)) {
    // Object is moving within bounds, update its values
    element.style.setProperty("--local-x", `${update.new_x}px`);
    element.style.setProperty("--local-y", `${update.new_y}px`);
    element.style.setProperty("--rotation", `${update.rotation}deg`);
    element.style.zIndex = update.z_index;
  } else if (element) {
    // Magnet left our window, remove it
    door.removeChild(element);
  } else {
    // New object arriving from out of bounds, create it
    // Since we received the update, it must be for a removal
    // TODO for removals we can just send a remove message from backend with ID, no need for old_x, old_y
    const magnet = new Magnet(
      update.id,
      update.new_x,
      update.new_y,
      update.rotation,
      update.word,
      update.z_index,
    );
    door.append(createMagnet(magnet));
  }
};

let viewWindow: Window;

async function replaceMagnets() {
  webSocket.send(JSON.stringify(viewWindow));

  const magnetArray = await fetch(
    `${API_URL}/magnets?minX=${viewWindow.minX}&minY=${viewWindow.minY}&maxX=${viewWindow.maxX}&maxY=${viewWindow.maxY}`,
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

    function resetPointerState() {
      clickOffsetX = 0;
      clickOffsetY = 0;

      originalX = 0;
      originalY = 0;

      newX = 0;
      newY = 0;
    }

    let isDragging = false;

    function updateMagnet() {
      element.style.setProperty("--local-x", `${newX}px`);
      element.style.setProperty("--local-y", `${newY}px`);
    }

    element.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      element.setPointerCapture(e.pointerId);
      isDragging = true;

      element.style.zIndex = String(Number.MAX_SAFE_INTEGER);

      clickOffsetX = Math.floor(e.clientX - element.offsetLeft);
      clickOffsetY = Math.floor(e.clientY - element.offsetTop);

      originalX = parseInt(element.style.getPropertyValue("--local-x"));
      originalY = parseInt(element.style.getPropertyValue("--local-y"));
    }, { passive: true });

    door.addEventListener("pointermove", (e) => {
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

      resetPointerState();
    });
  }, { passive: true });

  door.append(newElements);
}

webSocket.onopen = async () => {
  door = document.getElementById("door")!;

  let canvasX: number;
  let canvasY: number;

  let isDraggingWindow = false;

  let clickOffsetX = 0;
  let clickOffsetY = 0;

  function updateCoordinates(centerX: number, centerY: number) {
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
  }

  let disableNextHashCallback = false;
  function updateCoordinatesFromHash() {
    if (disableNextHashCallback) {
      disableNextHashCallback = false;
      return;
    }

    const params = new URLSearchParams(globalThis.location.hash.slice(1));
    const centerX = parseInt(params.get("x") ?? "0");
    const centerY = parseInt(params.get("y") ?? "0");

    updateCoordinates(centerX, centerY);
  }

  globalThis.addEventListener("hashchange", updateCoordinatesFromHash);

  updateCoordinatesFromHash();
  await replaceMagnets();
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

  document.addEventListener("pointerup", async (e) => {
    if (!isDraggingWindow) return;
    door.releasePointerCapture(e.pointerId);
    isDraggingWindow = false;

    const centerX = Math.floor(canvasX + globalThis.innerWidth / 2);
    const centerY = -1 * Math.floor(canvasY + globalThis.innerHeight / 2);
    disableNextHashCallback = true;
    globalThis.location.hash = `x=${centerX}&y=${centerY}`;

    updateCoordinates(centerX, centerY);

    await replaceMagnets();

    clickOffsetX = 0;
    clickOffsetY = 0;
  }, { passive: true });
};

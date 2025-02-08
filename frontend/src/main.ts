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

let canvasX = 0;
let canvasY = 0;

function getMagnetDiv(magnet: Magnet): string {
  return `
  <div class="magnet" id=${magnet.id} style="--local-x: ${magnet.x}px; --local-y: ${magnet.y}px; --rotation: ${magnet.rotation}deg; z-index: ${magnet.zIndex};">
    ${magnet.word}
  </div>`;
}

const webSocket = new WebSocket(WS_URL);

// TODO consider race conditions between this and mouseup replaceMagnets
// We receive an update to a magnet within our window
webSocket.onmessage = (e) => {
  // TODO what if it's something else?
  const update = JSON.parse(e.data);

  // Update for magnet within our window
  if (viewWindow.contains(update.new_x, update.new_y)) {
    if (!viewWindow.contains(update.old_x, update.old_y)) {
      // Magnet newly entered our window, add it
      // TODO use same type for magnet and magnet update?
      // TODO or, magnet update is a magnet + old_x and old_y?
      const magnet = new Magnet(
        update.id,
        update.new_x,
        update.new_y,
        update.rotation,
        update.word,
        update.z_index,
      );

      document.body.insertAdjacentHTML("beforeend", getMagnetDiv(magnet));
    }

    const element = document.getElementById(`${update.id}`)!;
    element.style.setProperty("--local-x", `${update.new_x}px`);
    element.style.setProperty("--local-y", `${update.new_y}px`);
    element.style.setProperty("--rotation", `${update.rotation}deg`);
    element.style.zIndex = update.z_index;
  } else {
    // Magnet left our window, remove it
    const element = document.getElementById(`${update.id}`)!;
    document.body.removeChild(element);
  }
};

let viewWindow: Window;

async function replaceMagnets() {
  webSocket.send(JSON.stringify(viewWindow));

  const magnetArray = await fetch(
    `${API_URL}/magnets?minX=${viewWindow.minX}&minY=${viewWindow.minY}&maxX=${viewWindow.maxX}&maxY=${viewWindow.maxY}`,
  ).then((r) => r.json());

  const missingMagnetIds = new Set();
  document.body.querySelectorAll(".magnet").forEach((element) => {
    missingMagnetIds.add(element.id);
  });

  const newElements = [];
  for (const magnet of magnetArray) {
    const element = document.getElementById(`${magnet.id}`);
    if (element) {
      missingMagnetIds.delete(String(magnet.id));

      element.style.setProperty("--local-x", `${magnet.x}px`);
      element.style.setProperty("--local-y", `${magnet.y}px`);
      element.style.setProperty("--rotation", `${magnet.rotation}deg`);
      element.style.zIndex = magnet.z_index;
    } else {
      document.body.insertAdjacentHTML("afterbegin", getMagnetDiv(magnet));
      newElements.push(document.body.firstElementChild as HTMLElement);
    }
  }

  for (const id of missingMagnetIds) {
    document.body.removeChild(document.getElementById(`${id}`)!);
  }

  newElements.forEach((element) => {
    let clickOffsetX: number;
    let clickOffsetY: number;

    let originalX: number;
    let originalY: number;

    let newX: number;
    let newY: number;

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

    document.addEventListener("pointermove", (e) => {
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

      clickOffsetX = 0;
      clickOffsetY = 0;

      originalX = 0;
      originalY = 0;

      newX = 0;
      newY = 0;
    });
  }, { passive: true });
}

webSocket.onopen = async () => {
  viewWindow = new Window(
    Math.floor(canvasX - globalThis.innerWidth),
    Math.floor(canvasY - globalThis.innerHeight),
    Math.floor(canvasX + 2 * globalThis.innerWidth),
    Math.floor(canvasY + 2 * globalThis.innerHeight),
  );

  await replaceMagnets();
  document.body.removeChild(document.getElementById("loader")!);

  let isDraggingWindow = false;

  let clickOffsetX = 0;
  let clickOffsetY = 0;

  let dragX = 0;
  let dragY = 0;

  function updateWindow() {
    document.body.style.setProperty(
      "--canvas-x",
      `${dragX}px`,
    );
    document.body.style.setProperty(
      "--canvas-y",
      `${dragY}px`,
    );
  }

  document.body.addEventListener("pointerdown", (e) => {
    document.body.setPointerCapture(e.pointerId);
    isDraggingWindow = true;

    clickOffsetX = Math.floor(canvasX + e.clientX);
    clickOffsetY = Math.floor(canvasY + e.clientY);
  }, { passive: true });

  document.body.addEventListener("pointermove", (e) => {
    if (!isDraggingWindow) return;

    dragX = Math.floor(clickOffsetX - e.clientX);
    dragY = Math.floor(clickOffsetY - e.clientY);

    requestAnimationFrame(updateWindow);
  }, { passive: true });

  document.body.addEventListener("pointerup", async (e) => {
    if (!isDraggingWindow) return;
    document.body.releasePointerCapture(e.pointerId);
    isDraggingWindow = false;

    canvasX = dragX;
    canvasY = dragY;

    viewWindow.minX = Math.floor(canvasX - globalThis.innerWidth);
    viewWindow.minY = Math.floor(canvasY - globalThis.innerHeight);
    viewWindow.maxX = Math.floor(canvasX + 2 * globalThis.innerWidth);
    viewWindow.maxY = Math.floor(canvasY + 2 * globalThis.innerHeight);

    updateWindow();
    await replaceMagnets();

    clickOffsetX = 0;
    clickOffsetY = 0;

    dragX = 0;
    dragY = 0;
  }, { passive: true });
};

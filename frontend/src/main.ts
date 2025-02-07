import "./style.css";

const API_URL = import.meta.env.VITE_API_BASE_URL || "api";
const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

// TODO is this necessary?
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
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;

  constructor(min_x: number, min_y: number, max_x: number, max_y: number) {
    this.min_x = min_x;
    this.min_y = min_y;
    this.max_x = max_x;
    this.max_y = max_y;
  }

  update(min_x: number, min_y: number, max_x: number, max_y: number) {
    this.min_x = min_x;
    this.min_y = min_y;
    this.max_x = max_x;
    this.max_y = max_y;
  }

  contains(x: number, y: number): boolean {
    return (
      x >= this.min_x &&
      x <= this.max_x &&
      y >= this.min_y &&
      y <= this.max_y
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

// We receive an update to a magnet within our window
webSocket.onmessage = (e) => {
  // TODO what if it's something else?
  const update = JSON.parse(e.data);

  // Update for magnet within our window
  if (viewWindow.contains(update.new_x, update.new_y)) {
    if (viewWindow.contains(update.old_x, update.old_y)) {
      // Magnet was already in our window, update it
      const magnet = magnets.get(update.id)!;
      magnet.x = update.new_x;
      magnet.y = update.new_y;
      magnet.rotation = update.rotation;
      magnet.zIndex = ++globalzIndex;
    } else {
      // Magnet newly entered our window, add it
      const magnet = new Magnet(
        update.id,
        update.new_x,
        update.new_y,
        update.rotation,
        update.word,
        ++globalzIndex,
      );

      magnets.set(
        update.id,
        magnet,
      );

      const div = getMagnetDiv(magnet);
      document.body.insertAdjacentHTML("beforeend", div);
    }

    const element = document.getElementById(`${update.id}`) as HTMLElement;
    element.style.setProperty("--local-x", `${update.new_x}px`);
    element.style.setProperty("--local-y", `${update.new_y}px`);
    element.style.setProperty("--rotation", `${update.rotation}deg`);
  } else {
    // Magnet left our window, remove it
    magnets.delete(update.id);
    const element = document.getElementById(`${update.id}`) as HTMLElement;
    document.body.removeChild(element);
  }
};

let viewWindow: Window;

// TODO right now we're keeping all magnets in memory to have a stable zIndex
// I think this can be removed once zIndex goes in the database
const magnets = new Map<number, Magnet>();
let globalzIndex = 0;

async function replaceMagnets() {
  webSocket.send(JSON.stringify(viewWindow));

  const magnetArray = await fetch(
    `${API_URL}/magnets?min_x=${viewWindow.min_x}&min_y=${viewWindow.min_y}&max_x=${viewWindow.max_x}&max_y=${viewWindow.max_y}`,
  ).then((r) => r.json());

  let divs = "";
  for (const magnet of magnetArray) {
    magnets.set(magnet.id, magnet);
    divs += getMagnetDiv(magnet);
  }
  document.body.innerHTML = divs;

  document.querySelectorAll(".magnet").forEach((magnet) => {
    const element = magnet as HTMLElement;

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

      clickOffsetX = Math.floor(e.clientX - element.offsetLeft);
      clickOffsetY = Math.floor(e.clientY - element.offsetTop);

      originalX = parseInt(element.style.getPropertyValue("--local-x"));
      originalY = parseInt(element.style.getPropertyValue("--local-y"));

      element.style.zIndex = String(++globalzIndex);
    }, { passive: true });

    document.addEventListener("pointermove", (e) => {
      if (!isDragging) return;

      newX = Math.floor(originalX + e.clientX - clickOffsetX);
      newY = Math.floor(originalY + e.clientY - clickOffsetY);

      requestAnimationFrame(updateMagnet);
    }, { passive: true });

    element.addEventListener("pointerup", async (e) => {
      if (!isDragging) return;
      element.releasePointerCapture(e.pointerId);
      isDragging = false;

      updateMagnet();

      const id = parseInt(element.id);
      const rotation = parseInt(element.style.getPropertyValue("--rotation"));

      const magnet = magnets.get(id)!;
      magnet.x = newX;
      magnet.y = newY;
      magnet.rotation = rotation;
      magnet.zIndex = globalzIndex;

      await fetch(`${API_URL}/magnet`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(magnets.get(id), (key, value) => {
          if (key == "word" || key == "zIndex") return undefined;
          else return value;
        }),
      });

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

    updateWindow();

    canvasX = dragX;
    canvasY = dragY;

    viewWindow.update(
      Math.floor(canvasX - globalThis.innerWidth),
      Math.floor(canvasY - globalThis.innerHeight),
      Math.floor(canvasX + 2 * globalThis.innerWidth),
      Math.floor(canvasY + 2 * globalThis.innerHeight),
    );

    await replaceMagnets();

    clickOffsetX = 0;
    clickOffsetY = 0;

    dragX = 0;
    dragY = 0;
  }, { passive: true });
};

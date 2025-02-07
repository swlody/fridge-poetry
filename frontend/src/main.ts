import "./style.css";

const API_URL = import.meta.env.VITE_API_BASE_URL || "api";
const WS_URL = import.meta.env.VITE_WS_BASE_URL || "ws";

interface Magnet {
  id: number;
  x: number;
  y: number;
  rotation: number;
  word: string;
  zIndex: number;
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

webSocket.onmessage = (e) => {
  // TODO what if it's something else?
  const update = JSON.parse(e.data);

  console.log("received update");

  // FIXME not considering old/new

  // TODO bleh
  if (magnets.get(update.id)) {
    const magnet = magnets.get(update.id)!;
    magnets.set(update.id, {
      id: update.id,
      x: update.x,
      y: update.y,
      rotation: update.rotation,
      word: magnet.word,
      zIndex: ++globalzIndex,
    });

    const element = document.getElementById(`${update.id}`) as HTMLElement;
    element.style.setProperty("--local-x", `${update.x}px`);
    element.style.setProperty("--local-y", `${update.y}px`);
    element.style.setProperty("--rotation", `${update.rotation}deg`);
  }
};

const magnets = new Map<number, Magnet>();
let globalzIndex = 0;
async function replaceMagnets() {
  const min_x = Math.floor(canvasX - globalThis.innerWidth);
  const min_y = Math.floor(canvasY - globalThis.innerHeight);
  const max_x = Math.floor(canvasX + 2 * globalThis.innerWidth);
  const max_y = Math.floor(canvasY + 2 * globalThis.innerHeight);

  const window = {
    min_x,
    min_y,
    max_x,
    max_y,
  };

  webSocket.send(JSON.stringify(window));

  const magnetArray = await fetch(
    `${API_URL}/magnets?min_x=${window.min_x}&min_y=${window.min_y}&max_x=${window.max_x}&max_y=${window.max_y}`,
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

    element.addEventListener("pointerdown", (e) => {
      e.stopPropagation();

      isDragging = true;

      clickOffsetX = Math.floor(e.clientX - element.offsetLeft);
      clickOffsetY = Math.floor(e.clientY - element.offsetTop);

      originalX = parseInt(element.style.getPropertyValue("--local-x"));
      originalY = parseInt(element.style.getPropertyValue("--local-y"));

      element.style.zIndex = String(++globalzIndex);
    });

    function updateMagnet() {
      element.style.setProperty("--local-x", `${newX}px`);
      element.style.setProperty("--local-y", `${newY}px`);
    }

    document.addEventListener("pointermove", (e) => {
      if (!isDragging) return;

      newX = Math.floor(originalX + e.clientX - clickOffsetX);
      newY = Math.floor(originalY + e.clientY - clickOffsetY);

      requestAnimationFrame(updateMagnet);
    });

    element.addEventListener("pointerup", async () => {
      if (!isDragging) return;
      isDragging = false;

      const id = parseInt(element.id);
      const rotation = parseInt(element.style.getPropertyValue("--rotation"));

      magnets.set(id, {
        id,
        x: newX,
        y: newY,
        rotation,
        word: element.innerText,
        zIndex: globalzIndex,
      });

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
    });
  });
}

webSocket.onopen = async () => {
  console.log("websocket opened");
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
    isDraggingWindow = true;

    clickOffsetX = Math.floor(canvasX + e.clientX);
    clickOffsetY = Math.floor(canvasY + e.clientY);
  });

  document.body.addEventListener("pointermove", (e) => {
    if (!isDraggingWindow) return;

    dragX = Math.floor(clickOffsetX - e.clientX);
    dragY = Math.floor(clickOffsetY - e.clientY);

    requestAnimationFrame(updateWindow);
  });

  document.body.addEventListener("pointerup", async () => {
    if (!isDraggingWindow) return;
    isDraggingWindow = false;

    canvasX = dragX;
    canvasY = dragY;

    await replaceMagnets();
  });
};

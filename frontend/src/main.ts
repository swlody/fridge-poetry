import "./style.css";

const API_URL = import.meta.env.VITE_API_BASE_URL || "api";

interface Magnet {
  id: number;
  x: number;
  y: number;
  rotation: number;
  word: string;
  zIndex: number;
}

function getMagnetDiv(magnet: Magnet): string {
  return `
  <div class="magnet" id=${magnet.id} style="left: ${magnet.x}px; top: ${magnet.y}px; rotate: ${magnet.rotation}deg;">
    <div hidden class="dot rotate"></div>
    <div hidden class="rotate-link"></div>
    ${magnet.word}
  </div>`;
}

const door = document.querySelector<HTMLDivElement>("#door")!;

const magnets = new Map<number, Magnet>();
let globalzIndex = 0;
async function replaceMagnets() {
  const min_x = Math.floor(
    (-1 * door.getBoundingClientRect().left) -
      (globalThis.innerWidth),
  );
  const min_y = Math.floor(
    (-1 * door.getBoundingClientRect().top) -
      (globalThis.innerHeight),
  );
  const max_x = Math.floor(
    (-1 * door.getBoundingClientRect().left) +
      (2 * globalThis.innerWidth),
  );
  const max_y = Math.floor(
    (-1 * door.getBoundingClientRect().top) +
      (2 * globalThis.innerHeight),
  );

  const magnetArray = await fetch(
    `${API_URL}/magnets?min_x=${min_x}&min_y=${min_y}&max_x=${max_x}&max_y=${max_y}`,
  ).then((r) => r.json());

  let divs = "";
  for (const magnet of magnetArray) {
    magnets.set(magnet.id, magnet);
    // TODO this has to go first I think
    if (!magnets.get(magnet.id)!.zIndex) {
      magnets.get(magnet.id)!.zIndex = globalzIndex;
      globalzIndex++;
    }
    divs += getMagnetDiv(magnet);
  }

  door.innerHTML = `${divs}`;

  document.querySelectorAll(".magnet").forEach((magnet) => {
    const element = magnet as HTMLElement;

    let offsetX: number;
    let offsetY: number;
    let isDragging = false;

    element.addEventListener("mousedown", (e) => {
      e.stopImmediatePropagation();

      isDragging = true;

      offsetX = Math.floor(e.clientX - element.getBoundingClientRect().left);
      offsetY = Math.floor(e.clientY - element.getBoundingClientRect().top);
      element.style.zIndex = String(globalzIndex);
      globalzIndex++;
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;

      const newX = Math.floor(e.clientX - offsetX - door.offsetLeft);
      const newY = Math.floor(e.clientY - offsetY - door.offsetTop);
      element.style.left = newX + "px";
      element.style.top = newY + "px";
    });

    document.addEventListener("mouseup", async () => {
      if (!isDragging) return;
      isDragging = false;

      const x = parseInt(element.style.left);
      const y = parseInt(element.style.top);
      const id = parseInt(element.id);

      if (magnets.get(id)!.x == x && magnets.get(id)!.y == y) {
        document.getElementById(id.toString())!.childNodes.forEach(
          (e) => {
            const he = e as HTMLElement;
            he.hidden = !he.hidden;
          },
        );
        return;
      }

      const rotation = parseInt(element.style.rotate);

      magnets.set(id, {
        id,
        x,
        y,
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

// TODO loading indicator on initial page load
globalThis.onload = async () => {
  await replaceMagnets();
};

let baseOffsetX: number = 0;
let baseOffsetY: number = 0;
let isDraggingDoor = false;
document.addEventListener("mousedown", (e) => {
  isDraggingDoor = true;

  baseOffsetX = Math.floor(e.clientX - door.getBoundingClientRect().left);
  baseOffsetY = Math.floor(e.clientY - door.getBoundingClientRect().top);
});

document.addEventListener("mousemove", (e) => {
  if (!isDraggingDoor) return;

  door.style.left = Math.floor(e.clientX - baseOffsetX) + "px";
  door.style.top = Math.floor(e.clientY - baseOffsetY) + "px";
});

document.addEventListener("mouseup", async () => {
  if (!isDraggingDoor) return;
  isDraggingDoor = false;

  await replaceMagnets();
});

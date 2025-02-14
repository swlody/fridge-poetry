import { pack } from "msgpackr";

import { scale } from "./main.ts";

export let clickedElement: HTMLElement | null = null;
export let isDraggingMagnet = false;

export class Magnet {
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
    this.zIndex = zIndex;
    this.word = word;
  }

  toElement(webSocket: WebSocket): HTMLElement {
    const element = document.createElement("div");
    element.className = "magnet";
    element.id = String(this.id);
    element.style.setProperty("--local-x", `${this.x}px`);
    element.style.setProperty("--local-y", `${this.y}px`);
    element.style.setProperty("--rotation", `${this.rotation}deg`);
    element.style.zIndex = String(this.zIndex);
    element.innerHTML = `<div hidden class="rotate-dot">
    </div><div hidden class="rotate-link"></div>
    ${this.word}`;

    setupEventListeners(element, webSocket);

    return element;
  }
}

function showRotationDot(element: HTMLElement) {
  for (const child of element.children) {
    const div = child as HTMLDivElement;
    div.hidden = false;
  }

  clickedElement = element;
}

export function hideRotationDot(element: HTMLElement) {
  for (const child of element.children) {
    const div = child as HTMLDivElement;
    div.hidden = true;
  }

  clickedElement = null;
}

function packedMagnetUpdate(
  id: number,
  x: number,
  y: number,
  rotation: number,
) {
  return pack([id, x, y, rotation]);
}

function setupEventListeners(element: HTMLElement, webSocket: WebSocket) {
  let clickOffsetX = 0;
  let clickOffsetY = 0;

  let originalX = 0;
  let originalY = 0;

  let newX = 0;
  let newY = 0;

  let isDragging = false;
  let hasChanged = false;

  let rotating = false;
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
        isDraggingMagnet = true;
        hasChanged = false;

        element.style.zIndex = "2147483647";

        // offset from corner of magnet
        clickOffsetX = e.clientX / scale - element.offsetLeft;
        clickOffsetY = e.clientY / scale - element.offsetTop;

        // original x,y of magnet
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

        newX = originalX + (e.clientX - globalThis.innerWidth) / scale -
          clickOffsetX;
        newY = originalY + (e.clientY - globalThis.innerHeight) / scale -
          clickOffsetY;

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
        isDraggingMagnet = false;

        if (
          !hasChanged ||
          (Math.abs(newX - originalX) < 0.5 && Math.abs(newY - originalY) < 0.5)
        ) {
          if (!clickedElement) {
            showRotationDot(element);
          } else {
            hideRotationDot(element);
          }
        } else {
          const magnetUpdate = packedMagnetUpdate(
            parseInt(element.id),
            Math.round(newX),
            Math.round(newY),
            parseInt(element.style.getPropertyValue("--rotation")),
          );
          webSocket.send(magnetUpdate);
        }
      } else if (rotating) {
        element.releasePointerCapture(e.pointerId);

        rotating = false;

        const magnetUpdate = packedMagnetUpdate(
          parseInt(element.id),
          parseInt(element.style.getPropertyValue("--local-x")),
          parseInt(element.style.getPropertyValue("--local-y")),
          parseInt(element.style.getPropertyValue("--rotation")),
        );

        webSocket.send(magnetUpdate);
      }
    },
    { passive: true },
  );
}

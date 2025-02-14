import { pack } from "msgpackr";

import { scale } from "./main.ts";

export let clickedElement: HTMLElement | null = null;
export let isDraggingMagnet = false;

const magnetTemplate = document.getElementById("magnet") as HTMLTemplateElement;

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
    const element = (magnetTemplate.content.cloneNode(true) as DocumentFragment)
      .firstElementChild as HTMLElement;

    element.id = this.id.toString();

    element.style.setProperty("--x", `${this.x}px`);
    element.style.setProperty("--y", `${this.y}px`);
    element.style.setProperty("--rotation", `${this.rotation}deg`);
    element.style.zIndex = this.zIndex.toString();

    element.insertAdjacentText("beforeend", this.word);

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
  let startX = 0;
  let startY = 0;

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

        // original x,y of magnet
        originalX = parseInt(element.style.getPropertyValue("--x"));
        originalY = parseInt(element.style.getPropertyValue("--y"));

        startX = e.clientX / scale - originalX;
        startY = e.clientY / scale - originalY;
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

        newX = e.clientX / scale - startX;
        newY = e.clientY / scale - startY;

        requestAnimationFrame(() => {
          element.style.setProperty("--x", `${Math.round(newX)}px`);
          element.style.setProperty("--y", `${Math.round(newY)}px`);
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

        // I frankly don't understand why the hasChanged check is necessary
        // but if it's not there the magnet jumps far away when it is clicked
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
          parseInt(element.style.getPropertyValue("--x")),
          parseInt(element.style.getPropertyValue("--y")),
          parseInt(element.style.getPropertyValue("--rotation")),
        );

        webSocket.send(magnetUpdate);
      }
    },
    { passive: true },
  );
}

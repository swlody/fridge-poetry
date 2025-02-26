import { unpack } from "msgpackr";
import * as ease from "easing-utils";
import * as uuidv7 from "jsr:@std/uuid/unstable-v7";

import { App } from "./App.ts";
import * as AppState from "./AppState.ts";
import * as Config from "./Config.ts";
import {
  clickedElement,
  hideRotationDot,
  isDraggingMagnet,
  Magnet,
} from "./Magnet.ts";
import * as Utils from "./Utils.ts";

import "./style.css";

AppState.webSocket.connect();
AppState.webSocket.onopen = setupWebSocket;

function setupWebSocket() {
  AppState.webSocket.onmessage = handleWebsocketMessage;
  AppState.webSocket.onclose = () => {
    while (App.door.lastElementChild) {
      App.door.removeChild(App.door.lastElementChild);
    }
    App.door.appendChild(App.loaderElement);
  };

  AppState.webSocket.onreconnect = () => {
    AppState.updateCoordinatesFromHash();
    App.door.removeChild(App.loaderElement);
  };

  AppState.webSocket.ontimeout = () => {
    while (App.door.lastElementChild) {
      App.door.removeChild(App.door.lastElementChild);
    }
    App.door.appendChild(App.reloadButton);
  };

  globalThis.addEventListener("hashchange", AppState.updateCoordinatesFromHash);
  AppState.updateCoordinatesFromHash();

  App.door.removeChild(App.loaderElement);

  setupDocumentEventListeners();

  App.door.style.setProperty("--scale", "0.5");

  requestAnimationFrame(animateZoom);
}

// Add new elements to DOM, remove old elements
function replaceMagnets(door: HTMLElement, magnetArray: Magnet[]) {
  // Add new elements to document fragment to be added as a batch
  const newElements = new DocumentFragment();
  for (const magnet of magnetArray) {
    const element = document.getElementById(`${magnet.id}`);
    if (element) {
      element.style.setProperty("--x", `${magnet.x}px`);
      element.style.setProperty("--y", `${magnet.y}px`);
      element.style.setProperty("--rotation", `${magnet.rotation}deg`);
      element.style.zIndex = magnet.zIndex.toString();
    } else {
      newElements.append(magnet.toElement(AppState.webSocket));
    }
  }

  // remove all now-out-of-bounds magnets
  door.querySelectorAll(".magnet").forEach((element) => {
    const magnet = element as HTMLElement;
    if (
      !AppState.viewWindow.contains(
        parseInt(magnet.style.getPropertyValue("--x")),
        parseInt(magnet.style.getPropertyValue("--y")),
      )
    ) {
      door.removeChild(magnet);
    }
  });

  // add new magnets after removing old ones so we don't have to iterate over them
  door.append(newElements);
}

function startElementTransitionAnimation(
  transition_map: Map<number, HTMLElement>,
  element: HTMLElement,
  registerTimout: boolean,
  x: string,
  y: string,
  rotation: number | null = null,
  zIndex: number | null = null,
) {
  const id = parseInt(element.id);
  element.style.transition = "0.5s";
  element.style.setProperty("--x", x);
  element.style.setProperty("--y", y);

  if (rotation) {
    element.style.setProperty("--rotation", `${rotation}deg`);
  }
  if (zIndex) {
    element.style.zIndex = zIndex.toString();
  }

  if (registerTimout) {
    transition_map.set(id, element);
    setTimeout(() => {
      if (transition_map.has(id)) {
        element.style.transition = "";
        transition_map.delete(id);
      }
    }, 500);
  }
}

// TODO please please use zod on this or something
async function handleWebsocketMessage(e: MessageEvent) {
  // gross untyped nonsense, yuck yuck yuck
  const update = unpack(await e.data.arrayBuffer());

  // inferring the type of the update based on structure 🤢
  if (update[0] instanceof Array) {
    // Received list of new magnets to add to DOM
    const magnets = [];
    for (const val of update) {
      magnets.push(new Magnet(val[0], val[1], val[2], val[3], val[4], val[5]));
    }
    replaceMagnets(App.door, magnets);
  } else if (update[5] !== undefined) {
    if (uuidv7.validate(update)) {
      App.sessionIdDiv.innerText = update;
      return;
    }

    // New object arriving from out of bounds, create it
    const [x, y] = AppState.viewWindow.chooseRandomEdgeCoords();

    const element = new Magnet(
      update[0],
      x,
      y,
      update[3],
      update[4],
      update[5],
    ).toElement(AppState.webSocket);

    requestAnimationFrame(() => {
      App.door.append(element);

      requestAnimationFrame(() => {
        startElementTransitionAnimation(
          AppState.transitioning,
          element,
          true,
          update[1],
          update[2],
        );
      });
    });
  } else if (update[4] !== undefined) {
    // Received update for magnet within our window
    const element = document.getElementById(`${update[0]}`)!;

    const newX = `${update[1]}px`;
    const newY = `${update[2]}px`;
    const zIndex = update[4];

    if (
      element.style.getPropertyValue("--x") === newX &&
      element.style.getPropertyValue("--y") === newY
    ) {
      // don't transition if magnet hasn't moved
      // in most cases this should be because we initiated the update
      element.style.zIndex = zIndex.toString();
      return;
    }

    startElementTransitionAnimation(
      AppState.transitioning,
      element,
      true,
      newX,
      newY,
      update[3],
      zIndex,
    );
  } else if (update && update.length !== 0) {
    // Received indication that magnet was removed from our window
    const element = document.getElementById(`${update}`)!;

    const [x, y] = AppState.viewWindow.chooseRandomEdgeCoords();

    startElementTransitionAnimation(
      AppState.transitioning,
      element,
      false,
      `${x}px`,
      `${y}px`,
    );

    setTimeout(() => {
      App.door.removeChild(element);
    }, 500);
  }
}

function setupDocumentEventListeners() {
  const dragState = {
    evCache: [] as PointerEvent[],
    prevDiff: -1,

    isDraggingWindow: false,

    // starting x, y of cursor relative to world origin
    startingX: 0,
    startingY: 0,

    originalCenterX: 0,
    originalCenterY: 0,
  };

  App.newAreaButton.addEventListener("click", () => {
    Utils.makeNewHash();

    App.newAreaButton.disabled = true;
    App.newAreaButton.style.color = "darkgray";

    setTimeout(() => {
      App.newAreaButton.style.color = "";
      App.newAreaButton.disabled = false;
    }, 1000);
  });

  App.shareButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(globalThis.location.href);
    App.shareButton.innerText = "Copied!";
    setTimeout(() => {
      App.shareButton.innerText = "Share location";
    }, 2000);
  });

  document.addEventListener(
    "pointerdown",
    (e) => {
      // ignore right clicks
      if (e.button !== 0) return;

      // store multiple finger presses for pinch/zoom
      dragState.evCache.push(e);
      if (dragState.evCache.length > 1) return;

      AppState.transitioning.forEach((element) => {
        element.style.transition = "";
      });
      AppState.transitioning.clear();

      const target = e.target as HTMLElement;

      // remove rotation dot if it's showing on any magnet
      if (clickedElement && !clickedElement.contains(target)) {
        hideRotationDot();
      }

      if (e.target !== App.door || dragState.isDraggingWindow) {
        return;
      }

      App.door.setPointerCapture(e.pointerId);
      dragState.isDraggingWindow = true;

      dragState.originalCenterX = AppState.centerX;
      dragState.originalCenterY = AppState.centerY;

      // starting coordinates of mouse relative to world origin
      dragState.startingX =
        AppState.centerX +
        (e.clientX - globalThis.innerWidth / 2) / AppState.scale;
      dragState.startingY =
        -AppState.centerY +
        (e.clientY - globalThis.innerHeight / 2) / AppState.scale;
    },
    { passive: true },
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (isDraggingMagnet) return;

      const index = dragState.evCache.findIndex(
        (cachedEv) => cachedEv.pointerId == e.pointerId,
      );
      dragState.evCache[index] = e;

      if (dragState.evCache.length === 2 && !AppState.isInLoadingAnimation) {
        const xDiff =
          dragState.evCache[0].clientX - dragState.evCache[1].clientX;
        const yDiff =
          dragState.evCache[0].clientY - dragState.evCache[1].clientY;
        const curDiff = Math.sqrt(xDiff * xDiff + yDiff * yDiff);

        if (dragState.prevDiff > 0) {
          AppState.setScale(
            AppState.scale + (curDiff - dragState.prevDiff) / 500,
          );
          AppState.setScale(Math.min(Math.max(0.5, AppState.scale), 1.5));
          requestAnimationFrame(() => {
            App.door.style.setProperty("--scale", `${AppState.scale}`);
            AppState.startResizeTimer();
          });
        }

        dragState.prevDiff = curDiff;
      } else if (dragState.evCache.length === 1 && dragState.isDraggingWindow) {
        AppState.setCenter(
          Math.floor(
            dragState.startingX -
              (e.clientX - globalThis.innerWidth / 2) / AppState.scale,
          ),
          -Math.floor(
            dragState.startingY -
              (e.clientY - globalThis.innerHeight / 2) / AppState.scale,
          ),
        );

        requestAnimationFrame(() => {
          App.door.style.setProperty("--center-x", `${AppState.centerX}px`);
          App.door.style.setProperty("--center-y", `${AppState.centerY}px`);
        });
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "pointerup",
    (e) => {
      const index = dragState.evCache.findIndex(
        (cachedEv) => cachedEv.pointerId === e.pointerId,
      );
      dragState.evCache.splice(index, 1);

      if (dragState.evCache.length < 2) {
        dragState.prevDiff = -1;
      }

      if (!dragState.isDraggingWindow) return;
      App.door.releasePointerCapture(e.pointerId);
      dragState.isDraggingWindow = false;

      const xDiff = Math.abs(AppState.centerX - dragState.originalCenterX);
      const yDiff = Math.abs(AppState.centerY - dragState.originalCenterY);

      if (xDiff >= 1.0 || yDiff >= 1.0) {
        globalThis.location.replace(
          `#x=${Math.round(AppState.centerX)}&y=${Math.round(AppState.centerY)}`,
        );
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "dblclick",
    (e) => {
      e.preventDefault();
    },
    { passive: false },
  );

  globalThis.addEventListener("resize", () => {
    requestAnimationFrame(AppState.startResizeTimer);
  });

  document.addEventListener(
    "wheel",
    (e) => {
      if (AppState.isInLoadingAnimation) return;
      AppState.setScale(AppState.scale + e.deltaY * -0.001);
      AppState.setScale(Math.min(Math.max(0.5, AppState.scale), 1.5));
      requestAnimationFrame(() => {
        App.door.style.setProperty("--scale", `${AppState.scale}`);

        AppState.startResizeTimer();
      });
    },
    { passive: true },
  );
}

const zoomState = {
  startTime: 0,
};

function animateZoom(now: number) {
  if (zoomState.startTime === 0) {
    AppState.setIsInLoadingAnimation(true);
    zoomState.startTime = now;
  }

  const percentDone =
    (now - zoomState.startTime) / Config.START_ANIMATION_DURATION;
  if (percentDone >= 1) {
    App.door.style.setProperty("--scale", "1");
    AppState.setIsInLoadingAnimation(false);
  } else {
    App.door.style.setProperty(
      "--scale",
      `${0.5 + ease.easeOutCubic(percentDone) * 0.5}`,
    );
    requestAnimationFrame(animateZoom);
  }
}

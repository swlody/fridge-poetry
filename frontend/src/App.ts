export const App = {
  door: document.getElementById("door")! as HTMLElement,
  sessionIdDiv: document.getElementById("session-id")! as HTMLDivElement,
  loaderElement: document.getElementById("loader")! as HTMLDivElement,
  newAreaButton: document.getElementById(
    "new-area-button",
  )! as HTMLButtonElement,
  shareButton: document.getElementById("share-button")! as HTMLButtonElement,
  reloadButton: (() => {
    const reloadButton = document.createElement("button");
    reloadButton.className = "fake-magnet";
    reloadButton.style.setProperty("--rotation", "2deg");
    reloadButton.style.position = "absolute";
    reloadButton.style.top = "50%";
    reloadButton.style.left = "50%";
    reloadButton.style.transform = "translate(-50%, -50%)";
    reloadButton.innerText = "Connection lost, click to reload";
    reloadButton.addEventListener("click", () => {
      location.reload();
    });
    return reloadButton;
  })(),
  rotationDot: (() => {
    const rotationDot = document.createElement("div");
    rotationDot.hidden = true;
    rotationDot.className = "rotate-dot";
    return rotationDot;
  })(),
  rotationLink: (() => {
    const rotationLink = document.createElement("div");
    rotationLink.hidden = true;
    rotationLink.className = "rotate-link";
    return rotationLink;
  })(),
};

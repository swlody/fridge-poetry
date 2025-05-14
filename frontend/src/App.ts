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

export const contentWarningPopover = `<div id="content-warning-container" class="outer-popover">
  <div id="content-warning-dialog" class="middle-popover" popover>
    <div id="content-warning-inner" class="inner-popover">
      <div class="fake-magnet" style="text-align: center">
        Hello! It looks like you were directed here from my resume.
        <br />
        All of the content here is user generated which means that there may be some dirty jokes here in addition to the nice poems.
        <br />
        I do my best to remove anything too objectionable, but the internet is the internet and I don't yet have any automated content moderation.
        <br />
        Thanks for checking out my project!
        <br />
        (Click off of this dialog to close it.)
      </div>
    </div>
  </div>
</div>`;

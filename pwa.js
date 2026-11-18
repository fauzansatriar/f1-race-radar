"use strict";

const installButton = document.getElementById("install-pwa");
const installHelp = document.getElementById("install-help");
const appMode = matchMedia("(display-mode: standalone), (display-mode: fullscreen)");
let installPrompt = null;

function syncInstallButton() {
  installButton.hidden = appMode.matches || navigator.standalone === true;
}

syncInstallButton();
appMode.addEventListener("change", syncInstallButton);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  syncInstallButton();
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  installButton.hidden = true;
});

installButton.addEventListener("click", async () => {
  const prompt = installPrompt;
  installPrompt = null;
  if (prompt) {
    await prompt.prompt();
  } else {
    installHelp.showModal();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("Offline app setup unavailable", error);
  });
}

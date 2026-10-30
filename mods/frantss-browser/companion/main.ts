// The browser behind the frantss-browser pane: a frameless Chromium window that agents drive
// over CDP, placed over the pane's page area by the state the mod posts to the control port.
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { join } from "node:path";
import { CDP_PORT, CONTROL_PORT, type OverlayState } from "../placement.ts";

const HOME_PAGE = "https://example.com";
// Clicking the browser deactivates Herdr; keep showing while focus moves between the two.
const FOCUS_GRACE_MS = 300;

app.setName("frantss-browser");
app.setPath("userData", join(app.getPath("appData"), "frantss-browser"));
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
if (!app.requestSingleInstanceLock()) app.quit();

let window: BrowserWindow;
let state: OverlayState = { visible: false, herdrActive: false, x: 0, y: 0, width: 0, height: 0 };
let focusChangedAt = 0;

function place() {
  const focused = window.isFocused() || Date.now() - focusChangedAt < FOCUS_GRACE_MS;
  if (state.visible && (state.herdrActive || focused)) {
    window.setBounds({
      x: Math.round(state.x),
      y: Math.round(state.y),
      width: Math.round(state.width),
      height: Math.round(state.height),
    });
    if (!window.isVisible()) window.showInactive();
  } else if (window.isVisible()) window.hide();
}

void app.whenReady().then(() => {
  app.dock?.hide();
  window = new BrowserWindow({
    frame: false,
    show: false,
    hasShadow: false,
    roundedCorners: false,
  });
  window.setAlwaysOnTop(true, "floating");
  window.on("focus", () => (focusChangedAt = Date.now()));
  window.on("blur", () => {
    focusChangedAt = Date.now();
    setTimeout(place, FOCUS_GRACE_MS + 50);
  });
  void window.loadURL(HOME_PAGE);

  createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        state = { ...state, ...JSON.parse(body) };
        place();
        response.end();
      } catch {
        response.statusCode = 400;
        response.end();
      }
    });
  }).listen(CONTROL_PORT, "127.0.0.1");
});

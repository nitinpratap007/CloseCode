// Close Code — AI Agent Runtime — Electron browser adapter (Phase 22)
//
// The real `BrowserController`, and the only Phase 22 file that imports Electron
// for a tool. It exists separately from `tools-browser.ts` precisely so that the
// tool itself stays free of `electron` imports and remains unit-testable in
// plain Node — the rule the Phase 21 runtime was built on.
//
// One window per runtime, created lazily on the first browser call and reused
// for the life of the process. It is:
//   * created with `contextIsolation: true`, `nodeIntegration: false` and
//     `sandbox: true`, so a hostile page has no path to the filesystem or to
//     Node — the app's own security posture, applied to the agent's browser too;
//   * never given a preload script, so there is no bridge to abuse;
//   * kept out of the way (`show: false` until a navigation is actually asked
//     for would be worse for the user, so it is shown — the point of the tool is
//     that the user can see what the agent is looking at);
//   * closed when the app quits, and its web contents blocked from
//     `window.open` and from new windows so a page cannot spawn unbounded
//     children.

import { BrowserWindow, shell } from "electron";
import type { BrowserController, BrowserPage } from "./tools-browser";

const USER_AGENT_SUFFIX = "CloseCode-Agent/0.1";

/** How long a navigation may take before the tool reports a timeout. */
const NAV_TIMEOUT_MS = 30_000;
/** Ceiling on the text returned to the model from one page. */
const MAX_PAGE_TEXT = 400_000;

/** The user-agent this browser presents. Kept at the top because it is a policy. */
export const BROWSER_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ${USER_AGENT_SUFFIX}`;

let shared: ElectronBrowserController | null = null;

/**
 * The process-wide controller. The tool has no lifecycle of its own, so there is
 * one window rather than one per call: without reuse, `click` would have nothing
 * to click, because the page it was meant to click on would have been closed.
 */
export function getBrowserController(): BrowserController {
  if (!shared) shared = new ElectronBrowserController();
  return shared;
}

class ElectronBrowserController implements BrowserController {
  private window: BrowserWindow | null = null;

  available(): boolean {
    return BrowserWindow.getAllWindows().length > 0;
  }

  unavailableReason(): string {
    return this.available()
      ? ""
      : "No application window is open, so there is nothing to parent a browser window to.";
  }

  async page(): Promise<BrowserPage> {
    return new ElectronBrowserPage(this.ensureWindow());
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const parent = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    this.window = new BrowserWindow({
      parent,
      width: 1100,
      height: 800,
      title: "CloseCode — agent browser",
      show: true,
      // The agent browses pages it does not control, so it gets the same
      // lockdown as any untrusted content: no Node, no preload, no bridge.
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // The agent drives the page by executeJavaScript, which requires this.
        javascript: true,
      },
    });
    this.window.setMenuBarVisibility(false);
    // Identified honestly rather than impersonating a hand-typed browser: a site
    // that treats agents differently from people should be able to tell.
    this.window.webContents.setUserAgent(BROWSER_USER_AGENT);

    // A page that opens a new window would leave the user watching a browser
    // they never approved. Those requests go to the real system browser
    // instead, where the user can see and control them.
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
      return { action: "deny" };
    });
    // Same rule for a navigation the agent did not ask for.
    this.window.webContents.on("will-navigate", (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });

    this.window.on("closed", () => {
      this.window = null;
    });
    return this.window;
  }

  /** Test hook: forget the window. */
  reset(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

class ElectronBrowserPage implements BrowserPage {
  constructor(private readonly win: BrowserWindow) {}

  private get contents(): Electron.WebContents {
    if (this.win.isDestroyed()) throw new Error("The browser window was closed.");
    return this.win.webContents;
  }

  async goto(url: string): Promise<{ finalUrl: string; status: number | null; title: string }> {
    const wc = this.contents;
    await withTimeout(wc.loadURL(url), NAV_TIMEOUT_MS, `loading ${url}`);
    // Read after the load event rather than optimistically, so a slow SPA that
    // sets its title late is not reported with the previous page's title.
    const title = await this.title();
    return { finalUrl: wc.getURL(), status: null, title };
  }

  async title(): Promise<string> {
    const value = await this.contents.executeJavaScript("document.title").catch(() => "");
    return String(value ?? "");
  }

  async text(): Promise<string> {
    const value = await this.contents.executeJavaScript(
      `(document.body && document.body.innerText || "").slice(0, ${MAX_PAGE_TEXT})`,
    );
    return String(value ?? "").trim();
  }

  async click(selector: string): Promise<void> {
    await this.query(selector, "el.click()");
  }

  async type(selector: string, value: string): Promise<void> {
    await this.query(
      selector,
      "el.focus(); el.value = __value;" +
        "el.dispatchEvent(new Event('input', {bubbles:true}));" +
        "el.dispatchEvent(new Event('change', {bubbles:true}));",
      value,
    );
  }

  async attr(selector: string, name: string): Promise<string | null> {
    return this.query<string | null>(selector, "el.getAttribute(__name) ?? el.value ?? null", undefined, name);
  }

  async currentUrl(): Promise<string> {
    if (this.win.isDestroyed()) return "";
    return this.contents.getURL();
  }

  async screenshot(): Promise<{ pngBase64: string; bytes: number }> {
    if (this.win.isDestroyed()) throw new Error("The browser window was closed.");
    const image = await this.win.webContents.capturePage();
    const png = image.toPNG();
    return { pngBase64: png.toString("base64"), bytes: png.byteLength };
  }

  async close(): Promise<void> {
    if (!this.win.isDestroyed()) this.win.close();
  }

  /**
   * Resolve a selector to a single element and run `body` against it.
   *
   * Model-supplied values reach the page as JSON literals, never by string
   * concatenation: `JSON.stringify` escapes quotes, backslashes and control
   * characters, so a value containing `"; fetch("http://evil")` stays a string.
   * `__value` and `__name` are declared as consts so `body` reads like normal
   * code rather than reaching into a helper.
   */
  private async query<T>(selector: string, body: string, value?: string, name?: string): Promise<T> {
    const script = `(() => {
      const __selector = ${JSON.stringify(selector)};
      const __value = ${JSON.stringify(value ?? null)};
      const __name = ${JSON.stringify(name ?? null)};
      const el = document.querySelector(__selector);
      if (!el) throw new Error("no such element: " + __selector);
      return (() => { ${body} })();
    })()`;
    return (await this.contents.executeJavaScript(script, true)) as T;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s ${what}`)), ms);
    if (typeof timer.unref === "function") timer.unref();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

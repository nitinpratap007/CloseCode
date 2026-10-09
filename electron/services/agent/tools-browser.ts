// Close Code — AI Agent Runtime — browser tool (Phase 22)
//
// Phase 22's `browser` tool, defined against an *interface* rather than against
// Electron directly.
//
// The reason is architectural, and it is the Phase 21 rule that this whole
// runtime is built on: `tools.ts`, `runtime.ts`, `errors.ts` and `types.ts` import
// no `electron`, which is what makes the whole agent layer unit-testable in plain
// Node. A tool that reached for `BrowserWindow` at module scope would drag
// Electron into that test surface and end it.
//
// So this file declares `BrowserController` — the four things the tool needs a
// page to do — and `instance.ts`, which already imports Electron, supplies the
// real implementation. The tool itself is then fully testable against a fake
// controller, and the Electron binding is a small, obviously-correct adapter.
//
// One window is reused across calls within a run, which is what makes click and
// type meaningful: the second call sees the page the first call navigated to.

import { deniedResult, errorResult, okResult } from "./result";
import type { Capability } from "./permissions";
import type { AgentTool, AgentToolOutcome } from "./types";

/** The page operations the tool needs, and nothing more. */
export interface BrowserPage {
  /** Navigate and wait for load. Resolves with the final URL after redirects. */
  goto(url: string): Promise<{ finalUrl: string; status: number | null; title: string }>;
  /** Visible text of the document, already normalised. */
  text(): Promise<string>;
  /** Click the first element matching a CSS selector. */
  click(selector: string): Promise<void>;
  /** Focus an input and type into it. */
  type(selector: string, text: string): Promise<void>;
  /** Read one attribute (or `value`) of the first matching element. */
  attr(selector: string, name: string): Promise<string | null>;
  /** URL currently loaded. */
  currentUrl(): Promise<string>;
  /** Screenshot as a base64 PNG. Used only when the model asks for one. */
  screenshot(): Promise<{ pngBase64: string; bytes: number }>;
  close(): Promise<void>;
}

export interface BrowserController {
  /** A page for this run. Called lazily; a run that never browses makes no window. */
  page(): Promise<BrowserPage>;
  /** True when a browser can actually be shown right now. */
  available(): boolean;
  /** Why not, when `available()` is false. Shown to the model verbatim. */
  unavailableReason(): string;
}

export interface BrowserResult {
  url: string;
  title?: string;
  status?: number | null;
  text?: string;
  screenshot?: { bytes: number; pngBase64: string };
  attribute?: { selector: string; name: string; value: string | null };
}

/**
 * Phase 23. Which capability an action adds on top of `browser.navigate`.
 *
 * `open`, `text` and `screenshot` only pull content in. `click` and `type` change
 * state on the far side — a click can submit a form or follow a link, and `type`
 * can enter a password — so they are gated separately and a user can allow
 * reading a page while refusing to let an agent drive it.
 *
 * An unrecognised action adds nothing. The switch below then returns
 * `invalid_input`, and a tool that could not be identified must not be granted
 * the weaker permission on the assumption that it will turn out to be harmless.
 */
function browserActionCapabilities(action: string): readonly Capability[] {
  return action === "click" || action === "type" ? ["browser.interact"] : [];
}

/**
 * `browser` — open a page and interact with it.
 *
 * Four actions rather than four tools, because they share one window and one
 * permission decision; splitting them would mean the user approving "open a
 * page" and then approving "click a button" as if they were unrelated.
 *
 * The single most important property here is that this tool has **no network
 * access of its own** beyond the page it is told to open, and **no filesystem
 * access at all**. It cannot read the workspace. Anything it reports came from a
 * page the user saw in the approval prompt.
 */
export const BROWSER_TOOL_NAME = "browser";

export function createBrowserTool(controller: BrowserController): AgentTool {
  return {
    name: BROWSER_TOOL_NAME,
    description:
      "Open a web page and interact with it: read its text, click a button or link, type into a field. " +
      "Actions: `open`, `read`, `click`, `type`, `attr`, `screenshot`, `close`. " +
      "It can only read pages you approve; it cannot read your files.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "What to do with the page.",
          enum: ["open", "read", "click", "type", "attr", "screenshot", "close"],
        },
        url: { type: "string", description: "For `open`: the absolute http(s) URL to load.", default: "" },
        selector: { type: "string", description: "For `click`, `type`, `attr`: a CSS selector.", default: "" },
        text: { type: "string", description: "For `type`: the text to enter.", default: "" },
        name: { type: "string", description: "For `attr`: the attribute to read, or `value`.", default: "" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    category: "browser",
    // Phase 23. Reading a page is a different permission from driving it, so
    // the tool declares only the navigating half and the per-call request below
    // adds `browser.interact` for the actions that click and type. A user who
    // allows navigation but not interaction can then let an agent read a page
    // and refuse to let it submit the form.
    capabilities: ["browser.navigate"],
    readOnly: true,
    // A page can navigate the agent's own browser window to a login form and
    // then `type` a password into it, so this is never treated as harmless
    // despite not touching the filesystem.
    destructive: false,
    async execute(ctx, args): Promise<AgentToolOutcome> {
      const action = String(args.action ?? "");

      if (!(await ctx.authorize("browser", args, { capabilities: browserActionCapabilities(action) }))) {
        return deniedResult();
      }

      if (!controller.available()) {
        return errorResult("not_supported", controller.unavailableReason(), {
          text: `Error: browsing is unavailable — ${controller.unavailableReason()}`,
          hint: "Use web_fetch to read a URL without a browser window.",
        });
      }

      let page: BrowserPage;
      try {
        page = await controller.page();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult("unavailable", `Could not open a browser window: ${message}`, {
          text: `Error: could not open a browser window — ${message}`,
          hint: "Check that the app is not quitting, then try again.",
        });
      }

      const settle = (result: BrowserResult, data: unknown): AgentToolOutcome =>
        okResult(
          `${describe(result)}${result.text ? `\n\n${result.text}` : ""}${result.screenshot ? `\n\n[screenshot, ${result.screenshot.bytes} bytes of PNG]` : ""}`,
          {
            data,
            meta: { count: 1, bytes: result.text?.length ?? 0 },
          },
        );

      try {
        switch (action) {
          case "open": {
            const raw = String(args.url ?? "").trim();
            if (!raw) {
              return errorResult("invalid_input", "browser open needs a url.", {
                text: "Error: `open` requires a `url`.",
                hint: "Resend with an absolute http(s) URL.",
              });
            }
            let url: URL;
            try {
              url = new URL(raw);
            } catch {
              return errorResult("invalid_input", `"${raw}" is not a valid URL.`, {
                text: `Error: "${raw}" is not a valid URL.`,
                hint: "Pass an absolute http:// or https:// URL.",
              });
            }
            if (url.protocol !== "https:" && url.protocol !== "http:") {
              return errorResult("invalid_input", `Only http and https are supported, not ${url.protocol.replace(":", "")}.`, {
                text: `Error: only http and https URLs are supported, not ${url.protocol.replace(":", "")}.`,
                hint: "file:// and other schemes are not available to this tool.",
              });
            }
            const nav = await page.goto(url.href);
            const result: BrowserResult = { url: nav.finalUrl, title: nav.title, status: nav.status };
            return settle(result, result);
          }
          case "read": {
            const text = await page.text();
            const url = await page.currentUrl();
            const result: BrowserResult = { url, text };
            return settle(result, result);
          }
          case "click": {
            const selector = String(args.selector ?? "").trim();
            if (!selector) return needSelector(action);
            await page.click(selector);
            const url = await page.currentUrl();
            const result: BrowserResult = { url, title: "clicked" };
            return settle(result, { ...result, attribute: { selector, name: "clicked", value: "yes" } });
          }
          case "type": {
            const selector = String(args.selector ?? "").trim();
            const value = String(args.text ?? "");
            if (!selector) return needSelector(action);
            if (!value) {
              return errorResult("invalid_input", "browser type needs text.", {
                text: "Error: `type` requires non-empty `text`.",
                hint: "Resend with the text to enter, and a CSS selector for the field.",
              });
            }
            await page.type(selector, value);
            const result: BrowserResult = { url: await page.currentUrl(), title: "typed" };
            return settle(result, { ...result, attribute: { selector, name: "typed", value: `${value.length} chars` } });
          }
          case "attr": {
            const selector = String(args.selector ?? "").trim();
            const name = String(args.name ?? "").trim() || "value";
            if (!selector) return needSelector(action);
            const value = await page.attr(selector, name);
            const result: BrowserResult = { url: await page.currentUrl() };
            return settle(result, { ...result, attribute: { selector, name, value } });
          }
          case "screenshot": {
            const shot = await page.screenshot();
            const result: BrowserResult = { url: await page.currentUrl(), screenshot: shot };
            return settle(result, result);
          }
          case "close": {
            await page.close();
            const result: BrowserResult = { url: "", title: "closed" };
            return okResult("Browser page closed.", { data: result, meta: { count: 0 } });
          }
          default:
            return errorResult("invalid_input", `Unknown browser action "${action}".`, {
              text: `Error: unknown action "${action}". Valid actions: open, read, click, type, attr, screenshot, close.`,
              hint: "Resend with one of the listed actions.",
            });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult("tool_failed", message, {
          text: `Error: browser ${action} failed — ${message}`,
          hint: /no such element|not found|no node/i.test(message)
            ? "The selector did not match anything on the page. Use `read` to see the page text and pick a different selector."
            : "The page may have navigated or closed. Use `read` to check its state.",
        });
      }
    },
  };
}

function needSelector(action: string): AgentToolOutcome {
  return errorResult("invalid_input", `browser ${action} needs a selector.`, {
    text: `Error: \`${action}\` requires a CSS \`selector\`.`,
    hint: "Use `read` to see the page, then resend with a selector.",
  });
}

function describe(result: BrowserResult): string {
  if (result.title === "closed") return "Browser page closed.";
  const parts: string[] = [];
  if (result.url) parts.push(result.url);
  if (result.title && result.title !== "clicked" && result.title !== "typed") parts.push(`— ${result.title}`);
  if (result.status !== undefined && result.status !== null) parts.push(`(HTTP ${result.status})`);
  if (result.attribute) parts.push(`${result.attribute.selector}[${result.attribute.name}] = ${result.attribute.value ?? "(absent)"}`);
  return parts.join(" ");
}

/**
 * A controller that refuses every call. Registered when Electron reports no
 * usable window, so the tool is still *present* in the registry and answers with
 * a clear reason, rather than the model discovering a missing tool and guessing
 * at a substitute.
 */
export const unavailableBrowserController = (reason: string): BrowserController => ({
  available: () => false,
  unavailableReason: () => reason,
  page: async () => {
    throw new Error(reason);
  },
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The search service reads user settings through electron's `app.getPath`, so the
// module has to be loaded after the mock is installed and with a cache reset
// (otherwise a previous import would hold the real electron binding).
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cc-search-settings-"));
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

type SearchModule = typeof import("../electron/services/search");

async function loadSearch(): Promise<SearchModule> {
  vi.resetModules();
  return import("../electron/services/search");
}

const OPTIONS = { isRegex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "" };

let root: string;
let search: SearchModule;

function write(relative: string, content: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-search-test-"));
  // Mixed case on purpose: a case-sensitive search for the lowercase query must find
  // nothing, so a shared cache entry between the two option sets cannot go unnoticed.
  write("a.ts", "const PerfNeedle = 1;\n");
  write("nested/b.ts", "const PerfNeedle = 2;\n");
  write("nested/deep/c.ts", "// nothing here\n");
  search = await loadSearch();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("Phase 16 search result cache", () => {
  it("reports a miss on the first run and a hit on an identical rerun", async () => {
    const first = await search.searchWorkspace(root, "perfneedle", OPTIONS);
    expect(first.cache).toBe("miss");
    expect(first.results).toHaveLength(2);

    const second = await search.searchWorkspace(root, "perfneedle", OPTIONS);
    expect(second.cache).toBe("hit");
    // A cache hit must be indistinguishable in content from the run it memoised.
    expect(second.results).toEqual(first.results);
    expect(second.totalFiles).toBe(first.totalFiles);
    expect(second.searchedFiles).toBe(first.searchedFiles);
    expect(second.truncated).toBe(first.truncated);
  });

  it("does not share a cached result between different queries or options", async () => {
    await search.searchWorkspace(root, "perfneedle", OPTIONS);
    const other = await search.searchWorkspace(root, "nothing", OPTIONS);
    expect(other.cache).toBe("miss");

    await search.searchWorkspace(root, "perfneedle", OPTIONS);
    const caseSensitive = await search.searchWorkspace(root, "perfneedle", {
      ...OPTIONS,
      caseSensitive: true,
    });
    expect(caseSensitive.cache).toBe("miss");
    expect(caseSensitive.results).toHaveLength(0);
  });

  it("invalidateSearchCache() forces the next run back to a miss", async () => {
    await search.searchWorkspace(root, "perfneedle", OPTIONS);
    expect((await search.searchWorkspace(root, "perfneedle", OPTIONS)).cache).toBe("hit");
    search.invalidateSearchCache();
    expect((await search.searchWorkspace(root, "perfneedle", OPTIONS)).cache).toBe("miss");
  });

  it("sees a file written after the result was cached", async () => {
    const before = await search.searchWorkspace(root, "freshlywritten", OPTIONS);
    expect(before.results).toHaveLength(0);

    write("a.ts", "const PerfNeedle = 1;\nconst freshlywritten = 2;\n");
    // The app routes every write through this call, so this is the production path.
    search.invalidateSearchCache();

    const after = await search.searchWorkspace(root, "freshlywritten", OPTIONS);
    expect(after.cache).toBe("miss");
    expect(after.results).toHaveLength(1);
    expect(after.results[0].file).toBe(path.join(root, "a.ts"));
  });

  it("does not grow past its entry cap", async () => {
    // Every distinct query is a distinct cache entry; the cache must evict rather than
    // accumulate without bound. No assertion on the exact eviction order — only that the
    // oldest entry is dropped once the cap is reached.
    for (let i = 0; i < 40; i++) {
      await search.searchWorkspace(root, `q${i}`, OPTIONS);
    }
    const again = await search.searchWorkspace(root, "q0", OPTIONS);
    expect(again.cache).toBe("miss");
    const recent = await search.searchWorkspace(root, "q39", OPTIONS);
    expect(recent.cache).toBe("hit");
  });
});

import { describe, expect, it } from "vitest";
import { CACHEABLE_INPUT_TOKENS, UNCACHED_AFTER_TURNS, createPromptCacheReads } from "./prompt-cache-reads.ts";

describe("prompt cache reads", () => {
  it("marks an engine uncached after enough sizable turns read nothing from cache, and clears it on one read", () => {
    const reads = createPromptCacheReads();
    for (let turn = 1; turn < UNCACHED_AFTER_TURNS; turn++) reads.record("groq", 20_000, 0);
    expect(reads.uncached("groq")).toBe(false);
    reads.record("groq", 20_000, undefined);
    expect(reads.uncached("groq")).toBe(true);
    reads.record("groq", 20_000, 0);
    expect(reads.uncached("groq")).toBe(true);
    reads.record("groq", 20_000, 12_000);
    expect(reads.uncached("groq")).toBe(false);
  });

  it("ignores turns too small for any provider to cache, and keeps engines apart", () => {
    const reads = createPromptCacheReads();
    for (let turn = 0; turn < UNCACHED_AFTER_TURNS * 2; turn++) reads.record("small", CACHEABLE_INPUT_TOKENS - 1, 0);
    expect(reads.uncached("small")).toBe(false);
    for (let turn = 0; turn < UNCACHED_AFTER_TURNS; turn++) reads.record("groq", 20_000, 0);
    expect(reads.uncached("groq")).toBe(true);
    expect(reads.uncached("openrouter")).toBe(false);
  });
});

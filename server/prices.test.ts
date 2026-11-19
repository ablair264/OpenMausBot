import { describe, expect, it } from "vitest";

import { billableFor, priceFor } from "./prices.ts";

const driverPrice = { inputPerMillion: 1, outputPerMillion: 2 };
const modelPrice = { inputPerMillion: 3, outputPerMillion: 4 };
const defaultPrice = { inputPerMillion: 5, outputPerMillion: 6 };

describe("priceFor", () => {
  it("keeps the driver/model -> model -> default precedence", () => {
    const prices = { "openai/gpt": driverPrice, gpt: modelPrice, default: defaultPrice };
    expect(priceFor({ driverKind: "openai", model: "gpt" }, prices)).toEqual(driverPrice);
    expect(priceFor({ driverKind: "else", model: "gpt" }, prices)).toEqual(modelPrice);
    expect(priceFor({ driverKind: "else", model: "unknown" }, prices)).toEqual(defaultPrice);
    expect(priceFor({ driverKind: "else", model: "unknown" }, {})).toBeNull();
  });

  it("never returns an Object.prototype member as a price", () => {
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(priceFor({ driverKind: "openai", model: key }, {})).toBeNull();
    }
  });

  it("billing stays null instead of producing NaN for a prototype key", () => {
    expect(billableFor({ driverKind: "openai", model: "toString", input: 100, output: 10 }, {})).toBeNull();
  });
});

describe("cache writes", () => {
  const price = { inputPerMillion: 2, cachedInputPerMillion: 0.2, cacheWritePerMillion: 2.5, outputPerMillion: 10 };

  it("bills the part of input written to the prompt cache at its own rate", () => {
    const turn = { driverKind: "claudeAgent", model: "m", input: 1_000_000, cachedInput: 600_000, cacheWrite: 300_000, output: 0 };
    expect(billableFor(turn, { m: price })).toBeCloseTo(100_000 * 2 / 1e6 + 600_000 * 0.2 / 1e6 + 300_000 * 2.5 / 1e6);
  });

  it("bills a write as fresh input where no write rate is set, and never more writes than input left", () => {
    const { cacheWritePerMillion: _, ...plain } = price;
    const turn = { driverKind: "x", model: "m", input: 1_000, cachedInput: 400, cacheWrite: 5_000, output: 0 };
    expect(billableFor(turn, { m: plain })).toBeCloseTo((600 * 2 + 400 * 0.2) / 1e6);
    expect(billableFor(turn, { m: price })).toBeCloseTo((600 * 2.5 + 400 * 0.2) / 1e6);
  });
});

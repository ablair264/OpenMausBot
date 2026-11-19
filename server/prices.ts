// The operator's own sell prices, never a vendor rate card.
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  /** Absent: a cache write costs what fresh input does. */
  cacheWritePerMillion?: number;
}

/** Keyed by `driver/model`, by model id, or `default`. */
export type PriceList = Record<string, ModelPrice>;

export interface PricedTurn {
  driverKind: string;
  model: string;
  input: number;
  output: number;
  cachedInput?: number;
  /** Of `input`, the tokens written to the prompt cache. */
  cacheWrite?: number;
}

export function priceFor(turn: Pick<PricedTurn, "driverKind" | "model">, prices: PriceList): ModelPrice | null {
  const driverKey = `${turn.driverKind}/${turn.model}`;
  const forDriver = Object.hasOwn(prices, driverKey) ? prices[driverKey] : undefined;
  const forModel = Object.hasOwn(prices, turn.model) ? prices[turn.model] : undefined;
  const fallback = Object.hasOwn(prices, "default") ? prices.default : undefined;
  return forDriver ?? forModel ?? fallback ?? null;
}

const clean = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0);

export function billableFor(turn: PricedTurn, prices: PriceList): number | null {
  const price = priceFor(turn, prices);
  if (!price) return null;
  const input = clean(turn.input);
  const cached = Math.min(clean(turn.cachedInput), input);
  const written = Math.min(clean(turn.cacheWrite), input - cached);
  const fresh = input - cached - written;
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion;
  const writeRate = price.cacheWritePerMillion ?? price.inputPerMillion;
  return (fresh * price.inputPerMillion + cached * cachedRate + written * writeRate + clean(turn.output) * price.outputPerMillion) / 1_000_000;
}

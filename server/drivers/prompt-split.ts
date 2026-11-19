// The stable/volatile system-prompt split: the stable half stays byte-identical for a provider's
// cached prefix; a changed volatile half rides inside the turn that changed it.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SendTurnInput } from "../contracts.ts";

export interface PromptHalves {
  stable: string | null;
  volatile: string;
}

export function promptHalves(
  turn: Pick<SendTurnInput, "system" | "systemStable" | "systemVolatile">,
): PromptHalves {
  const { systemStable, systemVolatile } = turn;
  if (typeof systemStable !== "string" || typeof systemVolatile !== "string") {
    return { stable: null, volatile: "" };
  }
  return { stable: systemStable, volatile: systemVolatile };
}

export const VOLATILE_CONTEXT_NOTE_PREFIX =
  "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:";

export const VOLATILE_CONTEXT_CLEARED_NOTE =
  "The OpenMausBot context notes from earlier in this conversation have been cleared; the standing instructions still apply.";

export function volatileContextNote(volatile: string, hadVolatile: boolean): string {
  const text = volatile.trim();
  if (text) return VOLATILE_CONTEXT_NOTE_PREFIX + "\n\n" + text;
  return hadVolatile ? VOLATILE_CONTEXT_CLEARED_NOTE : "";
}

export function withContextNote(note: string, text: string): string {
  if (!note) return text;
  return text ? note + "\n\n" + text : note;
}

export interface PromptSplitReceipt {
  stable: string;
  volatile: string;
  turnsSinceFull?: number;
  lastUsed?: number;
  peakUsed?: number;
  held?: VolatileHeld;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** One section of the volatile half, as SendTurnInput.systemVolatileParts carries it. */
export interface VolatilePart {
  id: string;
  label: string;
  text: string;
}

/** What a session was last handed of each volatile section, by section id. */
export type VolatileHeld = Record<string, { label: string; digest: string }>;

export const MENTIONS_PART_ID = "mentions";

function partsById(parts: readonly VolatilePart[]): VolatilePart[] {
  const merged = new Map<string, VolatilePart>();
  for (const part of parts) {
    if (!part.text.trim()) continue;
    const earlier = merged.get(part.id);
    merged.set(part.id, earlier ? { ...earlier, text: earlier.text + part.text } : part);
  }
  return [...merged.values()];
}

export function volatileHeld(parts: readonly VolatilePart[]): VolatileHeld {
  return Object.fromEntries(partsById(parts).map((part) => [part.id, { label: part.label, digest: digest(part.text) }]));
}

export function parseVolatileHeld(value: unknown): VolatileHeld | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const held: VolatileHeld = {};
  for (const [id, entry] of Object.entries(value)) {
    const { label, digest: text } = (entry ?? {}) as { label?: unknown; digest?: unknown };
    if (typeof label !== "string" || !isDigest(text)) return undefined;
    held[id] = { label, digest: text };
  }
  return held;
}

export const VOLATILE_CHANGES_PREFIX =
  "Some parts of your instructions changed since this session started. Each part below replaces its earlier copy; every part not listed here still holds as it was:";

/** Only the sections that changed, appeared or were cleared since the session was handed `held`; an `always` section goes
 * in unchanged too. Empty when there is nothing to say. */
export function volatileChangeNote(parts: readonly VolatilePart[], held: VolatileHeld, always: ReadonlySet<string> = new Set()): string {
  const current = partsById(parts);
  const changed = current.filter((part) => always.has(part.id) || held[part.id]?.digest !== digest(part.text));
  const present = new Set(current.map((part) => part.id));
  const cleared = Object.entries(held).filter(([id]) => !present.has(id)).map(([, entry]) => entry.label);
  if (!changed.length && !cleared.length) return "";
  return [
    VOLATILE_CHANGES_PREFIX,
    ...changed.map((part) => `[${part.label}]\n${part.text.trim()}`),
    ...cleared.map((label) => `[${label}]\nNo longer applies.`),
  ].join("\n\n");
}

export const mentionParts = (mentionTurn: boolean): ReadonlySet<string> => new Set(mentionTurn ? [MENTIONS_PART_ID] : []);

const EMPTY_FINGERPRINT = digest("");

export function promptSplitFingerprints(stable: string, volatile: string): PromptSplitReceipt {
  return { stable: digest(stable), volatile: digest(volatile) };
}

const receiptPath = (scope: string, key: string) =>
  join(DATA_DIR, "prompt-split", digest(JSON.stringify([scope, key])) + ".json");

export function readPromptSplitReceipt(scope: string, key: string): PromptSplitReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(receiptPath(scope, key), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { stable?: unknown; volatile?: unknown; turnsSinceFull?: unknown; lastUsed?: unknown; peakUsed?: unknown; held?: unknown };
      if (typeof record.stable === "string" && typeof record.volatile === "string") {
        const held = parseVolatileHeld(record.held);
        return {
          stable: record.stable,
          volatile: record.volatile,
          ...(typeof record.turnsSinceFull === "number" ? { turnsSinceFull: record.turnsSinceFull } : {}),
          ...(typeof record.lastUsed === "number" && record.lastUsed > 0 ? { lastUsed: record.lastUsed } : {}),
          ...(typeof record.peakUsed === "number" && record.peakUsed > 0 ? { peakUsed: record.peakUsed } : {}),
          ...(held ? { held } : {}),
        };
      }
    }
  } catch {}
  return null;
}

export function writePromptSplitReceipt(scope: string, key: string, receipt: PromptSplitReceipt): void {
  mkdirSync(join(DATA_DIR, "prompt-split"), { recursive: true });
  writeFileAtomic(receiptPath(scope, key), JSON.stringify(receipt), { mode: 0o600 });
}

export function deletePromptSplitReceipt(scope: string, key: string): void {
  try {
    rmSync(receiptPath(scope, key));
  } catch {}
}

/** reAnchorAfterTurns re-sends the full prompt after that many bare turns, for history rewrites no event reports; a session
 * whose engine reports its context size is not re-anchored, since a compaction shows as that size collapsing. With `parts`,
 * a changed volatile half rides as only the sections that changed. */
export function splitSessionPrompt(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  fullSystem: string | undefined,
  text: string,
  perTurnVolatile = false,
  reAnchorAfterTurns = 0,
  parts?: readonly VolatilePart[],
): { text: string; receipt: PromptSplitReceipt } {
  const fingerprints = promptSplitFingerprints(stable, volatile);
  const held = parts ? { held: volatileHeld(parts) } : {};
  const turnsSinceFull = typeof previous?.turnsSinceFull === "number" ? previous.turnsSinceFull : 0;
  const measured = previous?.lastUsed !== undefined || previous?.peakUsed !== undefined;
  const reAnchor = reAnchorAfterTurns > 0 && previous !== null && !measured && turnsSinceFull >= reAnchorAfterTurns;
  if (previous === null || previous.stable !== fingerprints.stable || reAnchor) {
    return { text: fullSystem ? fullSystem + "\n\n" + text : text, receipt: { ...fingerprints, turnsSinceFull: 0, ...held } };
  }
  const note = parts && previous.held
    ? volatileChangeNote(parts, previous.held, mentionParts(perTurnVolatile))
    : previous.volatile === fingerprints.volatile && !perTurnVolatile
      ? ""
      : volatileContextNote(volatile, previous.volatile !== EMPTY_FINGERPRINT);
  return { text: withContextNote(note, text), receipt: { ...fingerprints, turnsSinceFull: turnsSinceFull + 1, ...held } };
}

/** The stable half a per-thread process is keyed on: without the team roster (`systemRoster`), which a warm process takes
 * as a note (withRosterNote) when it changes, so adding, renaming or removing a bot relaunches no engine. */
export function keyedStable(turn: Pick<SendTurnInput, "systemStable" | "systemRoster">): string | undefined {
  const { systemStable: stable, systemRoster: roster } = turn;
  return stable !== undefined && roster ? stable.replace(roster, "") : stable;
}

/** The team roster as it is now, before `text`, when it differs from what the process last had (`had`). */
export function withRosterNote(text: string, roster: string, had: string): string {
  if (roster === had) return text;
  const note = `<system-reminder>\n${roster.trim() ? `The team roster changed since this session started. It replaces the roster in your instructions:\n\n${roster.trim()}` : "The team roster in your instructions is out of date: it has no members now."}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}

/** The volatile half as a reminder in a Claude turn, by the CLI's own out-of-band convention: on a
 * live session when it changed, and in a new process's first message (`launch`), so the launched
 * system prompt is the stable half alone and a relaunch keeps a prefix the provider already cached. */
export function withVolatileNote(text: string, volatile: string, launch = false): string {
  const body = !volatile.trim()
    ? "The notes that were in your instructions when this session started have been cleared."
    : launch
      ? `This part of your instructions changes from turn to turn, so it arrives here instead of in the system prompt. It replaces any earlier copy:\n\n${volatile.trim()}`
      : `This part of your instructions changed since this session started. It replaces the earlier copy:\n\n${volatile.trim()}`;
  return withSystemReminder(body, text);
}

/** A volatileChangeNote as a reminder in a Claude turn. */
export function withVolatileChanges(text: string, note: string): string {
  return note ? withSystemReminder(note, text) : text;
}

function withSystemReminder(body: string, text: string): string {
  const note = `<system-reminder>\n${body}\n</system-reminder>`;
  return text ? `${note}\n\n${text}` : note;
}

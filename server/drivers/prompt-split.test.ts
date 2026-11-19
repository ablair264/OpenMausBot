import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deletePromptSplitReceipt,
  promptHalves,
  promptSplitFingerprints,
  readPromptSplitReceipt,
  splitSessionPrompt,
  volatileChangeNote,
  volatileContextNote,
  volatileHeld,
  withContextNote,
  writePromptSplitReceipt,
} from "./prompt-split.ts";
import type { PromptSplitReceipt, VolatilePart } from "./prompt-split.ts";

const MEMORY = { id: "memory", label: "Memory", text: "\nMemory: lives in Toronto." };
const AVAILABILITY = { id: "availability", label: "Team availability", text: "\nAda is idle." };
const MENTIONS = { id: "mentions", label: "Mentions", text: "Tagged: @Testy" };
const joined = (parts: VolatilePart[]) => parts.map((part) => part.text).join("");

describe("promptHalves", () => {
  it("reads the split only when a turn carries both halves", () => {
    expect(promptHalves({ system: "all", systemStable: "keep", systemVolatile: "swap" })).toEqual({
      stable: "keep",
      volatile: "swap",
    });
    expect(promptHalves({ system: "all" })).toEqual({ stable: null, volatile: "" });
    expect(promptHalves({ system: "all", systemStable: "keep" })).toEqual({ stable: null, volatile: "" });
    expect(promptHalves({ system: "all", systemVolatile: "swap" })).toEqual({ stable: null, volatile: "" });
  });
});

describe("volatileContextNote", () => {
  it("labels the current copy, announces a clearing, and stays quiet for never-set halves", () => {
    expect(volatileContextNote("Memory: likes quiet hours.", false))
      .toBe("Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nMemory: likes quiet hours.");
    expect(volatileContextNote("  ", true)).toContain("have been cleared");
    expect(volatileContextNote("", false)).toBe("");
  });
});

describe("withContextNote", () => {
  it("prepends the note, keeps bare text bare, and passes through empty notes", () => {
    expect(withContextNote("note", "text")).toBe("note\n\ntext");
    expect(withContextNote("note", "")).toBe("note");
    expect(withContextNote("", "text")).toBe("text");
  });
});

describe("prompt-split receipts", () => {
  it("round-trips the halves a native session last carried", () => {
    const scope = "test-driver";
    const key = randomUUID();
    expect(readPromptSplitReceipt(scope, key)).toBeNull();
    const receipt = promptSplitFingerprints("stable rules", "memory");
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    expect(readPromptSplitReceipt(scope, randomUUID())).toBeNull();
  });

  it("round-trips the re-anchor turn counter and drops receipts on demand", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), turnsSinceFull: 4 };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    deletePromptSplitReceipt(scope, key);
    expect(readPromptSplitReceipt(scope, key)).toBeNull();
    deletePromptSplitReceipt(scope, key);
    deletePromptSplitReceipt(scope, randomUUID());
  });

  it("round-trips the last reported context size and drops invalid values", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), lastUsed: 167218 };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    for (const invalid of [0, -4096, "167218", null, undefined]) {
      writePromptSplitReceipt(scope, key, { ...receipt, lastUsed: invalid } as unknown as PromptSplitReceipt);
      expect(readPromptSplitReceipt(scope, key)?.lastUsed).toBeUndefined();
    }
    deletePromptSplitReceipt(scope, key);
  });

  it("retains the context high-water mark separately from the final report", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), lastUsed: 75000, peakUsed: 100000 };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    for (const invalid of [0, -4096, "100000", null, undefined]) {
      writePromptSplitReceipt(scope, key, { ...receipt, peakUsed: invalid } as unknown as PromptSplitReceipt);
      expect(readPromptSplitReceipt(scope, key)?.peakUsed).toBeUndefined();
    }
    deletePromptSplitReceipt(scope, key);
  });
});

describe("splitSessionPrompt", () => {
  const fullSystem = "stable rules.\n\nmemory";

  it("delivers the full prompt to an untracked session, then sends later turns bare", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    expect(first.text).toBe(fullSystem + "\n\nfirst");
    const second = splitSessionPrompt("stable rules.", "memory", first.receipt, fullSystem, "second");
    expect(second.text).toBe("second");
  });

  it("rides a changed volatile half as a labelled note", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    const second = splitSessionPrompt("stable rules.", "moved to Toronto", first.receipt, fullSystem, "second");
    expect(second.text).toBe(
      "Context from OpenMausBot updated since this conversation started; it replaces any earlier copy:\n\nmoved to Toronto\n\nsecond",
    );
  });

  it("announces a cleared volatile half once", () => {
    const first = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    const cleared = splitSessionPrompt("stable rules.", "", first.receipt, fullSystem, "cleared");
    expect(cleared.text).toContain("have been cleared");
    const still = splitSessionPrompt("stable rules.", "", cleared.receipt, fullSystem, "still");
    expect(still.text).toBe("still");
  });

  it("redelivers an unchanged volatile half on a turn that carries its own mention context", () => {
    const first = splitSessionPrompt("stable rules.", "Tagged: @Testy", null, fullSystem, "first");
    const untagged = splitSessionPrompt("stable rules.", "Tagged: @Testy", first.receipt, fullSystem, "untagged");
    expect(untagged.text).toBe("untagged");
    const tagged = splitSessionPrompt("stable rules.", "Tagged: @Testy", first.receipt, fullSystem, "tagged", true);
    expect(tagged.text).toContain("replaces any earlier copy");
    expect(tagged.text).toContain("Tagged: @Testy");
    expect(tagged.text.endsWith("tagged")).toBe(true);
  });

  it("re-delivers the full prompt when the stable half changes", () => {
    const first = splitSessionPrompt("old rules.", "memory", null, fullSystem, "first");
    const second = splitSessionPrompt("new rules.", "memory", first.receipt, "new rules.\n\nmemory", "second");
    expect(second.text).toBe("new rules.\n\nmemory\n\nsecond");
  });

  it("re-anchors the full prompt after the requested run of bare turns", () => {
    let state = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first", false, 3);
    expect(state.text).toBe(fullSystem + "\n\nfirst");
    expect(state.receipt.turnsSinceFull).toBe(0);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "second", false, 3);
    expect(state.text).toBe("second");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "third", false, 3);
    expect(state.text).toBe("third");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "fourth", false, 3);
    expect(state.text).toBe("fourth");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "fifth", false, 3);
    expect(state.text).toBe(fullSystem + "\n\nfifth");
    expect(state.receipt.turnsSinceFull).toBe(0);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "sixth", false, 3);
    expect(state.text).toBe("sixth");
  });

  it("never re-anchors unless the caller opts in", () => {
    let state = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first");
    for (let turn = 2; turn <= 20; turn++) {
      state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "turn " + turn);
      expect(state.text).toBe("turn " + turn);
    }
  });

  it("counts a legacy receipt without a turn counter from zero", () => {
    const legacy = promptSplitFingerprints("stable rules.", "memory");
    let state = splitSessionPrompt("stable rules.", "memory", legacy, fullSystem, "first", false, 1);
    expect(state.text).toBe("first");
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "second", false, 1);
    expect(state.text).toBe(fullSystem + "\n\nsecond");
  });
});

describe("volatileChangeNote", () => {
  it("lists only the sections that changed, appeared or were cleared", () => {
    const held = volatileHeld([MEMORY, AVAILABILITY]);
    expect(volatileChangeNote([MEMORY, AVAILABILITY], held)).toBe("");
    const note = volatileChangeNote([MEMORY, { ...AVAILABILITY, text: "\nAda is working." }], held);
    expect(note).toContain("[Team availability]\nAda is working.");
    expect(note).not.toContain("Toronto");
    const cleared = volatileChangeNote([AVAILABILITY], held);
    expect(cleared).toContain("[Memory]\nNo longer applies.");
    expect(cleared).not.toContain("Ada");
    expect(volatileChangeNote([MEMORY, AVAILABILITY, MENTIONS], held)).toContain("[Mentions]\nTagged: @Testy");
  });

  it("repeats an unchanged section it is told to, and treats a blank section as absent", () => {
    const held = volatileHeld([MEMORY, MENTIONS]);
    expect(volatileChangeNote([MEMORY, MENTIONS], held, new Set(["mentions"]))).toContain("Tagged: @Testy");
    expect(volatileChangeNote([MEMORY, MENTIONS], held, new Set(["mentions"]))).not.toContain("Toronto");
    expect(volatileHeld([MEMORY, { ...AVAILABILITY, text: "  " }])).not.toHaveProperty("availability");
  });

  it("reads two sections sharing an id as one", () => {
    const first = { id: "device-place", label: "Where the person is", text: "On their phone." };
    const second = { id: "device-place", label: "Where the person is", text: " Driving." };
    const held = volatileHeld([first, second]);
    expect(volatileChangeNote([first, second], held)).toBe("");
    expect(volatileChangeNote([first, { ...second, text: " Parked." }], held)).toContain("On their phone. Parked.");
  });
});

describe("splitSessionPrompt with sections", () => {
  const fullSystem = "stable rules." + joined([MEMORY, AVAILABILITY]);

  it("sends a later turn only the sections that changed", () => {
    const first = splitSessionPrompt("stable rules.", joined([MEMORY, AVAILABILITY]), null, fullSystem, "first", false, 0, [MEMORY, AVAILABILITY]);
    expect(first.text).toBe(fullSystem + "\n\nfirst");
    const busy = { ...AVAILABILITY, text: "\nAda is working." };
    const second = splitSessionPrompt("stable rules.", joined([MEMORY, busy]), first.receipt, fullSystem, "second", false, 0, [MEMORY, busy]);
    expect(second.text).toContain("[Team availability]\nAda is working.");
    expect(second.text).not.toContain("Toronto");
    expect(second.text.endsWith("\n\nsecond")).toBe(true);
    const third = splitSessionPrompt("stable rules.", joined([MEMORY, busy]), second.receipt, fullSystem, "third", false, 0, [MEMORY, busy]);
    expect(third.text).toBe("third");
  });

  it("repeats only the mentions section on a tagged turn", () => {
    const first = splitSessionPrompt("stable rules.", joined([MEMORY, MENTIONS]), null, fullSystem, "first", false, 0, [MEMORY, MENTIONS]);
    const tagged = splitSessionPrompt("stable rules.", joined([MEMORY, MENTIONS]), first.receipt, fullSystem, "tagged", true, 0, [MEMORY, MENTIONS]);
    expect(tagged.text).toContain("Tagged: @Testy");
    expect(tagged.text).not.toContain("Toronto");
  });

  it("falls back to the whole half for a receipt written before sections were kept", () => {
    const legacy = promptSplitFingerprints("stable rules.", joined([MEMORY]));
    const busy = splitSessionPrompt("stable rules.", joined([MEMORY, AVAILABILITY]), legacy, fullSystem, "next", false, 0, [MEMORY, AVAILABILITY]);
    expect(busy.text).toContain("replaces any earlier copy");
    expect(busy.text).toContain("Toronto");
    expect(busy.receipt.held).toEqual(volatileHeld([MEMORY, AVAILABILITY]));
  });

  it("keeps the sections a receipt holds across a write and a read", () => {
    const scope = "test-driver";
    const key = randomUUID();
    const receipt = { ...promptSplitFingerprints("stable rules", "memory"), held: volatileHeld([MEMORY]) };
    writePromptSplitReceipt(scope, key, receipt);
    expect(readPromptSplitReceipt(scope, key)).toEqual(receipt);
    writePromptSplitReceipt(scope, key, { ...receipt, held: { memory: { label: "Memory", digest: "not a digest" } } });
    expect(readPromptSplitReceipt(scope, key)?.held).toBeUndefined();
    deletePromptSplitReceipt(scope, key);
  });
});

describe("re-anchoring a session that reports its context size", () => {
  const fullSystem = "stable rules.\n\nmemory";

  it("never re-anchors once the engine has reported usage, since a compaction shows as a collapse", () => {
    let state = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first", false, 2);
    for (let turn = 2; turn <= 10; turn++) {
      state = splitSessionPrompt("stable rules.", "memory", { ...state.receipt, lastUsed: 40_000 }, fullSystem, "turn " + turn, false, 2);
      expect(state.text).toBe("turn " + turn);
    }
  });

  it("still re-anchors an engine that never reports usage", () => {
    let state = splitSessionPrompt("stable rules.", "memory", null, fullSystem, "first", false, 2);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "second", false, 2);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "third", false, 2);
    state = splitSessionPrompt("stable rules.", "memory", state.receipt, fullSystem, "fourth", false, 2);
    expect(state.text).toBe(fullSystem + "\n\nfourth");
  });
});

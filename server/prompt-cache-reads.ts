/** Calls this large are cached by every provider that caches at all (OpenAI's floor is 1,024 tokens). */
export const CACHEABLE_INPUT_TOKENS = 4_096;
/** Sizable turns in a row with no cache read before an engine instance counts as one whose provider never caches. */
export const UNCACHED_AFTER_TURNS = 3;
const INSTANCES_MAX = 500;

/** Per engine instance: whether its provider has shown it reads nothing from a prompt cache. One cache read clears it. */
export function createPromptCacheReads() {
  const misses = new Map<string, number>();
  return {
    record(instanceId: string, input: number | undefined, cachedInput: number | undefined): void {
      if ((cachedInput ?? 0) > 0) {
        misses.delete(instanceId);
        return;
      }
      if ((input ?? 0) < CACHEABLE_INPUT_TOKENS) return;
      const count = Math.min(UNCACHED_AFTER_TURNS, (misses.get(instanceId) ?? 0) + 1);
      misses.delete(instanceId);
      misses.set(instanceId, count);
      if (misses.size > INSTANCES_MAX) misses.delete(misses.keys().next().value!);
    },
    uncached(instanceId: string): boolean {
      return (misses.get(instanceId) ?? 0) >= UNCACHED_AFTER_TURNS;
    },
  };
}

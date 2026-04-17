/**
 * MembershipProvider — pluggable authorization check for brain envelopes.
 *
 * Given an authenticated author address (recovered by signing.verifyBrainChange),
 * this adapter answers: "is this author allowed to write to brain docs?"
 *
 * AUTHENTICATION (sig → author) lives in signing.ts and is fixed by the
 * wire format. AUTHORIZATION is policy — fleets can plug in arbitrary
 * backends:
 *
 *   - POP/Argus: on-chain Hats contract + static JSON fallback
 *     (ships as a sibling @unified-ai-brain/allowlist-pop package)
 *   - Non-POP fleet: Discord role, passkey binding, ENS ownership,
 *     SAFE-signer set, etc.
 *   - Tests / batch jobs: createStaticAllowlist(["0xabc...", ...])
 *
 * Core ships only the synchronous / static impls. Network-backed impls
 * (Hats, ENS resolver, etc.) live in sibling packages so core stays
 * dependency-light.
 *
 * CASE NORMALIZATION: addresses are normalized to lowercase for
 * comparison. Implementers MUST return true for equivalent addresses
 * regardless of input casing.
 */

import { readFileSync, existsSync } from 'fs';

/**
 * Pluggable authorization check. `isAllowed` is the only required method.
 * Optional helpers aid doctor/diagnostics but are not required for the
 * hot path.
 */
export interface MembershipProvider {
  /**
   * @param author Recovered EOA address (any case).
   * @returns true if the author is authorized to write brain envelopes.
   *
   * MUST NOT throw on a well-formed address — return false instead. The
   * caller treats errors as transport-level, not authorization outcomes.
   */
  isAllowed(author: string): Promise<boolean>;

  /** Optional: enumerate all allowed addresses. Used by doctor / diagnostic UIs. */
  list?(): Promise<string[]>;

  /** Optional: subscribe to membership changes. Returns unsubscribe function. */
  subscribeChanges?(onChange: () => void): () => void;
}

// ────────────────────────────────────────────────────────────
// Static allowlist (core default)
// ────────────────────────────────────────────────────────────

/**
 * Static in-memory allowlist. Addresses are frozen at construction time.
 * Use this for tests, CLI scripts, or fleets where membership changes
 * rarely enough to hardcode at startup.
 *
 * Input addresses are lowercased and deduplicated. Case-insensitive
 * comparison on isAllowed().
 */
export function createStaticAllowlist(addresses: readonly string[]): MembershipProvider {
  const normalized = new Set(
    addresses
      .filter(a => typeof a === 'string' && a.length > 0)
      .map(a => a.toLowerCase()),
  );
  return {
    async isAllowed(author: string): Promise<boolean> {
      if (typeof author !== 'string') return false;
      return normalized.has(author.toLowerCase());
    },
    async list(): Promise<string[]> {
      return [...normalized];
    },
  };
}

/**
 * File-backed static allowlist. Reads a JSON file of the form:
 *   [{ "address": "0x...", "name"?: string, ... }]
 *   or { "entries": [...same...] }
 *
 * File is read at construction time; later edits are NOT observed
 * unless the fleet provides a filesystem watcher via subscribeChanges
 * (left as future work — consumers can wrap this with their own).
 *
 * If the file is missing or malformed, returns an empty allowlist
 * (silently — log at the caller if strictness is required).
 */
export function createStaticAllowlistFromFile(path: string): MembershipProvider {
  if (!existsSync(path)) {
    return createStaticAllowlist([]);
  }
  let list: any[] = [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    list = Array.isArray(raw) ? raw : (raw?.entries ?? []);
  } catch {
    list = [];
  }
  const addresses = list
    .map(e => (typeof e === 'string' ? e : e?.address))
    .filter((a): a is string => typeof a === 'string' && a.length > 0);
  return createStaticAllowlist(addresses);
}

/**
 * Compose two MembershipProviders: author is allowed if EITHER one
 * allows them. Useful for "dynamic (on-chain) with static fallback"
 * patterns — wrap the on-chain provider as the primary and a static
 * allowlist as the emergency override.
 */
export function createUnionProvider(
  primary: MembershipProvider,
  secondary: MembershipProvider,
): MembershipProvider {
  return {
    async isAllowed(author: string): Promise<boolean> {
      const a = await primary.isAllowed(author);
      if (a) return true;
      return secondary.isAllowed(author);
    },
    async list(): Promise<string[]> {
      const [p, s] = await Promise.all([
        primary.list?.() ?? Promise.resolve([]),
        secondary.list?.() ?? Promise.resolve([]),
      ]);
      return Array.from(new Set([...p, ...s].map(a => a.toLowerCase())));
    },
  };
}

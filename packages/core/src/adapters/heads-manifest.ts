/**
 * HeadsManifestStore — pluggable storage for the per-doc heads frontier.
 *
 * The "heads manifest" is the mapping { docId → CID[] } where each CID is
 * a head of the doc's Merkle DAG on this peer. A concurrent writer can
 * produce multiple heads; T4 (task #432) moved the on-disk format from
 * `Record<string,string>` (v1, single head) to `Record<string,string[]>`
 * (v2, frontier) so the daemon can track and broadcast all of them.
 *
 * Two default impls:
 *   - createFilesystemStore(brainHome) — the production impl. Atomic
 *     writes via POSIX rename. Reads v2 first, falls back to v1 wrapped
 *     in single-element arrays (handles agents with only legacy state).
 *   - createMemoryStore() — in-memory. For tests and batch jobs that
 *     don't want persistence.
 *
 * Browser fleets can plug IndexedDB; multi-agent-single-replica fleets
 * can plug S3. Interface is intentionally minimal (2 methods) so adapter
 * surface stays stable across core refactors.
 *
 * ATOMICITY CONTRACT: implementers MUST ensure concurrent readers never
 * see a truncated manifest. Interleaved reads during a save() should
 * observe either the old full state or the new full state — never a
 * partial one. The filesystem impl achieves this via write-tmp + rename.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * Pluggable storage for the heads manifest. Two methods, no more.
 */
export interface HeadsManifestStore {
  load(): Promise<Record<string, string[]>>;
  save(manifest: Record<string, string[]>): Promise<void>;
}

// ────────────────────────────────────────────────────────────
// Filesystem store (production default)
// ────────────────────────────────────────────────────────────

export interface FilesystemStoreOptions {
  /** Filename for the v2 manifest. Default: `doc-heads-v2.json`. */
  v2Filename?: string;
  /**
   * Legacy v1 filename — read-only fallback for agents who have not yet
   * written v2. Default: `doc-heads.json`. Pass `null` to disable v1
   * fallback entirely (fresh installs with no legacy state).
   */
  v1Filename?: string | null;
}

/**
 * Default filesystem-backed HeadsManifestStore reading from `<brainHome>/<v2Filename>`.
 *
 * Read semantics:
 *   1. If v2 exists and parses, return its contents (defensively coercing
 *      any stray scalar values to single-element arrays).
 *   2. If v2 missing or corrupt, fall back to v1 and wrap each scalar CID
 *      in a single-element array (one-way migration on read; writes only
 *      go to v2). Skipped if v1 fallback was disabled.
 *   3. If neither, return {}.
 *
 * Write semantics: atomic. Writes to `<path>.tmp.<pid>.<now>`, then rename
 * to `<path>`. Concurrent readers never see a truncated file — they see
 * either the old full state or the new full state.
 */
export function createFilesystemStore(
  brainHome: string,
  opts: FilesystemStoreOptions = {},
): HeadsManifestStore {
  const v2Filename = opts.v2Filename ?? 'doc-heads-v2.json';
  const v1Filename = opts.v1Filename === undefined ? 'doc-heads.json' : opts.v1Filename;

  const v2Path = () => join(brainHome, v2Filename);
  const v1Path = () => v1Filename ? join(brainHome, v1Filename) : null;

  return {
    async load(): Promise<Record<string, string[]>> {
      const p2 = v2Path();
      if (existsSync(p2)) {
        try {
          const raw = JSON.parse(readFileSync(p2, 'utf8'));
          const out: Record<string, string[]> = {};
          for (const [docId, value] of Object.entries(raw)) {
            if (Array.isArray(value)) {
              out[docId] = value.filter((x): x is string => typeof x === 'string');
            } else if (typeof value === 'string') {
              out[docId] = [value];
            }
          }
          return out;
        } catch {
          // fall through to v1
        }
      }
      const p1 = v1Path();
      if (p1 && existsSync(p1)) {
        try {
          const raw = JSON.parse(readFileSync(p1, 'utf8'));
          const wrapped: Record<string, string[]> = {};
          for (const [docId, cid] of Object.entries(raw)) {
            if (typeof cid === 'string') wrapped[docId] = [cid];
          }
          return wrapped;
        } catch {
          return {};
        }
      }
      return {};
    },

    async save(manifest: Record<string, string[]>): Promise<void> {
      const finalPath = v2Path();
      const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(manifest, null, 2));
      try {
        renameSync(tmpPath, finalPath);
      } catch (err) {
        try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
        throw err;
      }
    },
  };
}

// ────────────────────────────────────────────────────────────
// Memory store (test / batch default)
// ────────────────────────────────────────────────────────────

/**
 * In-memory HeadsManifestStore. State lives for the lifetime of the
 * returned object — no persistence, no concurrent-process visibility.
 *
 * Load returns a defensive copy so callers mutating the result do not
 * corrupt the store's internal state. Save also stores a copy.
 */
export function createMemoryStore(
  initial: Record<string, string[]> = {},
): HeadsManifestStore {
  let state: Record<string, string[]> = deepCopy(initial);
  return {
    async load(): Promise<Record<string, string[]>> {
      return deepCopy(state);
    },
    async save(manifest: Record<string, string[]>): Promise<void> {
      state = deepCopy(manifest);
    },
  };
}

function deepCopy(m: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(m)) {
    out[k] = [...v];
  }
  return out;
}

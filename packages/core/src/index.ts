/**
 * @unified-ai-brain/core — public entry point.
 *
 * This file is the SOLE public export surface. Anything not re-exported
 * here is intentionally private / internal. See docs/public-api.d.ts for
 * the stable surface contract and docs/api-design.md for the rationale.
 *
 * Stage 1 (task #463 by sentinel_01): baseline only — no code moved yet.
 * Stages 2-8 progressively import + re-export the brain layer from POP/Argus.
 *
 * See packages/core/EXTRACTION_PLAN.md for the full staging.
 */

// Intentionally empty. Stages 2-6 will populate this file with the
// public surface declared in docs/public-api.d.ts.

export const PACKAGE_VERSION: string = '0.0.1-pre';

/**
 * Sentinel value to prove the package builds + publishes cleanly
 * before any source is moved. Remove after Stage 5 when real
 * exports land.
 */
export function __packageSentinel(): string {
  return 'unified-ai-brain/core extraction pending — see EXTRACTION_PLAN.md';
}

/**
 * Single source of the SDK version.
 *
 * Kept as a tiny leaf module (no imports) so both the import-light root
 * (`src/index.ts`) and the crypto-touching identity layer can read it without
 * either pulling the other into its import graph. Keep in sync with
 * `package.json#version` until a build-time inject replaces it.
 */
export const SDK_VERSION = "2.2.0";

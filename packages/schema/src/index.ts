/**
 * @omniproxy/schema — Zod schemas shared across the monorepo.
 *
 * Every type in OmniProxy is inferred from a schema here; nothing is hand-written
 * twice. Provider declarations, the wire protocols and the storage layer all validate
 * against these definitions.
 */

/**
 * Version of the `provider.yaml` contract. Once users author their own provider
 * modules this is a public promise, not an internal detail: the loader supports this
 * version and the previous major one, and migrates between them. See ADR-0003.
 */
export const PROVIDER_SCHEMA_VERSION = 1 as const;

export * from './modality.js';
export * from './capability.js';

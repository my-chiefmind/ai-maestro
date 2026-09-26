/**
 * Supported portfolio registry API: resolved reads plus locked, compare-and-swap, validated,
 * atomic writes to one registry file. See docs/PUBLIC-DATA-API.md.
 */
export { readRegistry, findKitDir, ENTRY_KEYS, STATUSES, KINDS } from "./registry.mjs";
export {
  readRegistryDocument, getRegistryVersion, addRegistryEntry, removeRegistryEntry, setRegistryStatus,
  ABSENT_REGISTRY_VERSION,
  RegistryValidationError, RegistryConflictError, RegistryLockError, RegistryNotFoundError,
} from "./registry-write.mjs";

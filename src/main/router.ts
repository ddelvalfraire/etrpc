import type { RouterDef } from "../shared/types";

/** Identity function that provides type inference for router definitions. */
export function createRouter<T extends RouterDef>(def: T): T {
  return def;
}

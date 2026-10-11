import { createHash } from "node:crypto";

export type JsonPathPart = string | number;

export type JsonDeltaOperation =
  | { op: "set"; path: JsonPathPart[]; value: unknown }
  | { op: "delete"; path: JsonPathPart[] }
  | { op: "append"; path: JsonPathPart[]; values: unknown[] }
  | {
      op: "splice";
      path: JsonPathPart[];
      index: number;
      deleteCount: number;
      items: unknown[];
    };

export type JsonDeltaSchemaVersion = 2 | 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? value : JSON.parse(serialized) as T;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])])
  );
}

export function hostStateHash(state: unknown): string {
  const serialized = JSON.stringify(canonicalJson(state));
  if (serialized === undefined) throw new Error("Cannot hash a non-JSON Host state value.");
  return createHash("sha256").update(serialized).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
    && jsonEqual(left[key], right[key]));
}

function validatePath(path: unknown, operationIndex: number): asserts path is JsonPathPart[] {
  if (!Array.isArray(path) || path.some((part) => (
    typeof part !== "string" && (!Number.isInteger(part) || Number(part) < 0)
  ))) {
    throw new Error(`The persisted YN Host-state delta operation ${operationIndex} contains an invalid path.`);
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateJsonDeltaOperations(
  value: unknown,
  schemaVersion: JsonDeltaSchemaVersion
): asserts value is JsonDeltaOperation[] {
  if (schemaVersion !== 2 && schemaVersion !== 3) {
    throw new Error("The persisted YN Host-state delta has an unsupported schema version.");
  }
  if (!Array.isArray(value)) {
    throw new Error("The persisted YN Host-state delta operations must be an array.");
  }
  for (let index = 0; index < value.length; index += 1) {
    const operation = value[index];
    if (!isRecord(operation) || typeof operation.op !== "string") {
      throw new Error(`The persisted YN Host-state delta operation ${index} is invalid.`);
    }
    validatePath(operation.path, index);
    switch (operation.op) {
      case "set":
        if (!hasOnlyKeys(operation, ["op", "path", "value"]) || !Object.prototype.hasOwnProperty.call(operation, "value")) {
          throw new Error(`The persisted YN Host-state delta set operation ${index} is invalid.`);
        }
        break;
      case "delete":
        if (!hasOnlyKeys(operation, ["op", "path"]) || operation.path.length === 0) {
          throw new Error(`The persisted YN Host-state delta delete operation ${index} is invalid.`);
        }
        break;
      case "append":
        if (schemaVersion < 3) {
          throw new Error("The persisted schema 2 YN Host-state delta contains a schema 3 operation.");
        }
        if (!hasOnlyKeys(operation, ["op", "path", "values"])
          || !Array.isArray(operation.values)
          || operation.values.length === 0) {
          throw new Error(`The persisted YN Host-state delta append operation ${index} is invalid.`);
        }
        break;
      case "splice":
        if (schemaVersion < 3) {
          throw new Error("The persisted schema 2 YN Host-state delta contains a schema 3 operation.");
        }
        if (!hasOnlyKeys(operation, ["op", "path", "index", "deleteCount", "items"])
          || !Number.isInteger(operation.index)
          || Number(operation.index) < 0
          || !Number.isInteger(operation.deleteCount)
          || Number(operation.deleteCount) < 0
          || !Array.isArray(operation.items)
          || (Number(operation.deleteCount) === 0 && operation.items.length === 0)) {
          throw new Error(`The persisted YN Host-state delta splice operation ${index} is invalid.`);
        }
        break;
      default:
        throw new Error(`The persisted YN Host-state delta operation ${index} has an unsupported operation.`);
    }
  }
}

function createJsonDeltaAt(
  previous: unknown,
  current: unknown,
  path: JsonPathPart[],
  operations: JsonDeltaOperation[]
): JsonDeltaOperation[] {
  if (Object.is(previous, current)) return operations;
  if (Array.isArray(previous) && Array.isArray(current)) {
    if (previous.length !== current.length) {
      let prefix = 0;
      while (prefix < previous.length && prefix < current.length
        && jsonEqual(previous[prefix], current[prefix])) {
        prefix += 1;
      }
      let suffix = 0;
      while (suffix < previous.length - prefix && suffix < current.length - prefix
        && jsonEqual(previous[previous.length - suffix - 1], current[current.length - suffix - 1])) {
        suffix += 1;
      }
      const insertions = current.slice(prefix, current.length - suffix);
      if (prefix === previous.length && suffix === 0) {
        operations.push({ op: "append", path, values: cloneJson(insertions) });
      } else {
        operations.push({
          op: "splice",
          path,
          index: prefix,
          deleteCount: previous.length - prefix - suffix,
          items: cloneJson(insertions)
        });
      }
      return operations;
    }
    for (let index = 0; index < current.length; index += 1) {
      createJsonDeltaAt(previous[index], current[index], [...path, index], operations);
    }
    return operations;
  }
  if (isRecord(previous) && isRecord(current)) {
    for (const key of Object.keys(previous)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        operations.push({ op: "delete", path: [...path, key] });
      }
    }
    for (const key of Object.keys(current)) {
      if (!Object.prototype.hasOwnProperty.call(previous, key)) {
        operations.push({ op: "set", path: [...path, key], value: cloneJson(current[key]) });
      } else {
        createJsonDeltaAt(previous[key], current[key], [...path, key], operations);
      }
    }
    return operations;
  }
  operations.push({ op: "set", path, value: cloneJson(current) });
  return operations;
}

export function createJsonDelta(previous: unknown, current: unknown): JsonDeltaOperation[] {
  return createJsonDeltaAt(previous, current, [], []);
}

function resolveExistingPath(root: unknown, path: JsonPathPart[], operationIndex: number): unknown {
  let current = root;
  for (const part of path) {
    if (Array.isArray(current) && typeof part === "number") {
      if (part >= current.length) {
        throw new Error(`The persisted YN Host-state delta operation ${operationIndex} path does not exist in its checkpoint.`);
      }
      current = current[part];
      continue;
    }
    if (isRecord(current) && typeof part === "string" && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
      continue;
    }
    throw new Error(`The persisted YN Host-state delta operation ${operationIndex} path does not exist in its checkpoint.`);
  }
  return current;
}

export function applyJsonDelta<T>(
  base: T,
  operations: unknown,
  schemaVersion: JsonDeltaSchemaVersion = 3
): T {
  return applyDelta(base,operations,schemaVersion,false);
}

/** Only for historical bytes already certified by an exact published source digest. */
export function applyJsonDeltaInPlace<T>(base: T, operations: unknown, schemaVersion: JsonDeltaSchemaVersion = 3): T {
  return applyDelta(base,operations,schemaVersion,true);
}

function applyDelta<T>(base: T, operations: unknown, schemaVersion: JsonDeltaSchemaVersion, mutate: boolean): T {
  validateJsonDeltaOperations(operations, schemaVersion);
  let root: unknown = mutate ? base : cloneJson(base);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.path.length === 0) {
      if (operation.op === "set") {
        root = cloneJson(operation.value);
        continue;
      }
      if (operation.op === "append" || operation.op === "splice") {
        if (!Array.isArray(root)) {
          throw new Error(`The persisted YN Host-state delta operation ${index} target is not an array.`);
        }
        if (operation.op === "append") {
          for (const value of operation.values) root.push(cloneJson(value));
        } else {
          if (operation.index > root.length || operation.deleteCount > root.length - operation.index) {
            throw new Error(`The persisted YN Host-state delta splice operation ${index} is outside its array.`);
          }
          const inserted = cloneJson(operation.items);
          const tail = root.slice(operation.index + operation.deleteCount);
          root.length = operation.index;
          for (const value of inserted) root.push(value);
          for (const value of tail) root.push(value);
        }
        continue;
      }
      throw new Error("The persisted YN Host-state delta cannot delete its root.");
    }
    const parentPath = operation.path.slice(0, -1);
    const leaf = operation.path.at(-1)!;
    const parent = resolveExistingPath(root, parentPath, index);
    if (operation.op === "append" || operation.op === "splice") {
      const target = resolveExistingPath(root, operation.path, index);
      if (!Array.isArray(target)) {
        throw new Error(`The persisted YN Host-state delta operation ${index} target is not an array.`);
      }
      if (operation.op === "append") {
        for (const value of operation.values) target.push(cloneJson(value));
      } else {
        if (operation.index > target.length || operation.deleteCount > target.length - operation.index) {
          throw new Error(`The persisted YN Host-state delta splice operation ${index} is outside its array.`);
        }
        const inserted = cloneJson(operation.items);
        const tail = target.slice(operation.index + operation.deleteCount);
        target.length = operation.index;
        for (const value of inserted) target.push(value);
        for (const value of tail) target.push(value);
      }
      continue;
    }
    if (Array.isArray(parent) && typeof leaf === "number") {
      if (leaf >= parent.length) {
        throw new Error(`The persisted YN Host-state delta operation ${index} array index is outside its checkpoint.`);
      }
      if (operation.op === "delete") {
        throw new Error("The persisted schema 2 YN Host-state delta cannot delete an array element.");
      }
      parent[leaf] = cloneJson(operation.value);
    } else if (isRecord(parent) && typeof leaf === "string") {
      const exists = Object.prototype.hasOwnProperty.call(parent, leaf);
      if (operation.op === "delete") {
        if (!exists) {
          throw new Error(`The persisted YN Host-state delta delete operation ${index} path does not exist in its checkpoint.`);
        }
        delete parent[leaf];
      } else {
        Object.defineProperty(parent, leaf, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cloneJson(operation.value)
        });
      }
    } else {
      throw new Error(`The persisted YN Host-state delta operation ${index} path does not match its checkpoint.`);
    }
  }
  return root as T;
}

import { posix } from "node:path";
import { ObjectStorageError } from "./object-storage.js";

const WORKSPACE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function invalid(message: string): never {
  throw new ObjectStorageError("invalid_path", message);
}

export function assertWorkspaceId(value: string): string {
  if (!WORKSPACE_ID.test(value)) {
    invalid("Workspace IDs may contain only letters, numbers, underscores, and hyphens.");
  }
  return value;
}

export function assertStoragePath(value: string): string {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) {
    invalid("Object paths must be non-empty, relative, forward-slash paths.");
  }
  if (CONTROL_CHARACTERS.test(value)) invalid("Object paths cannot contain control characters.");

  let decoded = value;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      invalid("Object paths cannot contain malformed percent encoding.");
    }
  }

  if (decoded.includes("\\") || decoded.startsWith("/")) {
    invalid("Object paths cannot contain encoded path separators.");
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    invalid("Object paths cannot contain empty, current-directory, or parent-directory segments.");
  }
  if (posix.normalize(decoded) !== decoded) invalid("Object paths must already be normalised.");
  return value;
}

export function workspaceObjectKey(workspaceId: string, path: string): string {
  return `workspaces/${assertWorkspaceId(workspaceId)}/${assertStoragePath(path)}`;
}

export function encodeObjectKey(key: string): string {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

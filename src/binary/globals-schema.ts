import * as path from "path";
import * as fs from "fs";

export interface GlobalEntry {
  name: string;
  address: string;
  rva: string;
  type: "byte" | "word" | "dword" | "pointer" | "string";
  description: string;
  editable?: boolean;
}

export interface GlobalCategory {
  [categoryName: string]: GlobalEntry[];
}

export interface BinarySchema {
  file: string;
  version: string;
  globals: GlobalCategory;
  patchGroups: Array<{
    name: string;
    description: string;
    dlls: Record<
      string,
      Array<{
        rva: string;
        orig: string;
        patch: string;
        desc: string;
      }>
    >;
  }>;
}

/**
 * Load binary schema from the schemas/binaries directory.
 * Falls back to user schemas in .d2workshop/schemas/binaries/.
 */
export function loadBinarySchema(
  extensionPath: string,
  workspaceRoot: string,
  fileName: string
): BinarySchema | null {
  // Try extension-bundled schema first
  const bundledPath = path.join(
    extensionPath,
    "schemas",
    "binaries",
    `${fileName}.json`
  );

  // Then try workspace schema (community/user additions)
  const workspacePath = path.join(
    workspaceRoot,
    ".d2workshop",
    "schemas",
    "binaries",
    `${fileName}.json`
  );

  for (const schemaPath of [workspacePath, bundledPath]) {
    try {
      if (fs.existsSync(schemaPath)) {
        const content = fs.readFileSync(schemaPath, "utf-8");
        return JSON.parse(content) as BinarySchema;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Merge a user schema with the bundled schema.
 * User schema entries override bundled ones by name.
 */
export function mergeSchemas(
  bundled: BinarySchema,
  user: BinarySchema
): BinarySchema {
  const merged: BinarySchema = {
    ...bundled,
    globals: { ...bundled.globals },
    patchGroups: [...bundled.patchGroups],
  };

  // Merge globals by category
  for (const [category, entries] of Object.entries(user.globals)) {
    if (!merged.globals[category]) {
      merged.globals[category] = [];
    }

    for (const entry of entries) {
      const existingIdx = merged.globals[category].findIndex(
        (e) => e.name === entry.name
      );
      if (existingIdx >= 0) {
        merged.globals[category][existingIdx] = entry;
      } else {
        merged.globals[category].push(entry);
      }
    }
  }

  // Merge patch groups by name
  for (const group of user.patchGroups) {
    const existingIdx = merged.patchGroups.findIndex(
      (g) => g.name === group.name
    );
    if (existingIdx >= 0) {
      merged.patchGroups[existingIdx] = group;
    } else {
      merged.patchGroups.push(group);
    }
  }

  return merged;
}

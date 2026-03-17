import * as fs from "fs";
import * as path from "path";

export interface ColumnSchema {
  type: string;
  description?: string;
  engineVerified?: boolean | string | string[];
  required?: boolean;
}

export interface TxtSchema {
  file: string;
  description: string;
  columns: Record<string, ColumnSchema>;
}

export class SchemaLoader {
  private cache = new Map<string, TxtSchema>();
  private schemasDir: string;
  private workspaceSchemasDir: string | null;

  constructor(schemasDir: string, workspaceSchemasDir?: string) {
    this.schemasDir = schemasDir;
    this.workspaceSchemasDir = workspaceSchemasDir || null;
  }

  loadSchema(fileName: string): TxtSchema | null {
    const baseName = fileName.replace(/\.txt$/i, "").toLowerCase();
    if (this.cache.has(baseName)) {
      return this.cache.get(baseName)!;
    }

    const candidates: string[] = [];

    // Workspace overrides first
    if (this.workspaceSchemasDir) {
      candidates.push(
        path.join(this.workspaceSchemasDir, `${baseName}.schema.json`)
      );
    }

    // Bundled schemas
    candidates.push(
      path.join(this.schemasDir, `${baseName}.schema.json`),
      path.join(this.schemasDir, `${fileName.replace(/\.txt$/i, "")}.schema.json`)
    );

    for (const schemaPath of candidates) {
      try {
        if (fs.existsSync(schemaPath)) {
          const schema: TxtSchema = JSON.parse(
            fs.readFileSync(schemaPath, "utf-8")
          );
          this.cache.set(baseName, schema);
          return schema;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  listSchemas(): Array<{
    file: string;
    description: string;
    columnCount: number;
  }> {
    const results: Array<{
      file: string;
      description: string;
      columnCount: number;
    }> = [];
    if (!fs.existsSync(this.schemasDir)) {
      return results;
    }
    for (const f of fs.readdirSync(this.schemasDir)) {
      if (!f.endsWith(".schema.json") || f.startsWith("_")) {
        continue;
      }
      try {
        const schema: TxtSchema = JSON.parse(
          fs.readFileSync(path.join(this.schemasDir, f), "utf-8")
        );
        results.push({
          file: schema.file || f.replace(".schema.json", ".txt"),
          description: schema.description || "",
          columnCount: Object.keys(schema.columns).length,
        });
      } catch {
        continue;
      }
    }
    return results.sort((a, b) => a.file.localeCompare(b.file));
  }
}

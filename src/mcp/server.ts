import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SchemaLoader } from "./lib/schema-loader";
import {
  readTxtFile,
  writeTxtFile,
  findTxtFiles,
  resolveTxtPath,
} from "./lib/txt-parser";
import * as path from "path";

const workspaceRoot = process.env.D2_WORKSPACE_ROOT || process.cwd();
const schemasDir = process.env.D2_SCHEMAS_DIR || "";
const workspaceSchemasDir = process.env.D2_WORKSPACE_SCHEMAS_DIR;

const schemaLoader = new SchemaLoader(schemasDir, workspaceSchemasDir);

/** Parse a ref string into target file/column pairs */
function parseRef(ref: string): Array<{ file: string; column: string | null }> {
  return ref.split("|").map(part => {
    const slashIdx = part.indexOf("/");
    if (slashIdx === -1) return { file: part.trim(), column: null };
    return {
      file: part.substring(0, slashIdx).trim(),
      column: part.substring(slashIdx + 1).trim() || null,
    };
  });
}

/** Resolve ref column values by reading target .txt files from workspace */
function resolveSchemaRefs(schema: import("./lib/schema-loader").TxtSchema): import("./lib/schema-loader").TxtSchema {
  const enriched = JSON.parse(JSON.stringify(schema));
  const refCache = new Map<string, string[]>();

  for (const [, col] of Object.entries(enriched.columns) as [string, import("./lib/schema-loader").ColumnSchema][]) {
    const refStr = col.ref
      || (col.type === "ref" && (col as any).target
        ? `${(col as any).target}${(col as any).targetColumn ? "/" + (col as any).targetColumn : ""}`
        : null);
    if (!refStr || col.values?.length) continue;

    const parsed = parseRef(refStr);
    const merged = new Set<string>();
    for (const { file, column } of parsed) {
      const cacheKey = `${file}:${column || "*"}`;
      if (refCache.has(cacheKey)) {
        refCache.get(cacheKey)!.forEach(v => merged.add(v));
        continue;
      }
      const filePath = resolveTxtPath(workspaceRoot, file);
      if (!filePath) continue;
      try {
        const table = readTxtFile(filePath);
        const colIdx = column
          ? table.headers.findIndex(h => h.toLowerCase() === column.toLowerCase())
          : 0;
        if (colIdx < 0) continue;
        const vals: string[] = [];
        for (const row of table.rows) {
          const v = row[colIdx]?.trim();
          if (v && v.toLowerCase() !== "expansion") {
            vals.push(v);
            merged.add(v);
          }
        }
        refCache.set(cacheKey, vals);
      } catch { /* skip unreadable files */ }
    }
    if (merged.size > 0) col.values = Array.from(merged).sort();
  }
  return enriched;
}

const server = new McpServer({
  name: "d2-workshop",
  version: "0.1.2",
});

// --- d2_list_schemas ---
server.tool(
  "d2_list_schemas",
  "List all available D2 txt file schemas with descriptions and column counts",
  {},
  async () => {
    const schemas = schemaLoader.listSchemas();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(schemas, null, 2),
        },
      ],
    };
  }
);

// --- d2_get_schema ---
server.tool(
  "d2_get_schema",
  "Get the full schema for a D2 txt file including all column definitions, types, and descriptions",
  {
    fileName: z
      .string()
      .describe("The txt file name (e.g. 'armor.txt' or 'armor')"),
  },
  async ({ fileName }) => {
    const schema = schemaLoader.loadSchema(fileName);
    if (!schema) {
      return {
        content: [{ type: "text", text: `No schema found for '${fileName}'` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(schema, null, 2) }],
    };
  }
);

// --- d2_read_table ---
server.tool(
  "d2_read_table",
  "Read rows from a D2 txt data file with optional column selection and filtering",
  {
    fileName: z.string().describe("The txt file name"),
    columns: z
      .array(z.string())
      .optional()
      .describe("Columns to include (default: all)"),
    filter: z
      .object({
        column: z.string(),
        value: z.string(),
      })
      .optional()
      .describe("Filter rows where column equals value"),
    offset: z.number().optional().default(0).describe("Skip first N rows"),
    limit: z.number().optional().default(50).describe("Max rows to return"),
  },
  async ({ fileName, columns, filter, offset, limit }) => {
    const filePath = resolveTxtPath(workspaceRoot, fileName);
    if (!filePath) {
      return {
        content: [
          {
            type: "text",
            text: `File '${fileName}' not found in ${workspaceRoot}/data/global/excel/`,
          },
        ],
        isError: true,
      };
    }

    const table = readTxtFile(filePath);
    let filteredRows = table.rows;

    // Apply row filter
    if (filter) {
      const colIdx = table.headers.indexOf(filter.column);
      if (colIdx === -1) {
        return {
          content: [
            {
              type: "text",
              text: `Column '${filter.column}' not found. Available: ${table.headers.join(", ")}`,
            },
          ],
          isError: true,
        };
      }
      filteredRows = filteredRows.filter(
        (row) => row[colIdx] === filter.value
      );
    }

    const totalRows = filteredRows.length;
    filteredRows = filteredRows.slice(offset, offset + limit);

    // Select columns
    let selectedHeaders = table.headers;
    let selectedRows = filteredRows;
    if (columns && columns.length > 0) {
      const indices = columns
        .map((c) => table.headers.indexOf(c))
        .filter((i) => i !== -1);
      selectedHeaders = indices.map((i) => table.headers[i]);
      selectedRows = filteredRows.map((row) =>
        indices.map((i) => row[i] || "")
      );
    }

    // Convert to objects
    const rowObjects = selectedRows.map((row) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < selectedHeaders.length; i++) {
        obj[selectedHeaders[i]] = row[i] || "";
      }
      return obj;
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: path.basename(filePath),
              totalRows,
              offset,
              limit,
              returned: rowObjects.length,
              rows: rowObjects,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- d2_write_table ---
server.tool(
  "d2_write_table",
  "Modify rows in a D2 txt data file. Identify rows by index or by matching a column value.",
  {
    fileName: z.string().describe("The txt file name"),
    updates: z
      .array(
        z.object({
          row: z
            .union([
              z.number(),
              z.object({ column: z.string(), value: z.string() }),
            ])
            .describe("Row index (0-based) or {column, value} to find the row"),
          changes: z
            .record(z.string(), z.string())
            .describe("Column name -> new value pairs"),
        })
      )
      .describe("Array of row updates to apply"),
  },
  async ({ fileName, updates }) => {
    const filePath = resolveTxtPath(workspaceRoot, fileName);
    if (!filePath) {
      return {
        content: [
          { type: "text", text: `File '${fileName}' not found` },
        ],
        isError: true,
      };
    }

    const table = readTxtFile(filePath);
    const applied: string[] = [];

    for (const update of updates) {
      let rowIdx: number;
      if (typeof update.row === "number") {
        rowIdx = update.row;
      } else {
        const colIdx = table.headers.indexOf(update.row.column);
        if (colIdx === -1) {
          applied.push(
            `SKIP: Column '${update.row.column}' not found`
          );
          continue;
        }
        rowIdx = table.rows.findIndex(
          (r) => r[colIdx] === update.row.value
        );
        if (rowIdx === -1) {
          applied.push(
            `SKIP: No row where ${update.row.column}='${update.row.value}'`
          );
          continue;
        }
      }

      if (rowIdx < 0 || rowIdx >= table.rows.length) {
        applied.push(`SKIP: Row ${rowIdx} out of range (0-${table.rows.length - 1})`);
        continue;
      }

      for (const [col, val] of Object.entries(update.changes)) {
        const colIdx = table.headers.indexOf(col);
        if (colIdx === -1) {
          applied.push(`SKIP: Column '${col}' not found`);
          continue;
        }
        const oldVal = table.rows[rowIdx][colIdx] || "";
        table.rows[rowIdx][colIdx] = val;
        applied.push(`Row ${rowIdx} [${col}]: '${oldVal}' -> '${val}'`);
      }
    }

    writeTxtFile(filePath, table.headers, table.rows);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ file: path.basename(filePath), changes: applied }, null, 2),
        },
      ],
    };
  }
);

// --- d2_search_table ---
server.tool(
  "d2_search_table",
  "Search across D2 txt files for matching values",
  {
    query: z.string().describe("Search text"),
    fileName: z
      .string()
      .optional()
      .describe("Limit search to this file (default: all files)"),
    column: z
      .string()
      .optional()
      .describe("Limit search to this column"),
    caseSensitive: z.boolean().optional().default(false),
    limit: z.number().optional().default(20).describe("Max results"),
  },
  async ({ query, fileName, column, caseSensitive, limit }) => {
    const files = fileName
      ? [resolveTxtPath(workspaceRoot, fileName)].filter(Boolean) as string[]
      : findTxtFiles(workspaceRoot);

    const results: Array<{
      file: string;
      row: number;
      column: string;
      value: string;
    }> = [];

    const q = caseSensitive ? query : query.toLowerCase();

    for (const fp of files) {
      const table = readTxtFile(fp);
      const colIndices = column
        ? [table.headers.indexOf(column)].filter((i) => i !== -1)
        : table.headers.map((_, i) => i);

      for (let r = 0; r < table.rows.length && results.length < limit; r++) {
        for (const ci of colIndices) {
          const val = table.rows[r][ci] || "";
          const cmp = caseSensitive ? val : val.toLowerCase();
          if (cmp.includes(q)) {
            results.push({
              file: path.basename(fp),
              row: r,
              column: table.headers[ci],
              value: val,
            });
            if (results.length >= limit) break;
          }
        }
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { query, totalResults: results.length, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- d2_validate_table ---
server.tool(
  "d2_validate_table",
  "Validate a D2 txt file against its schema — checks column types and reports errors",
  {
    fileName: z.string().describe("The txt file name to validate"),
  },
  async ({ fileName }) => {
    const filePath = resolveTxtPath(workspaceRoot, fileName);
    if (!filePath) {
      return {
        content: [
          { type: "text", text: `File '${fileName}' not found` },
        ],
        isError: true,
      };
    }

    const schema = schemaLoader.loadSchema(fileName);
    if (!schema) {
      return {
        content: [
          { type: "text", text: `No schema found for '${fileName}'` },
        ],
        isError: true,
      };
    }

    const table = readTxtFile(filePath);
    const errors: Array<{
      row: number;
      column: string;
      issue: string;
      value: string;
    }> = [];

    // Check for missing schema columns
    const enriched = resolveSchemaRefs(schema);
    const schemaColumns = Object.keys(enriched.columns);
    const missingInFile = schemaColumns.filter(
      (c) => !table.headers.includes(c)
    );
    const extraInFile = table.headers.filter(
      (h) => !enriched.columns[h]
    );

    // Validate cell types, ranges, refs, and enums
    for (let r = 0; r < table.rows.length; r++) {
      for (const [colName, colDef] of Object.entries(enriched.columns)) {
        const ci = table.headers.indexOf(colName);
        if (ci === -1) continue;
        const val = table.rows[r][ci] || "";

        // Required check
        if (colDef.required && !val.trim()) {
          errors.push({ row: r, column: colName, issue: "Required field is empty", value: val });
          continue;
        }
        if (val === "") continue;

        // Integer validation
        if (colDef.type === "integer") {
          if (!/^-?\d+$/.test(val)) {
            errors.push({ row: r, column: colName, issue: "Expected integer", value: val });
            continue;
          }
          const num = parseInt(val, 10);
          if (colDef.format === "boolean" && val !== "0" && val !== "1") {
            errors.push({ row: r, column: colName, issue: "Boolean must be 0 or 1", value: val });
          }
          if (colDef.min !== undefined && num < colDef.min) {
            errors.push({ row: r, column: colName, issue: `Below minimum ${colDef.min}`, value: val });
          }
          if (colDef.max !== undefined && num > colDef.max) {
            errors.push({ row: r, column: colName, issue: `Above maximum ${colDef.max}`, value: val });
          }
        }

        // Ref/enum value validation
        if (colDef.values?.length) {
          const lower = val.toLowerCase();
          const match = colDef.values.some(v => v === val || v.toLowerCase() === lower);
          if (!match) {
            errors.push({ row: r, column: colName, issue: `Invalid value (${colDef.values.length} valid options)`, value: val });
          }
        }
      }
      // Cap errors to avoid overwhelming output
      if (errors.length >= 100) break;
    }

    // Unique constraint validation
    const uniqueErrors: typeof errors = [];
    for (const [colName, colDef] of Object.entries(enriched.columns)) {
      if (!colDef.unique) continue;
      const ci = table.headers.indexOf(colName);
      if (ci === -1) continue;
      const seen = new Map<string, number>();
      for (let r = 0; r < table.rows.length; r++) {
        const val = (table.rows[r][ci] || "").trim();
        if (!val) continue;
        const lower = val.toLowerCase();
        const prevRow = seen.get(lower);
        if (prevRow !== undefined) {
          uniqueErrors.push({ row: r, column: colName, issue: `Duplicate value (first at row ${prevRow})`, value: val });
        } else {
          seen.set(lower, r);
        }
      }
      if (errors.length + uniqueErrors.length >= 100) break;
    }
    errors.push(...uniqueErrors);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              file: path.basename(filePath),
              totalRows: table.rows.length,
              schemaColumns: schemaColumns.length,
              fileColumns: table.headers.length,
              missingInFile,
              extraInFile,
              typeErrors: errors.length,
              errors: errors.slice(0, 50),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});

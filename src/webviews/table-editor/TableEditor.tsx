import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  useReactTable,
  SortingState,
  ColumnFiltersState,
} from "@tanstack/react-table";
import { onMessage, postMessage } from "../shared/vscode-api";
import { CardPanel } from "./CardPanel";
import "./table-editor.css";

interface ColumnSchema {
  type: string;
  required?: boolean;
  unique?: boolean;
  min?: number;
  max?: number;
  values?: string[];
  target?: string;
  targetColumn?: string;
  description?: string;
}

interface TxtSchema {
  file: string;
  description: string;
  columns: Record<string, ColumnSchema>;
}

interface TableData {
  headers: string[];
  rows: string[][];
}

function parseTabDelimited(text: string): TableData {
  const lines = text.split(/\r?\n/);
  // Filter out empty lines but keep the structure
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = nonEmpty[0].split("\t");
  const rows = nonEmpty.slice(1).map((line) => {
    const cells = line.split("\t");
    // Pad to match header count
    while (cells.length < headers.length) {
      cells.push("");
    }
    return cells;
  });

  // Filter out "expansion" separator rows (rows where first cell is "Expansion")
  // These are common in D2 data files
  const dataRows = rows.filter(
    (row) => row[0] !== "Expansion" && row[0] !== "expansion"
  );

  return { headers, rows: dataRows };
}

function serializeTabDelimited(headers: string[], rows: string[][]): string {
  const headerLine = headers.join("\t");
  const dataLines = rows.map((row) => row.join("\t"));
  return [headerLine, ...dataLines].join("\r\n") + "\r\n";
}

function validateCell(
  value: string,
  schema: ColumnSchema | undefined
): string | null {
  if (!schema) return null;

  if (schema.required && (!value || value.trim() === "")) {
    return "Required field";
  }

  if (!value || value.trim() === "") return null;

  switch (schema.type) {
    case "integer": {
      const num = parseInt(value, 10);
      if (isNaN(num)) return "Must be an integer";
      if (schema.min !== undefined && num < schema.min)
        return `Min: ${schema.min}`;
      if (schema.max !== undefined && num > schema.max)
        return `Max: ${schema.max}`;
      break;
    }
    case "float": {
      const num = parseFloat(value);
      if (isNaN(num)) return "Must be a number";
      break;
    }
    case "enum":
    case "ref": {
      if (schema.values && schema.values.length > 0 && !schema.values.includes(value)) {
        if (schema.values.length <= 20) {
          return `Must be one of: ${schema.values.join(", ")}`;
        }
        return `Unknown value "${value}" (${schema.values.length} valid options)`;
      }
      break;
    }
    case "boolean": {
      if (value !== "0" && value !== "1") return "Must be 0 or 1";
      break;
    }
  }

  return null;
}

export function TableEditor() {
  const tableRef = useRef<HTMLTableElement>(null);
  const [data, setData] = useState<TableData>({ headers: [], rows: [] });
  const [originalData, setOriginalData] = useState<string>("");
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [fileName, setFileName] = useState<string>("");
  const [schema, setSchema] = useState<TxtSchema | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === "load") {
        const content = msg.content as string;
        const parsed = parseTabDelimited(content);
        setData(parsed);
        setOriginalData(content);
        setFileName(msg.fileName as string);
        if (msg.schema) {
          const s = msg.schema as TxtSchema;
          // Debug: log ref columns with values
          for (const [k, v] of Object.entries(s.columns)) {
            if (v.type === "ref" && v.values?.length) {
              console.log(`[D2W] Schema ref col '${k}': ${v.values.length} values, first 5:`, v.values.slice(0, 5));
            }
          }
          setSchema(s);
        }
        setDirty(false);
      }
      if (msg.type === "update") {
        const parsed = parseTabDelimited(msg.content as string);
        setData(parsed);
      }
      if (msg.type === "schema") {
        setSchema(msg.schema as TxtSchema);
      }
      if (msg.type === "navigateToRow") {
        const rowIdx = msg.row as number;
        setSelectedRow(rowIdx);
        // Scroll to the row after a brief delay to ensure render
        setTimeout(() => {
          const row = tableRef.current?.querySelector(`tbody tr:nth-child(${rowIdx + 1})`);
          if (row) {
            row.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 100);
      }
    });

    // Tell the extension host we're ready to receive data
    postMessage({ type: "ready" });

    return cleanup;
  }, []);

  const updateCell = useCallback(
    (rowIndex: number, colIndex: number, value: string) => {
      setData((prev) => {
        const newRows = [...prev.rows];
        newRows[rowIndex] = [...newRows[rowIndex]];
        newRows[rowIndex][colIndex] = value;
        setDirty(true);
        return { ...prev, rows: newRows };
      });
    },
    []
  );

  const columnHelper = createColumnHelper<string[]>();

  // Merge schema enum values with unique values found in the actual data.
  // This prevents false validation errors when mods use different values than vanilla.
  const mergedColumnSchemas = useMemo(() => {
    if (!schema) return {};
    const result: Record<string, ColumnSchema> = {};
    for (const [i, header] of data.headers.entries()) {
      const colSchema = schema.columns[header];
      if (!colSchema) continue;
      if ((colSchema.type === "enum" || colSchema.type === "ref") && colSchema.values?.length) {
        // Collect unique non-empty values from this column's data
        const dataValues = new Set<string>();
        for (const row of data.rows) {
          const v = row[i]?.trim();
          if (v) dataValues.add(v);
        }
        // Merge: schema values + data values (deduped, sorted)
        const merged = new Set([...colSchema.values, ...dataValues]);
        result[header] = { ...colSchema, values: Array.from(merged).sort() };
      } else {
        result[header] = colSchema;
      }
    }
    return result;
  }, [schema, data]);

  const columns = useMemo(
    () =>
      data.headers.map((header, index) => {
        const colSchema = mergedColumnSchemas[header] || schema?.columns[header];

        return columnHelper.accessor((row) => row[index] || "", {
          id: header || `col_${index}`,
          header: () => (
            <div className="header-cell">
              <span className="header-name">{header}</span>
              {colSchema && (
                <span className="header-type">{colSchema.type}</span>
              )}
            </div>
          ),
          cell: (info) => {
            const value = info.getValue();
            const error = validateCell(value, colSchema);
            return (
              <EditableCell
                value={value}
                error={error}
                schema={colSchema}
                onChange={(newValue) =>
                  updateCell(info.row.index, index, newValue)
                }
              />
            );
          },
          size: Math.max(80, Math.min(200, header.length * 9)),
        });
      }),
    [data.headers, schema, mergedColumnSchemas, updateCell]
  );

  const table = useReactTable({
    data: data.rows,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: "includesString",
  });

  if (data.headers.length === 0) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="table-editor">
      <div className="toolbar">
        <span className="file-name">
          {fileName}
          {dirty && <span className="dirty-indicator"> *</span>}
        </span>
        <span className="row-count">
          {table.getFilteredRowModel().rows.length} / {data.rows.length} rows
          &times; {data.headers.length} cols
        </span>
        {schema && (
          <span className="schema-badge" title={schema.description}>
            Schema
          </span>
        )}
        <input
          className="search-input"
          type="text"
          placeholder="Search all columns..."
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
        />
        <button
          className="save-btn"
          disabled={!dirty}
          onClick={() => {
            const content = serializeTabDelimited(data.headers, data.rows);
            postMessage({ type: "save", content });
            setDirty(false);
          }}
        >
          Queue Save
        </button>
      </div>
      <div className="content-area">
        <div className="grid-container">
          <table ref={tableRef}>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  <th className="row-number">#</th>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className={
                        header.column.getIsSorted()
                          ? `sorted-${header.column.getIsSorted()}`
                          : ""
                      }
                      style={{ width: header.getSize() }}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {header.column.getIsSorted() === "asc" && " \u25B2"}
                      {header.column.getIsSorted() === "desc" && " \u25BC"}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className={selectedRow === row.index ? "selected" : ""}
                  onClick={() => setSelectedRow(row.index)}
                >
                  <td className="row-number">{row.index + 1}</td>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selectedRow !== null && selectedRow < data.rows.length && (
          <CardPanel
            headers={data.headers}
            row={data.rows[selectedRow]}
            rowIndex={selectedRow}
            schema={schema ? { ...schema, columns: { ...schema.columns, ...mergedColumnSchemas } } : null}
            onClose={() => setSelectedRow(null)}
            onChange={(colIndex, value) =>
              updateCell(selectedRow, colIndex, value)
            }
          />
        )}
      </div>
    </div>
  );
}

/** Threshold: enums with more values than this get autocomplete instead of dropdown */
const AUTOCOMPLETE_THRESHOLD = 20;

function BooleanToggle({ value, onToggle }: { value: string; onToggle: (v: string) => void }) {
  useEffect(() => {
    onToggle(value === "1" ? "0" : "1");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <span className="cell-value">{value === "1" ? "0" : "1"}</span>;
}

function AutocompleteInput({
  value,
  options,
  onCommit,
  onCancel,
}: {
  value: string;
  options: string[];
  onCommit: (val: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(value);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [showDropdown, setShowDropdown] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);

  const filtered = useMemo(() => {
    if (!text) return options.slice(0, 30);
    const lower = text.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(lower)).slice(0, 30);
  }, [text, options]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx >= 0 && listRef.current) {
      const item = listRef.current.children[highlightIdx] as HTMLElement;
      if (item) item.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  const commit = useCallback((val: string) => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(val);
  }, [onCommit]);

  return (
    <div className="autocomplete-wrapper">
      <input
        ref={inputRef}
        className="cell-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setHighlightIdx(-1);
          setShowDropdown(true);
        }}
        onBlur={() => {
          // Delay to allow mouseDown on dropdown items to fire first
          setTimeout(() => {
            if (!committedRef.current) commit(text);
          }, 200);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setShowDropdown(true);
            setHighlightIdx((prev) => Math.min(prev + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((prev) => Math.max(prev - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (highlightIdx >= 0 && filtered[highlightIdx]) {
              commit(filtered[highlightIdx]);
            } else {
              commit(text);
            }
          } else if (e.key === "Escape") {
            onCancel();
          } else if (e.key === "Tab") {
            commit(text);
          }
        }}
        autoFocus
      />
      {showDropdown && filtered.length > 0 && (
        <div ref={listRef} className="autocomplete-dropdown">
          {filtered.map((opt, i) => (
            <div
              key={opt}
              className={`autocomplete-item ${i === highlightIdx ? "highlighted" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(opt);
              }}
              onMouseEnter={() => setHighlightIdx(i)}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EditableCell({
  value,
  error,
  schema,
  onChange,
}: {
  value: string;
  error: string | null;
  schema?: ColumnSchema;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);

  // Sync with external changes
  React.useEffect(() => {
    if (!editing) setEditValue(value);
  }, [value, editing]);

  if (editing) {
    const enumValues = schema?.values;
    const hasValues = enumValues && enumValues.length > 0;

    // Enum or ref with values: always show dropdown select
    if ((schema?.type === "enum" || schema?.type === "ref") && hasValues) {
      return (
        <select
          className="cell-select"
          value={editValue}
          onChange={(e) => {
            const newVal = e.target.value;
            setEditValue(newVal);
            onChange(newVal);
            setEditing(false);
          }}
          onBlur={() => setEditing(false)}
          autoFocus
        >
          <option value="">—</option>
          {enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      );
    }

    // Large enum or ref with values: autocomplete
    if (hasValues && enumValues.length > AUTOCOMPLETE_THRESHOLD) {
      return (
        <AutocompleteInput
          value={editValue}
          options={enumValues}
          onCommit={(val) => {
            setEditValue(val);
            if (val !== value) onChange(val);
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
            setEditValue(value);
          }}
        />
      );
    }

    // Boolean: simple toggle (use effect to avoid state update during render)
    if (schema?.type === "boolean") {
      return (
        <BooleanToggle
          value={value}
          onToggle={(newVal) => {
            onChange(newVal);
            setEditValue(newVal);
            setEditing(false);
          }}
        />
      );
    }

    return (
      <input
        className="cell-input"
        type={
          schema?.type === "integer" || schema?.type === "float"
            ? "number"
            : "text"
        }
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (editValue !== value) onChange(editValue);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setEditing(false);
            if (editValue !== value) onChange(editValue);
          }
          if (e.key === "Escape") {
            setEditing(false);
            setEditValue(value);
          }
          // Tab to next cell
          if (e.key === "Tab") {
            setEditing(false);
            if (editValue !== value) onChange(editValue);
          }
        }}
        autoFocus
      />
    );
  }

  return (
    <span
      className={`cell-value ${error ? "cell-error" : ""}`}
      title={error || schema?.description || undefined}
      onDoubleClick={() => setEditing(true)}
    >
      {value || "\u00A0"}
    </span>
  );
}

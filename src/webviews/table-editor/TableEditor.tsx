import React, { useEffect, useMemo, useState, useCallback } from "react";
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
    case "enum": {
      if (schema.values && !schema.values.includes(value)) {
        return `Must be one of: ${schema.values.join(", ")}`;
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
          setSchema(msg.schema as TxtSchema);
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

  const columns = useMemo(
    () =>
      data.headers.map((header, index) => {
        const colSchema = schema?.columns[header];

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
    [data.headers, schema, updateCell]
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
          <table>
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
            schema={schema}
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
    // Enum columns get a dropdown
    if (schema?.type === "enum" && schema.values) {
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
          {schema.values.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
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
      title={error || undefined}
      onDoubleClick={() => setEditing(true)}
    >
      {value || "\u00A0"}
    </span>
  );
}

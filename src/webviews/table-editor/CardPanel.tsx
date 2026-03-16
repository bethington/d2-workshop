import React, { useState } from "react";

/** Case-insensitive column schema lookup */
function getColumnSchema(
  columns: Record<string, ColumnSchema> | undefined,
  header: string
): ColumnSchema | undefined {
  if (!columns) return undefined;
  if (columns[header]) return columns[header];
  const lower = header.toLowerCase();
  for (const [k, v] of Object.entries(columns)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

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

interface CardPanelProps {
  headers: string[];
  row: string[];
  rowIndex: number;
  schema: TxtSchema | null;
  onClose: () => void;
  onChange: (colIndex: number, value: string) => void;
}

/**
 * Detail card panel showing all columns for a selected row
 * with schema descriptions, types, validation, and inline editing.
 */
export function CardPanel({
  headers,
  row,
  rowIndex,
  schema,
  onClose,
  onChange,
}: CardPanelProps) {
  const [filter, setFilter] = useState("");

  const filteredFields = headers
    .map((header, index) => ({ header, index, value: row[index] || "" }))
    .filter(
      ({ header, value }) =>
        !filter ||
        header.toLowerCase().includes(filter.toLowerCase()) ||
        value.toLowerCase().includes(filter.toLowerCase())
    );

  return (
    <div className="card-panel">
      <div className="card-header">
        <h3>Row {rowIndex + 1}</h3>
        {row[0] && (
          <span className="card-title">{row[0]}</span>
        )}
        <button className="close-btn" onClick={onClose}>
          \u00D7
        </button>
      </div>
      <div className="card-filter">
        <input
          type="text"
          placeholder="Filter fields..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="card-content">
        {filteredFields.map(({ header, index, value }) => {
          const colSchema = getColumnSchema(schema?.columns, header);
          return (
            <CardField
              key={index}
              header={header}
              value={value}
              schema={colSchema}
              onChange={(newValue) => onChange(index, newValue)}
            />
          );
        })}
      </div>
    </div>
  );
}

function CardField({
  header,
  value,
  schema,
  onChange,
}: {
  header: string;
  value: string;
  schema?: ColumnSchema;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value);

  React.useEffect(() => {
    if (!editing) setEditValue(value);
  }, [value, editing]);

  const typeLabel = schema
    ? `${schema.type}${schema.required ? " *" : ""}`
    : "";

  const refLabel =
    schema?.type === "ref" ? `\u2192 ${schema.target}` : "";

  return (
    <div className={`card-field ${schema?.required && !value ? "field-required" : ""}`}>
      <div className="field-header">
        <label className="field-label">{header}</label>
        {typeLabel && <span className="field-type">{typeLabel}</span>}
        {refLabel && <span className="field-ref">{refLabel}</span>}
      </div>
      {schema?.description && (
        <div className="field-description">{schema.description}</div>
      )}
      {editing ? (
        <div className="field-edit">
          {(schema?.type === "enum" || schema?.type === "ref") && schema?.values?.length ? (
            <select
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                onChange(e.target.value);
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
          ) : schema?.type === "boolean" ? (
            <select
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value);
                onChange(e.target.value);
                setEditing(false);
              }}
              onBlur={() => setEditing(false)}
              autoFocus
            >
              <option value="0">0 (false)</option>
              <option value="1">1 (true)</option>
            </select>
          ) : (
            <input
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
              }}
              autoFocus
            />
          )}
        </div>
      ) : (
        <div
          className="field-value"
          onDoubleClick={() => setEditing(true)}
          title="Double-click to edit"
        >
          {value || "\u2014"}
        </div>
      )}
    </div>
  );
}

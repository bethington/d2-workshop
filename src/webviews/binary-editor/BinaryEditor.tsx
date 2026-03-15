import React, { useEffect, useState } from "react";
import { onMessage, postMessage } from "../shared/vscode-api";

interface GlobalEntry {
  name: string;
  address: string;
  rva: string;
  type: string;
  description: string;
  currentValue?: number;
}

interface PatchEntry {
  rva: string;
  orig: string;
  patch: string;
  desc: string;
  _currentlyApplied?: boolean;
}

interface PatchGroup {
  name: string;
  description: string;
  dlls: Record<string, PatchEntry[]>;
}

interface BinarySchema {
  file: string;
  version: string;
  globals: Record<string, GlobalEntry[]>;
  patchGroups: PatchGroup[];
}

interface PEInfo {
  fileName: string;
  fileSize: number;
  imageBase: string;
  entryPoint: string;
  is64Bit: boolean;
  sections: Array<{
    name: string;
    virtualAddress: string;
    virtualSize: string;
    rawSize: string;
  }>;
  exports: Array<{ name: string; ordinal: number; rva: string }>;
}

export function BinaryEditor() {
  const [fileName, setFileName] = useState("");
  const [peInfo, setPeInfo] = useState<PEInfo | null>(null);
  const [schema, setSchema] = useState<BinarySchema | null>(null);
  const [patchApplied, setPatchApplied] = useState<Record<string, boolean>>(
    {}
  );
  const [activeTab, setActiveTab] = useState<
    "info" | "globals" | "patches" | "exports"
  >("info");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cleanup = onMessage((msg) => {
      if (msg.type === "load") {
        setFileName(msg.fileName as string);
        setPeInfo(msg.peInfo as PEInfo | null);
        setSchema(msg.schema as BinarySchema | null);
        setError(msg.error as string | null);

        // Build initial patch-applied state from _currentlyApplied
        if (msg.schema) {
          const s = msg.schema as BinarySchema;
          const applied: Record<string, boolean> = {};
          for (const group of s.patchGroups) {
            for (const [, patches] of Object.entries(group.dlls)) {
              for (const p of patches) {
                if ((p as any)._currentlyApplied) {
                  applied[p.rva] = true;
                }
              }
            }
          }
          setPatchApplied(applied);
        }
      }
      if (msg.type === "patchResult") {
        setPatchApplied((prev) => ({
          ...prev,
          [msg.rva as string]: msg.enabled as boolean,
        }));
      }
    });
    postMessage({ type: "ready" });
    return cleanup;
  }, []);

  if (error) {
    return (
      <div style={{ padding: 20, color: "var(--vscode-errorForeground)" }}>
        Failed to load binary: {error}
      </div>
    );
  }

  if (!peInfo) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh",
          color: "var(--vscode-descriptionForeground)",
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div
        style={{
          padding: "6px 12px",
          borderBottom: "1px solid var(--vscode-panel-border)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <span style={{ fontWeight: "bold", fontSize: "1.05em" }}>
          {fileName}
        </span>
        <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.85em" }}>
          {(peInfo.fileSize / 1024).toFixed(0)} KB | {peInfo.imageBase} |{" "}
          {peInfo.is64Bit ? "64-bit" : "32-bit"}
        </span>
        <div style={{ display: "flex", gap: "2px", marginLeft: "auto" }}>
          {(["info", "exports", "globals", "patches"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "3px 10px",
                background:
                  activeTab === tab
                    ? "var(--vscode-button-background)"
                    : "var(--vscode-button-secondaryBackground)",
                color:
                  activeTab === tab
                    ? "var(--vscode-button-foreground)"
                    : "var(--vscode-button-secondaryForeground)",
                border: "none",
                cursor: "pointer",
                textTransform: "capitalize",
                fontSize: "0.85em",
              }}
            >
              {tab}
              {tab === "patches" &&
                schema &&
                schema.patchGroups.length > 0 &&
                ` (${schema.patchGroups.length})`}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px" }}>
        {activeTab === "info" && <InfoTab peInfo={peInfo} />}
        {activeTab === "exports" && <ExportsTab peInfo={peInfo} />}
        {activeTab === "globals" && (
          <GlobalsTab schema={schema} fileName={fileName} />
        )}
        {activeTab === "patches" && (
          <PatchesTab
            schema={schema}
            fileName={fileName}
            patchApplied={patchApplied}
          />
        )}
      </div>
    </div>
  );
}

function InfoTab({ peInfo }: { peInfo: PEInfo }) {
  return (
    <div>
      <h3 style={{ marginTop: 0 }}>PE Header</h3>
      <table style={{ borderCollapse: "collapse" }}>
        <tbody>
          {[
            ["File", peInfo.fileName],
            ["Size", `${(peInfo.fileSize / 1024).toFixed(1)} KB`],
            ["Image Base", peInfo.imageBase],
            ["Entry Point", peInfo.entryPoint],
            ["Architecture", peInfo.is64Bit ? "x86-64" : "x86"],
          ].map(([label, value]) => (
            <tr key={label}>
              <td style={{ ...tdLabel }}>{label}</td>
              <td style={tdValue}>
                <code>{value}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Sections ({peInfo.sections.length})</h3>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Virtual Address</th>
            <th style={thStyle}>Virtual Size</th>
            <th style={thStyle}>Raw Size</th>
          </tr>
        </thead>
        <tbody>
          {peInfo.sections.map((sec) => (
            <tr key={sec.name + sec.virtualAddress}>
              <td style={tdCell}>
                <code>{sec.name}</code>
              </td>
              <td style={tdCell}>
                <code>{sec.virtualAddress}</code>
              </td>
              <td style={tdCell}>
                <code>{sec.virtualSize}</code>
              </td>
              <td style={tdCell}>
                <code>{sec.rawSize}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExportsTab({ peInfo }: { peInfo: PEInfo }) {
  const [filter, setFilter] = useState("");
  const filtered = peInfo.exports.filter(
    (e) =>
      !filter || e.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div>
      <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Exports ({peInfo.exports.length})</h3>
        <input
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={inputStyle}
        />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thStyle}>Ordinal</th>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>RVA</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((exp) => (
            <tr key={exp.ordinal}>
              <td style={tdCell}>{exp.ordinal}</td>
              <td style={tdCell}>
                <code>{exp.name}</code>
              </td>
              <td style={tdCell}>
                <code>{exp.rva}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GlobalsTab({
  schema,
  fileName,
}: {
  schema: BinarySchema | null;
  fileName: string;
}) {
  if (!schema || Object.keys(schema.globals).length === 0) {
    return (
      <div style={{ color: "var(--vscode-descriptionForeground)" }}>
        No globals schema found for {fileName}. Create one at{" "}
        <code>schemas/binaries/{fileName}.json</code> or{" "}
        <code>.d2workshop/schemas/binaries/{fileName}.json</code>
      </div>
    );
  }

  return (
    <div>
      {Object.entries(schema.globals).map(([category, entries]) => (
        <div key={category} style={{ marginBottom: 20 }}>
          <h3
            style={{
              borderBottom: "1px solid var(--vscode-panel-border)",
              paddingBottom: 4,
              marginTop: 0,
            }}
          >
            {category}{" "}
            <span
              style={{
                fontSize: "0.8em",
                color: "var(--vscode-descriptionForeground)",
              }}
            >
              ({entries.length})
            </span>
          </h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>RVA</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Value</th>
                <th style={thStyle}>Description</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.rva}>
                  <td style={tdCell}>
                    <code style={{ fontSize: "0.85em" }}>{entry.name}</code>
                  </td>
                  <td style={tdCell}>
                    <code style={{ fontSize: "0.85em" }}>{entry.rva}</code>
                  </td>
                  <td style={tdCell}>{entry.type}</td>
                  <td style={tdCell}>
                    <code>
                      {entry.currentValue !== undefined
                        ? `0x${entry.currentValue.toString(16).toUpperCase()} (${entry.currentValue})`
                        : "\u2014"}
                    </code>
                  </td>
                  <td
                    style={{
                      ...tdCell,
                      color: "var(--vscode-descriptionForeground)",
                      fontSize: "0.85em",
                    }}
                  >
                    {entry.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function PatchesTab({
  schema,
  fileName,
  patchApplied,
}: {
  schema: BinarySchema | null;
  fileName: string;
  patchApplied: Record<string, boolean>;
}) {
  if (!schema || schema.patchGroups.length === 0) {
    return (
      <div style={{ color: "var(--vscode-descriptionForeground)" }}>
        No patch groups defined for {fileName}.
      </div>
    );
  }

  return (
    <div>
      {schema.patchGroups.map((group) => {
        const dllNames = Object.keys(group.dlls);
        const isMultiDll = dllNames.length > 1;

        // Count applied patches
        let totalPatches = 0;
        let appliedCount = 0;
        for (const patches of Object.values(group.dlls)) {
          for (const p of patches) {
            totalPatches++;
            if (patchApplied[p.rva]) appliedCount++;
          }
        }

        return (
          <div
            key={group.name}
            style={{
              marginBottom: 16,
              border: "1px solid var(--vscode-panel-border)",
              borderRadius: 4,
              padding: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 4,
              }}
            >
              <h3 style={{ margin: 0 }}>{group.name}</h3>
              <span
                style={{
                  fontSize: "0.8em",
                  padding: "1px 6px",
                  borderRadius: 3,
                  background:
                    appliedCount === totalPatches
                      ? "var(--vscode-testing-iconPassed)"
                      : appliedCount > 0
                        ? "var(--vscode-editorWarning-foreground)"
                        : "var(--vscode-badge-background)",
                  color: "var(--vscode-badge-foreground)",
                }}
              >
                {appliedCount}/{totalPatches}
              </span>
            </div>
            <p
              style={{
                margin: "0 0 8px 0",
                color: "var(--vscode-descriptionForeground)",
                fontSize: "0.85em",
              }}
            >
              {group.description}
            </p>

            {dllNames.map((dll) => (
              <div key={dll} style={{ marginBottom: 6 }}>
                {isMultiDll && (
                  <h4
                    style={{
                      margin: "4px 0",
                      paddingLeft: 8,
                      fontSize: "0.9em",
                    }}
                  >
                    {dll}
                  </h4>
                )}
                {group.dlls[dll].map((patch) => {
                  const isApplied = patchApplied[patch.rva] || false;
                  const isThisDll =
                    dll.toLowerCase() === fileName.toLowerCase();

                  return (
                    <label
                      key={`${dll}-${patch.rva}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "3px 8px",
                        paddingLeft: isMultiDll ? 24 : 8,
                        cursor: isThisDll ? "pointer" : "default",
                        opacity: isThisDll ? 1 : 0.5,
                        fontSize: "0.85em",
                      }}
                      title={
                        isThisDll
                          ? undefined
                          : `Open ${dll} to toggle this patch`
                      }
                    >
                      <input
                        type="checkbox"
                        checked={isApplied}
                        disabled={!isThisDll}
                        onChange={(e) => {
                          postMessage({
                            type: "togglePatch",
                            patch,
                            enabled: e.target.checked,
                          });
                        }}
                      />
                      <code
                        style={{
                          fontSize: "0.85em",
                          color: "var(--vscode-descriptionForeground)",
                        }}
                      >
                        {patch.rva}
                      </code>
                      <span>{patch.desc}</span>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 8px",
  borderBottom: "1px solid var(--vscode-panel-border)",
  fontSize: "0.8em",
  color: "var(--vscode-descriptionForeground)",
  whiteSpace: "nowrap",
};

const tdCell: React.CSSProperties = {
  padding: "3px 8px",
  borderBottom: "1px solid var(--vscode-panel-border)",
  fontSize: "0.85em",
};

const tdLabel: React.CSSProperties = {
  padding: "3px 12px 3px 0",
  color: "var(--vscode-descriptionForeground)",
  fontWeight: 600,
  fontSize: "0.85em",
  whiteSpace: "nowrap",
};

const tdValue: React.CSSProperties = {
  padding: "3px 0",
  fontSize: "0.85em",
};

const inputStyle: React.CSSProperties = {
  padding: "3px 8px",
  background: "var(--vscode-input-background)",
  color: "var(--vscode-input-foreground)",
  border: "1px solid var(--vscode-input-border)",
  borderRadius: 2,
  outline: "none",
  fontSize: "0.85em",
  width: 200,
};

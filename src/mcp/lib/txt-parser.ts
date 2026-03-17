import * as fs from "fs";
import * as path from "path";

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export function parseTxtContent(content: string): ParsedTable {
  const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const headers = lines[0].split("\t");
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split("\t");
    // Skip "Expansion" marker rows
    if (cells.length === 1 && cells[0].toLowerCase() === "expansion") {
      continue;
    }
    rows.push(cells);
  }
  return { headers, rows };
}

export function serializeTxtContent(
  headers: string[],
  rows: string[][]
): string {
  const lines = [headers.join("\t")];
  for (const row of rows) {
    lines.push(row.join("\t"));
  }
  return lines.join("\r\n") + "\r\n";
}

export function readTxtFile(filePath: string): ParsedTable {
  const buf = fs.readFileSync(filePath);
  const content = new TextDecoder("latin1").decode(buf);
  return parseTxtContent(content);
}

export function writeTxtFile(
  filePath: string,
  headers: string[],
  rows: string[][]
): void {
  const content = serializeTxtContent(headers, rows);
  const buf = Buffer.from(content, "latin1");
  fs.writeFileSync(filePath, buf);
}

export function findTxtFiles(workspaceRoot: string): string[] {
  const excelDir = path.join(workspaceRoot, "data", "global", "excel");
  if (!fs.existsSync(excelDir)) {
    return [];
  }
  return fs
    .readdirSync(excelDir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .map((f) => path.join(excelDir, f));
}

export function resolveTxtPath(
  workspaceRoot: string,
  fileName: string
): string | null {
  if (!fileName.toLowerCase().endsWith(".txt")) {
    fileName = fileName + ".txt";
  }
  const excelDir = path.join(workspaceRoot, "data", "global", "excel");
  const filePath = path.join(excelDir, fileName);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  // Case-insensitive fallback
  if (fs.existsSync(excelDir)) {
    const match = fs
      .readdirSync(excelDir)
      .find((f) => f.toLowerCase() === fileName.toLowerCase());
    if (match) {
      return path.join(excelDir, match);
    }
  }
  return null;
}

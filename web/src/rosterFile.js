import { clean } from "./recipientModel.js";

export function fieldKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueHeaders(values) {
  const seen = new Map();
  return values.map((value, index) => {
    const base = clean(value).replace(/^\uFEFF/, "") || `Column ${index + 1}`;
    const key = base.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    return count ? `${base} (${count + 1})` : base;
  });
}

function isProfileColumn(column) {
  return fieldKey(column).split("_").includes("profile");
}

export async function parseRoster(buffer) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The uploaded file does not contain a worksheet.");
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: false });
  if (!matrix.length) throw new Error("The uploaded roster is empty.");
  const uploadedColumns = uniqueHeaders(matrix[0]);
  const keptColumns = uploadedColumns
    .map((column, columnIndex) => ({ column, columnIndex }))
    .filter(({ column }) => !isProfileColumn(column));
  const columns = keptColumns.map(({ column }) => column);
  const rows = matrix.slice(1).map((cells, index) => ({
    id: `row-${index + 2}`,
    sourceRow: index + 2,
    values: Object.fromEntries(keptColumns.map(({ column, columnIndex }) => [column, clean(cells[columnIndex])])),
  })).filter((row) => Object.values(row.values).some(Boolean));
  if (!columns.length || !rows.length) throw new Error("The roster needs a header row and at least one athlete.");
  return { columns, rows };
}

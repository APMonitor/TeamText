export function clean(value) {
  return String(value ?? "").trim();
}

export function uniqueValues(values) {
  const seen = new Set();
  return values.map(clean).filter((value) => {
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function naturalList(values) {
  const items = uniqueValues(values);
  if (items.length < 2) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

export function aggregateValues(rows, columns) {
  return Object.fromEntries(columns.map((column) => [
    column,
    naturalList(rows.map((row) => row.values[column])),
  ]));
}

export function looksLikeTextNumber(value) {
  const raw = clean(value);
  if (!raw || /[^+\d().\s-]/.test(raw)) return false;
  const digits = raw.replace(/\D/g, "");
  if (new Set(digits).size <= 1) return false;
  if (raw.startsWith("+")) return /^[1-9]\d{9,14}$/.test(digits);
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national);
}

function textNumberKey(value) {
  const raw = clean(value);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `us:${digits.slice(1)}`;
  if (digits.length === 10) return `us:${digits}`;
  return `intl:${digits}`;
}

export function buildRecipientUnits({ rows, deliveryMode, nameColumn, phoneColumn, columns }) {
  if (deliveryMode === "individual") {
    return rows.map((row) => {
      const athleteName = clean(row.values[nameColumn]);
      return {
        id: row.id,
        rows: [row],
        values: row.values,
        name: athleteName || `Spreadsheet row ${row.sourceRow}`,
        address: clean(row.values[phoneColumn]),
        athleteNames: athleteName,
        athleteCount: athleteName ? 1 : 0,
      };
    });
  }

  const households = new Map();
  rows.forEach((row) => {
    const address = clean(row.values[phoneColumn]);
    const key = looksLikeTextNumber(address) ? textNumberKey(address) : `row:${row.id}`;
    const group = households.get(key) || [];
    group.push(row);
    households.set(key, group);
  });

  return [...households.values()].map((householdRows, index) => {
    const athleteNames = naturalList(householdRows.map((row) => row.values[nameColumn]));
    const sourceRows = naturalList(householdRows.map((row) => String(row.sourceRow)));
    return {
      id: `household-${index + 1}`,
      rows: householdRows,
      values: aggregateValues(householdRows, columns),
      name: athleteNames || `Spreadsheet rows ${sourceRows}`,
      address: clean(householdRows[0]?.values[phoneColumn]),
      athleteNames,
      athleteCount: householdRows.length,
    };
  });
}

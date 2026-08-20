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

export function firstName(value) {
  const name = clean(value);
  if (!name) return "";
  const commaIndex = name.indexOf(",");
  const firstNamePart = commaIndex >= 0 ? clean(name.slice(commaIndex + 1)) : name;
  return firstNamePart.split(/\s+/)[0] || name;
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

export function splitTextNumbers(value) {
  const numbers = String(value ?? "").split(/[;,]/).map(clean).filter(Boolean);
  if (!numbers.length) return [];

  const seen = new Set();
  return numbers.filter((number) => {
    const key = looksLikeTextNumber(number)
      ? textNumberKey(number)
      : `raw:${number.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildRecipientUnits({ rows, deliveryMode, nameColumn, phoneColumn, columns, householdNameFormat = "full" }) {
  if (deliveryMode === "individual") {
    return rows.map((row) => {
      const athleteName = clean(row.values[nameColumn]);
      const addresses = splitTextNumbers(row.values[phoneColumn]);
      const address = addresses.join("; ");
      return {
        id: row.id,
        rows: [row],
        values: { ...row.values, [phoneColumn]: address },
        name: athleteName || `Spreadsheet row ${row.sourceRow}`,
        address,
        addresses,
        athleteNames: athleteName,
        athleteCount: athleteName ? 1 : 0,
        recipientCount: addresses.length,
      };
    });
  }

  const households = new Map();
  rows.forEach((row) => {
    const addresses = splitTextNumbers(row.values[phoneColumn]);
    const isValidGroup = addresses.length > 0 && addresses.every(looksLikeTextNumber);
    const key = isValidGroup
      ? `group:${addresses.map(textNumberKey).sort().join("|")}`
      : `row:${row.id}`;
    const group = households.get(key) || { addresses, rows: [] };
    group.rows.push(row);
    households.set(key, group);
  });

  return [...households.values()].map((household, index) => {
    const householdRows = household.rows;
    const householdNames = householdRows.map((row) => row.values[nameColumn]);
    const athleteNames = naturalList(householdNameFormat === "first" ? householdNames.map(firstName) : householdNames);
    const sourceRows = naturalList(householdRows.map((row) => String(row.sourceRow)));
    const values = aggregateValues(householdRows, columns);
    const address = household.addresses.join("; ");
    values[nameColumn] = athleteNames;
    values[phoneColumn] = address;
    return {
      id: `household-${index + 1}`,
      rows: householdRows,
      values,
      name: athleteNames || `Spreadsheet rows ${sourceRows}`,
      address,
      addresses: household.addresses,
      athleteNames,
      athleteCount: householdRows.length,
      recipientCount: household.addresses.length,
    };
  });
}

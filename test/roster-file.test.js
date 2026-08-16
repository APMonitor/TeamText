import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseRoster } from "../web/src/rosterFile.js";

const matrix = [
  ["Athlete", "Parent Phone", "Team", "Profile URL"],
  ["Ava Ramirez", "+12025550101; +12025550104", "U12 Blue", "https://example.com/private"],
  ["Leo Ramirez", "+12025550101, +12025550105", "U12 Blue", "https://example.com/private"],
];

test("CSV uploads produce roster rows without profile columns", async () => {
  const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(matrix));
  const roster = await parseRoster(new TextEncoder().encode(csv));
  assert.deepEqual(roster.columns, ["Athlete", "Parent Phone", "Team"]);
  assert.equal(roster.rows.length, 2);
  assert.equal(roster.rows[0].values.Athlete, "Ava Ramirez");
  assert.equal(roster.rows[0].values["Parent Phone"], "+12025550101; +12025550104");
  assert.equal(roster.rows[1].values["Parent Phone"], "+12025550101, +12025550105");
});

for (const bookType of ["xlsx", "xls"]) {
  test(`${bookType.toUpperCase()} uploads produce roster rows`, async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), "Roster");
    const buffer = XLSX.write(workbook, { type: "array", bookType });
    const roster = await parseRoster(buffer);
    assert.equal(roster.rows.length, 2);
    assert.equal(roster.rows[0].values["Parent Phone"], "+12025550101; +12025550104");
    assert.equal(roster.rows[1].values.Athlete, "Leo Ramirez");
    assert.equal(roster.rows[1].values["Parent Phone"], "+12025550101, +12025550105");
  });
}

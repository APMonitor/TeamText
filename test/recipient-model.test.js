import test from "node:test";
import assert from "node:assert/strict";
import { buildRecipientUnits, naturalList, splitTextNumbers } from "../web/src/recipientModel.js";

const columns = ["Athlete", "Parent Name", "Parent Phone", "Team"];
const rows = [
  {
    id: "row-2",
    sourceRow: 2,
    values: { Athlete: "Ava Ramirez", "Parent Name": "Morgan Ramirez", "Parent Phone": "+1 202-555-0101", Team: "U12 Blue" },
  },
  {
    id: "row-3",
    sourceRow: 3,
    values: { Athlete: "Leo Ramirez", "Parent Name": "Morgan Ramirez", "Parent Phone": "(202) 555-0101", Team: "U12 Blue" },
  },
  {
    id: "row-4",
    sourceRow: 4,
    values: { Athlete: "Jordan Lee", "Parent Name": "Taylor Lee", "Parent Phone": "+12025550102", Team: "U12 Blue" },
  },
];

test("individual mode creates one target per roster row", () => {
  const units = buildRecipientUnits({ rows, deliveryMode: "individual", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((unit) => unit.athleteNames), ["Ava Ramirez", "Leo Ramirez", "Jordan Lee"]);
});

test("household mode combines rows sharing a normalized US number", () => {
  const units = buildRecipientUnits({ rows, deliveryMode: "household", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 2);
  assert.equal(units[0].athleteNames, "Ava Ramirez and Leo Ramirez");
  assert.equal(units[0].athleteCount, 2);
  assert.equal(units[0].values["Parent Name"], "Morgan Ramirez");
  assert.equal(units[0].values.Athlete, "Ava Ramirez and Leo Ramirez");
  assert.equal(units[0].values.Team, "U12 Blue");
});

test("invalid or missing phone values never collapse unrelated rows", () => {
  const invalidRows = rows.slice(0, 2).map((row) => ({ ...row, values: { ...row.values, "Parent Phone": "missing" } }));
  const units = buildRecipientUnits({ rows: invalidRows, deliveryMode: "household", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 2);
});

test("natural lists are readable and remove duplicate values", () => {
  assert.equal(naturalList(["Ava", "Leo", "Jordan", "ava"]), "Ava, Leo, and Jordan");
});

test("comma and semicolon group members are parsed and normalized duplicates are removed", () => {
  assert.deepEqual(
    splitTextNumbers("+1 202-555-0101; (202) 555-0101, +12025550102;;"),
    ["+1 202-555-0101", "+12025550102"],
  );
  assert.deepEqual(splitTextNumbers(" ; , "), []);
});

test("individual mode creates one group target for all numbers in a cell", () => {
  const multiNumberRows = [{
    ...rows[0],
    values: { ...rows[0].values, "Parent Phone": "+12025550101; +12025550104, +12025550105" },
  }];
  const originalValue = multiNumberRows[0].values["Parent Phone"];
  const units = buildRecipientUnits({ rows: multiNumberRows, deliveryMode: "individual", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 1);
  assert.equal(units[0].id, "row-2");
  assert.deepEqual(units[0].addresses, ["+12025550101", "+12025550104", "+12025550105"]);
  assert.equal(units[0].address, "+12025550101; +12025550104; +12025550105");
  assert.equal(units[0].values["Parent Phone"], units[0].address);
  assert.equal(units[0].recipientCount, 3);
  assert.equal(multiNumberRows[0].values["Parent Phone"], originalValue);
});

test("household mode combines only rows with the same complete recipient set", () => {
  const multiNumberRows = [
    { ...rows[0], values: { ...rows[0].values, "Parent Phone": "+12025550101; +12025550104" } },
    { ...rows[1], values: { ...rows[1].values, "Parent Phone": "+1 202-555-0104, (202) 555-0101" } },
    { ...rows[2], values: { ...rows[2].values, "Parent Phone": "+12025550101" } },
  ];
  const units = buildRecipientUnits({ rows: multiNumberRows, deliveryMode: "household", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.athleteNames), ["Ava Ramirez and Leo Ramirez", "Jordan Lee"]);
  assert.deepEqual(units.map((unit) => unit.athleteCount), [2, 1]);
  assert.deepEqual(units[0].addresses, ["+12025550101", "+12025550104"]);
  assert.equal(units[0].values["Parent Phone"], "+12025550101; +12025550104");
});

test("an invalid group member remains in the same atomic target", () => {
  const mixedRows = [{
    ...rows[0],
    values: { ...rows[0].values, "Parent Phone": "+12025550101, call the office" },
  }];
  const units = buildRecipientUnits({ rows: mixedRows, deliveryMode: "individual", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 1);
  assert.deepEqual(units[0].addresses, ["+12025550101", "call the office"]);
});

test("invalid or empty household recipient sets stay isolated by roster row", () => {
  const invalidRows = rows.slice(0, 2).map((row) => ({ ...row, values: { ...row.values, "Parent Phone": " ; , " } }));
  const units = buildRecipientUnits({ rows: invalidRows, deliveryMode: "household", nameColumn: "Athlete", phoneColumn: "Parent Phone", columns });
  assert.equal(units.length, 2);
  assert.deepEqual(units.map((unit) => unit.addresses), [[], []]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildRecipientUnits, naturalList } from "../web/src/recipientModel.js";

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

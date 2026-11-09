import assert from "node:assert/strict";
import test from "node:test";
import { addFieldBaseTypes } from "../src/mbql.js";

const fieldMetadata = {
  fields: [
    { name: "AMOUNT", base_type: "type/Decimal" },
    { name: "STATUS", base_type: "type/Text" },
    { name: "CREATED_AT", base_type: "type/DateTime" },
  ],
};

test("adds metadata-derived base types to filter field references", () => {
  const query = {
    stages: [{
      filters: [["=", {}, ["field", {}, "STATUS"], "paid"]],
    }],
  };

  assert.deepEqual(addFieldBaseTypes(query, fieldMetadata), {
    stages: [{
      filters: [["=", {}, ["field", { "base-type": "type/Text" }, "STATUS"], "paid"]],
    }],
  });
});

test("adds metadata-derived base types to aggregation field references", () => {
  const query = {
    stages: [{
      aggregation: [["sum", {}, ["field", {}, "AMOUNT"]]],
      breakout: [["field", {}, "CREATED_AT"]],
    }],
  };

  assert.deepEqual(addFieldBaseTypes(query, fieldMetadata), {
    stages: [{
      aggregation: [[
        "sum",
        {},
        ["field", { "base-type": "type/Decimal" }, "AMOUNT"],
      ]],
      breakout: [["field", { "base-type": "type/DateTime" }, "CREATED_AT"]],
    }],
  });
});

test("uses source metadata instead of retaining a model-generated base type", () => {
  const query = {
    stages: [{
      filters: [[
        "=",
        {},
        ["field", { "base-type": "type/Integer" }, "STATUS"],
        "paid",
      ]],
    }],
  };

  assert.deepEqual(addFieldBaseTypes(query, fieldMetadata), {
    stages: [{
      filters: [[
        "=",
        {},
        ["field", { "base-type": "type/Text" }, "STATUS"],
        "paid",
      ]],
    }],
  });
});

test("does not alter numeric field references", () => {
  const query = { stages: [{ aggregation: [["count", ["field", {}, 42]]] }] };
  assert.equal(addFieldBaseTypes(query, undefined), query);
});

test("rejects string field references without matching metadata", () => {
  assert.throws(
    () => addFieldBaseTypes(
      { stages: [{ filters: [["=", {}, ["field", {}, "UNKNOWN"], "value"]] }] },
      fieldMetadata,
    ),
    /was not found in the source metadata/,
  );
  assert.throws(
    () => addFieldBaseTypes(
      { stages: [{ aggregation: [["sum", {}, ["field", {}, "AMOUNT"]]] }] },
      { fields: [{ name: "AMOUNT" }] },
    ),
    /without field metadata/,
  );
});

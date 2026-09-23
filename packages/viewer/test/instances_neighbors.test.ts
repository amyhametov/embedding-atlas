// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import * as SQL from "@uwdata/mosaic-sql";
import { describe, expect, test } from "vitest";

import {
  activeNeighborsAnchor,
  isSameNeighborsTarget,
  nearestNeighborsQuery,
  neighborsTargetFromHighlight,
} from "../src/charts/instances/neighbors.js";

describe("neighborsTargetFromHighlight", () => {
  test("only a single highlighted point has neighbors", () => {
    expect(neighborsTargetFromHighlight(null, null)).toBe(null);
    expect(neighborsTargetFromHighlight([], null)).toBe(null);
    expect(neighborsTargetFromHighlight([1, 2], null)).toBe(null);
    expect(neighborsTargetFromHighlight([5], '("x" > 1)')).toEqual({ id: 5, predicate: '("x" > 1)' });
  });

  test("keeps falsy ids", () => {
    expect(neighborsTargetFromHighlight([0], null)).toEqual({ id: 0, predicate: null });
  });
});

describe("activeNeighborsAnchor", () => {
  test("shows neighbors while the filter is unchanged", () => {
    let target = neighborsTargetFromHighlight([0], null);
    expect(activeNeighborsAnchor(target, null)).toBe(0);
    expect(activeNeighborsAnchor(null, null)).toBeUndefined();
  });

  test("a brush after the selection shows the full list, clearing it shows the neighbors again", () => {
    let target = neighborsTargetFromHighlight([7], null);
    expect(activeNeighborsAnchor(target, '("x" BETWEEN 0 AND 1)')).toBeUndefined();
    expect(activeNeighborsAnchor(target, null)).toBe(7);
  });
});

test("isSameNeighborsTarget", () => {
  expect(isSameNeighborsTarget(null, null)).toBe(true);
  expect(isSameNeighborsTarget({ id: 1, predicate: null }, null)).toBe(false);
  expect(isSameNeighborsTarget({ id: 1, predicate: null }, { id: 1, predicate: null })).toBe(true);
  expect(isSameNeighborsTarget({ id: 1, predicate: null }, { id: 1, predicate: "(true)" })).toBe(false);
});

describe("nearestNeighborsQuery", () => {
  test("selects the point and its neighbors, ranked by distance", () => {
    let query = nearestNeighborsQuery({ table: "data", id: "id", neighbors: "knn", anchor: 3 });
    expect(query.toString()).toBe(
      `SELECT *, CASE WHEN ("id" = 3) THEN 0 ELSE list_position((SELECT struct_extract("knn", 'ids') AS "ids" FROM "data" WHERE ("id" = 3)), "id") END AS "__neighbor_rank" FROM "data" WHERE (("id" = 3) OR ("id" IN (SELECT UNNEST(struct_extract("knn", 'ids')) AS "id" FROM "data" WHERE ("id" = 3))))`,
    );
  });

  test("applies the filter predicate", () => {
    let query = nearestNeighborsQuery({
      table: "data",
      id: "id",
      neighbors: "knn",
      anchor: "a'b",
      predicate: [SQL.gt(SQL.column("x"), 1)],
    });
    let sql = query.toString();
    expect(sql).toContain(`("id" = 'a''b')`);
    // The point itself is shown even if the filter excludes it; the filter applies to its neighbors.
    expect(sql).toContain(`WHERE (("id" = 'a''b') OR (("id" IN (SELECT`);
    expect(sql.endsWith(`AND (("x" > 1))))`)).toBe(true);
  });

  test("parenthesizes verbatim filter clauses", () => {
    // E.g., the SQL predicates view with two selected predicates.
    let query = nearestNeighborsQuery({
      table: "data",
      id: "id",
      neighbors: "knn",
      anchor: 3,
      predicate: [SQL.asVerbatim("(a > 1) OR (b > 1)")],
    });
    expect(query.toString().endsWith(`AND ((a > 1) OR (b > 1))))`)).toBe(true);
  });
});

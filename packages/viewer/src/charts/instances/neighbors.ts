// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

// Helpers for showing the nearest neighbors of the selected point in the instances view.
// Kept free of database and browser dependencies so they can be unit tested directly.

import * as SQL from "@uwdata/mosaic-sql";

import type { RowID } from "../chart.js";

/** Name of the column with the rank of a row in the neighbors list (0 for the selected point itself). */
export const NEIGHBOR_RANK_COLUMN = "__neighbor_rank";

/** The point whose neighbors to show, and the filter predicate (as SQL string) at the time it was selected. */
export interface NeighborsTarget {
  id: RowID;
  predicate: string | null;
}

/** Returns the neighbors target for the given highlight: only a single highlighted point has neighbors. */
export function neighborsTargetFromHighlight(
  highlight: RowID[] | null | undefined,
  predicate: string | null,
): NeighborsTarget | null {
  if (highlight == null || highlight.length != 1) {
    return null;
  }
  return { id: highlight[0], predicate: predicate };
}

export function isSameNeighborsTarget(a: NeighborsTarget | null, b: NeighborsTarget | null): boolean {
  if (a == null || b == null) {
    return a == b;
  }
  return a.id === b.id && a.predicate === b.predicate;
}

/**
 * Returns the id of the point whose neighbors to show under the given filter predicate, or undefined to show the full list.
 * Neighbors are shown only while the filter is the one the point was selected with,
 * so that a later brush or lasso shows its points as usual (the most recent interaction wins).
 */
export function activeNeighborsAnchor(target: NeighborsTarget | null, predicate: string | null): RowID | undefined {
  if (target == null || target.predicate !== predicate) {
    return undefined;
  }
  return target.id;
}

/**
 * Returns a query for the given point and its nearest neighbors (the neighbors limited by the predicate),
 * with a `NEIGHBOR_RANK_COLUMN` column to order them: the point itself first, then its neighbors, closest first.
 * The neighbors column has the format `{ ids: [...], distances: [...] }`, with `ids` sorted by distance.
 */
export function nearestNeighborsQuery(options: {
  table: string;
  id: string;
  neighbors: string;
  anchor: RowID;
  predicate?: SQL.FilterExpr | null;
}): SQL.SelectQuery {
  let id = SQL.column(options.id);
  let isAnchor = SQL.eq(id, SQL.literal(options.anchor));
  let neighborIds = SQL.sql`struct_extract(${SQL.column(options.neighbors)}, 'ids')`;
  let ids = SQL.Query.from(options.table).select({ ids: neighborIds }).where(isAnchor);
  let members = SQL.Query.from(options.table)
    .select({ id: SQL.unnest(neighborIds) })
    .where(isAnchor);
  // The list may or may not include the point itself; either way it comes first.
  let rank = SQL.sql`CASE WHEN ${isAnchor} THEN 0 ELSE list_position((${ids}), ${id}) END`;
  // The point itself is shown even if the filter excludes it. Each filter clause is parenthesized,
  // as it can be verbatim SQL with a top-level OR (e.g., from the SQL predicates view).
  let clauses = [options.predicate ?? []]
    .flat()
    .filter((p) => p != null)
    .map((p) => SQL.sql`(${p})`);
  return SQL.Query.from(options.table)
    .select("*", { [NEIGHBOR_RANK_COLUMN]: rank })
    .where(SQL.or(isAnchor, SQL.and(SQL.isIn(id, [members]), ...clauses)));
}

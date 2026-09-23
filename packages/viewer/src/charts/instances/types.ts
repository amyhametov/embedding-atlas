// Copyright (c) 2025 Apple Inc. Licensed under MIT License.

import type { ColumnStyle } from "../../renderers/types.js";

export type SortOrder = { column: string; direction: "ascending" | "descending" }[];

export interface InstancesSpec {
  type: "instances";
  title?: string;

  /**
   * Columns to show in the instance view.
   * If specified, the table and card views will be limited to the given columns, and custom card template will only receive the given columns as data.
   * If not specified, include all columns from the dataset (or query result is `query` is specified).
   */
  columns?: string[];

  /** Sort order. If not specified, use original data order. */
  sort?: SortOrder;

  /** View mode, defaults to "table" */
  viewMode?: "table" | "cards";

  /** Optional custom SQL query to filter or transform the data */
  query?: string;

  /**
   * The column with pre-computed nearest neighbors, in the same format as the `neighbors` data column:
   * `{ "ids": [id1, id2, ...], "distances": [d1, d2, ...] }` with `ids` sorted by distance.
   * If specified, when a single point is selected in another view (e.g., by clicking it in the embedding view),
   * this view shows the point followed by its nearest neighbors, closest first, instead of the regular list.
   * The neighbors are limited to the current filter, and `sort` does not apply to them.
   * Changing the filter afterwards (e.g., with a brush or lasso) or clearing the selection shows the regular list again.
   * Ignored when `query` is specified.
   */
  neighbors?: string | null;

  /** Number of items per page, defaults to 100 */
  pageSize?: number;

  /** Default height in pixels, defaults to 500. This value is used when the view's height is flexible. */
  defaultHeight?: number;

  /** Column styles specific to this instance view. These will override global column styles. */
  columnStyles?: Record<string, ColumnStyle>;

  /**
   * Liquid template for the cards (rendered with liquidjs). If not specified, uses the default card with column styles.
   * The card will be placed in a <div> container with a border and rounded corner, but no padding — add your own padding to the root element.
   *
   * Each column value is available as a template variable (e.g. `{{ title }}`, `{{ price }}`).
   *
   * To support dark mode, use CSS custom properties defined in a <style> tag inside a wrapper element. Define light-mode values on the wrapper class, then override them under `.dark`:
   * ```
   * <div class="my-card" style="padding: 16px">
   *   <style>
   *     .my-card { --text-color: #1a1a2e; }
   *     .my-card, .my-card:is(.dark *) { --text-color: #f1f5f9; }
   *   </style>
   *   <div style="color: var(--text-color)">{{ title }}</div>
   * </div>
   * ```
   * The `.dark` class is applied to an ancestor element when dark mode is active. Use `:is(.dark *)` for reliable matching regardless of DOM depth.
   */
  cardTemplate?: string;
}

export interface InstancesState {
  offset?: number;
}

<!-- Copyright (c) 2025 Apple Inc. Licensed under MIT License. -->
<script lang="ts">
  import { deepMemo } from "@embedding-atlas/utils";
  import { makeClient } from "@uwdata/mosaic-core";
  import * as SQL from "@uwdata/mosaic-sql";
  import { untrack } from "svelte";

  import PaginatorControls from "../../widgets/PaginatorControls.svelte";
  import SegmentedControl from "../../widgets/SegmentedControl.svelte";
  import Cards from "./Cards.svelte";
  import SortOrderControl from "./SortOrderControl.svelte";
  import Table from "./Table.svelte";

  import { IconCardView, IconClose, IconRight, IconTableView } from "../../assets/icons.js";
  import type { ColumnStyle } from "../../renderers/types.js";
  import { predicateToString } from "../../utils/database.js";
  import { isolatedWritable } from "../../utils/store.js";
  import type { ChartViewProps, RowID } from "../chart.js";
  import {
    activeNeighborsAnchor,
    isSameNeighborsTarget,
    NEIGHBOR_RANK_COLUMN,
    nearestNeighborsQuery,
    neighborsTargetFromHighlight,
    type NeighborsTarget,
  } from "./neighbors.js";
  import { instancesQuery } from "./query.js";
  import type { InstancesSpec, InstancesState, SortOrder } from "./types.js";

  let {
    context,
    spec,
    state: chartState,
    height,
    onSpecChange,
    onStateChange,
  }: ChartViewProps<InstancesSpec, InstancesState> = $props();

  // svelte-ignore state_referenced_locally
  let { columnStyles: contextColumnStyles, textHighlight } = context;

  // Merge spec columnStyles with global ones (spec takes precedence)
  let columnStyles = $derived({ ...$contextColumnStyles, ...spec.columnStyles });

  // svelte-ignore state_referenced_locally
  let highlight = context.highlight;
  let isolatedHighlight = isolatedWritable(highlight);

  let viewMode = $derived((spec.viewMode ?? "table") as "table" | "cards");
  let neighborsEnabled = $derived(spec.neighbors != null && spec.query == null);
  let offset = $derived(chartState.offset ?? 0);
  let pageSize = $derived(spec.pageSize ?? 50);

  let contentView = $state.raw<Table | Cards | undefined>(undefined);
  let viewContainer = $state.raw<HTMLElement | undefined>(undefined);

  // Column widths (local state, not persisted)
  let defaultColumnWidths = $state.raw<Record<string, number>>({});

  // The point to show nearest neighbors for (see `spec.neighbors`), selected in another view.
  let neighborsTarget = $state.raw<NeighborsTarget | null>(null);

  // Returns true if the target changed.
  function setNeighborsTarget(target: NeighborsTarget | null): boolean {
    let current = untrack(() => neighborsTarget);
    if (isSameNeighborsTarget(target, current)) {
      return false;
    }
    neighborsTarget = target;
    return true;
  }

  // Subscribe to highlight changes
  $effect.pre(() => {
    let isOnMount = true;
    let previousValue: RowID[] | null = null;
    return isolatedHighlight.subscribe((v) => {
      let target = neighborsTargetFromHighlight(v, predicateToString(context.filter.predicate(null)));
      let neighborsTargetChanged = setNeighborsTarget(target);
      // Don't animate immediately on mount.
      if (isOnMount) {
        isOnMount = false;
        previousValue = v;
        return;
      }
      revealOnLoad = undefined;
      let newIDs = v ?? [];
      let oldIDs = previousValue ?? [];
      let enteringIDs = newIDs.filter((x) => oldIDs.indexOf(x) < 0);
      // The list changes if it shows neighbors now, or will show them for the new target.
      let listChanges =
        neighborsTargetChanged &&
        untrack(() => neighborsEnabled) &&
        (target != null || untrack(() => data?.neighborsOf) != null);
      if (listChanges) {
        // The list changes to the new point and its neighbors (or back to the regular list), show it from the top.
        resetOffset();
        if (target == null && enteringIDs.length == 1) {
          // E.g., Shift-click adds a second point: reveal it once the regular list is loaded.
          revealOnLoad = enteringIDs[0];
        }
      } else if (enteringIDs.length == 1) {
        // Animate when a single new point is added.
        animateToPoint(enteringIDs[0]);
      }
      previousValue = v;
    });
  });

  interface Data {
    data: Record<string, any>[];
    columns: string[];
    offset: number;

    /** The point whose nearest neighbors are shown, if any. */
    neighborsOf?: RowID;

    offsetForId?: (id: RowID) => Promise<number | undefined>;
  }

  // Data loading
  let totalCount = $state.raw(0);
  let data = $state.raw<Data | undefined>(undefined);

  // Derive current page and page count for PaginatorControls
  let currentPage = $derived(Math.floor(offset / pageSize));
  let pageCount = $derived(Math.ceil(totalCount / pageSize));

  // Reset the offset and scroll to top.
  function resetOffset() {
    untrack(() => {
      if (offset != 0) {
        onStateChange((draft) => {
          draft.offset = 0;
        });
      }
      if (viewContainer) {
        viewContainer.scrollTop = 0;
      }
    });
  }

  function createClients(options: {
    query?: string;
    neighbors?: string | null;
    columns?: string[];
    columnStyles: Record<string, ColumnStyle>;
    sort?: SortOrder;
    pageSize: number;
  }) {
    let isOriginalTable = options.query == undefined;
    // Nearest neighbors are only available for the original table.
    let neighbors = isOriginalTable ? options.neighbors : null;
    let currentNeighborsTarget = () => (neighbors != null ? neighborsTarget : null);
    // The point to show neighbors for under the given predicate, or undefined to show all data.
    let neighborsAnchor = (predicate?: SQL.FilterExpr | null): RowID | undefined =>
      activeNeighborsAnchor(currentNeighborsTarget(), predicateToString(predicate ?? undefined));

    let baseQuery = (predicate?: SQL.FilterExpr | null, anchor?: RowID) =>
      neighbors != null && anchor !== undefined
        ? nearestNeighborsQuery({ table: context.table, id: context.id, neighbors, anchor, predicate })
        : instancesQuery({ query: options.query, table: context.table, predicate: predicate });

    // Build orderby expressions from sort specification
    let orderByExprs = (options.sort ?? []).map((s) => {
      let col = SQL.column(s.column);
      return s.direction === "descending" ? SQL.desc(col) : SQL.asc(col);
    });
    // Neighbors are ordered by distance instead.
    let orderBy = (anchor?: RowID) =>
      anchor !== undefined ? [SQL.asc(SQL.column(NEIGHBOR_RANK_COLUMN))] : orderByExprs;

    let columnNames: string[] = [];
    let lastQueryOffset = 0;
    let lastQueryPredicate: SQL.FilterExpr | undefined = undefined;
    let lastQueryAnchor: RowID | undefined = undefined;
    let lastQueryNeighborsTarget = untrack(currentNeighborsTarget);

    let clientTotal = makeClient({
      coordinator: context.coordinator,
      selection: context.filter,
      // The query depends on the neighbors target besides the filter, so don't use pre-aggregation.
      filterStable: neighbors == null,
      query: (predicate) => {
        return SQL.Query.from(baseQuery(predicate, neighborsAnchor(predicate))).select({ count: SQL.count() });
      },
      queryResult: (result: any) => {
        totalCount = result.get(0).count;
      },
    });

    let client = makeClient({
      coordinator: context.coordinator,
      selection: context.filter,
      prepare: async () => {
        let desc = await context.coordinator.query(SQL.Query.describe(baseQuery()));
        columnNames = desc
          .toArray()
          .map((x) => x.column_name)
          .filter((x) => !x.startsWith("__"));
        if (options.columns) {
          let specifiedColumns = new Set(options.columns);
          columnNames = columnNames.filter((x) => specifiedColumns.has(x));
        }
        // Filter out hidden columns
        columnNames = columnNames.filter((col) => options.columnStyles[col]?.display !== "hidden");

        // Get sample data for column widths
        let widthQuery = SQL.Query.from(baseQuery())
          .select(
            Object.fromEntries([
              ...(isOriginalTable ? [["__id__", SQL.column(context.id)]] : []),
              ...columnNames.map((x) => [x, SQL.column(x)]),
            ]),
          )
          .limit(10)
          .offset(0);
        let widthResult = await context.coordinator.query(widthQuery);
        let sampleData = widthResult.toArray();
        defaultColumnWidths = Object.fromEntries(
          columnNames.map((col) => [
            col,
            sampleData.reduce(
              (max: number, row: any) => Math.max(max, widthForContent(row[col])),
              widthForContent(col), // Also take column name into account
            ),
          ]),
        );
      },
      query: (predicate) => {
        lastQueryOffset = offset;
        lastQueryPredicate = predicate;
        lastQueryNeighborsTarget = currentNeighborsTarget();
        lastQueryAnchor = neighborsAnchor(predicate);
        return SQL.Query.from(baseQuery(predicate, lastQueryAnchor))
          .select(
            Object.fromEntries([
              ...(isOriginalTable ? [["__id__", SQL.column(context.id)]] : []),
              ...columnNames.map((x) => [x, SQL.column(x)]),
            ]),
          )
          .orderby(orderBy(lastQueryAnchor))
          .limit(options.pageSize)
          .offset(offset);
      },
      queryResult: (result: any) => {
        data = {
          data: result.toArray(),
          columns: columnNames,
          offset: lastQueryOffset,
          neighborsOf: lastQueryAnchor,
          offsetForId: isOriginalTable
            ? async (id) => {
                // Build ROW_NUMBER window function with same sort order as main query
                let order = orderBy(lastQueryAnchor);
                let idOffset = SQL.Query.from(baseQuery(lastQueryPredicate, lastQueryAnchor)).select({
                  id: SQL.column(context.id),
                  offset: order.length > 0 ? SQL.row_number().orderby(...order) : SQL.row_number(),
                });
                let query = SQL.Query.from(idOffset)
                  .select({ offset: SQL.column("offset") })
                  .where(SQL.eq(SQL.column("id"), SQL.literal(id)));
                let result = await context.coordinator.query(query);
                return result.get(0)?.offset;
              }
            : undefined,
        };
      },
    });

    $effect.pre(() => {
      // Read both, so the effect reruns when either changes.
      let currentOffset = offset;
      let target = currentNeighborsTarget();
      if (target !== lastQueryNeighborsTarget) {
        // When the neighbors target changes, rerun both queries.
        clientTotal.requestQuery();
        client.requestQuery();
      } else if (currentOffset != lastQueryOffset) {
        // When offset changes, rerun the query.
        client.requestQuery();
      }
    });

    return () => {
      clientTotal.destroy();
      client.destroy();
    };
  }

  // Reset offset and create a new client when critical parts of the spec change
  let clientsParams = $derived.by(
    deepMemo(() => ({
      query: spec.query,
      neighbors: spec.neighbors,
      columns: spec.columns,
      columnStyles: columnStyles,
      sort: spec.sort,
      pageSize: pageSize,
    })),
  );

  $effect.pre(() => {
    resetOffset();
    return createClients(clientsParams);
  });

  // Reset offset when predicate changes
  $effect.pre(() => {
    let callback = () => {
      resetOffset();
    };
    context.filter.addEventListener("value", callback);
    return () => {
      context.filter.removeEventListener("value", callback);
    };
  });

  // Calculate width based on content length
  function widthForContent(content: any): number {
    let characterLength = String(content).length;
    return Math.min(600, Math.max(80, characterLength * 8 + 40));
  }

  const scrollParameters = {
    behavior: "smooth",
    block: "center",
    container: "nearest",
  } as const;

  // Animate to a point. When the point is in the same page, scroll to the point;
  // otherwise, go to the page with the point, and reveal the element directly.
  async function animateToPoint(id: RowID) {
    if (spec.query != null) {
      // For custom queries we do not animate.
      return;
    }
    if (data == null) {
      return;
    }

    // Check if highlighted item is in current page
    let isInCurrentPage = data.data.some((row) => row.__id__ === id);
    if (isInCurrentPage) {
      contentView?.getElementForId(id)?.scrollIntoView(scrollParameters);
    } else {
      let newOffset = await data?.offsetForId?.(id);
      if (newOffset != undefined) {
        // Make sure it's a multiple of page number.
        newOffset = Math.floor(newOffset / pageSize) * pageSize;
        scrollToOnLoadPage = { offset: newOffset, id: id };
        onStateChange((draft) => {
          draft.offset = newOffset;
        });
      }
    }
  }

  let scrollToOnLoadPage = $state.raw<{ offset: number; id: RowID } | undefined>(undefined);

  // Helper effect for animateToPoint, to show the new point when switching to a new page.
  $effect(() => {
    if (!scrollToOnLoadPage) {
      return;
    }
    let scrollTo = scrollToOnLoadPage;
    let currentData = data;
    if (currentData?.offset == scrollTo.offset) {
      scrollToOnLoadPage = undefined;
      untrack(() => {
        contentView?.getElementForId(scrollTo.id)?.scrollIntoView(scrollParameters);
      });
    }
  });

  // A point to reveal once the regular list is loaded (see the highlight subscription).
  let revealOnLoad = $state.raw<RowID | undefined>(undefined);
  $effect(() => {
    let id = revealOnLoad;
    if (id === undefined || data == null || data.neighborsOf != null) {
      return;
    }
    revealOnLoad = undefined;
    untrack(() => animateToPoint(id));
  });

  function handlePageChange(page: number) {
    onStateChange((draft) => {
      draft.offset = page * pageSize;
    });
  }

  function handleLoadNext() {
    onStateChange((draft) => {
      draft.offset = Math.min(totalCount - 1, offset + pageSize);
    });
  }

  function handleRowClick(rowId: RowID | null | undefined, event: MouseEvent) {
    if (rowId == null) {
      return;
    }
    isolatedHighlight.update((value) => {
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        if (value == null) {
          return [rowId];
        }
        if (value.indexOf(rowId) >= 0) {
          return value.filter((x) => x != rowId);
        } else {
          return [...value, rowId];
        }
      } else {
        if (value != null && value.length == 1 && value.indexOf(rowId) >= 0) {
          return null;
        } else {
          return [rowId];
        }
      }
    });
    let selection = $highlight;
    if (selection == null || selection.length == 0) {
      // Clearing the selection shows the regular list again.
      clearNeighbors();
    } else if (data?.neighborsOf == null && !(selection.length == 1 && selection[0] === neighborsTarget?.id)) {
      // The list shows other rows (e.g., within a brush) and stays as is, but the neighbors of
      // a point that is no longer selected shouldn't come back when the filter changes back.
      setNeighborsTarget(null);
    }
  }

  function clearNeighbors() {
    // Show the regular list from the top, if the list showed neighbors.
    if (setNeighborsTarget(null) && data?.neighborsOf != null) {
      resetOffset();
    }
  }

  // A single selected point whose neighbors are not shown, e.g., after clicking its card. Tapping it on the
  // map again does nothing (the selection doesn't change), so the header offers to show its neighbors.
  let neighborsCandidate = $derived(
    neighborsEnabled && $highlight != null && $highlight.length == 1 && $highlight[0] !== neighborsTarget?.id
      ? $highlight[0]
      : undefined,
  );

  function showNeighborsOf(id: RowID) {
    if (setNeighborsTarget({ id: id, predicate: predicateToString(context.filter.predicate(null)) })) {
      resetOffset();
    }
  }
</script>

<div
  class="w-full flex flex-col overflow-hidden rounded-md bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
  style:height={`${height ?? spec.defaultHeight ?? 500}px`}
>
  <div class="flex items-center justify-between p-2 border-b border-slate-200 dark:border-slate-700 gap-4">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
      <SegmentedControl
        value={viewMode}
        onChange={(v) =>
          onSpecChange((draft) => {
            draft.viewMode = v as "table" | "cards";
          })}
        options={[
          { value: "table", icon: IconTableView, title: "Table view" },
          { value: "cards", icon: IconCardView, title: "Card view" },
        ]}
      />
      <PaginatorControls currentPage={currentPage} pageCount={pageCount} onChange={handlePageChange} />
      {#if data?.neighborsOf != null}
        <!-- The whole chip clears the selection: an easy target on touch screens. -->
        <button
          class="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded-md text-slate-500 dark:text-slate-400 select-none"
          title="Clear selection"
          onclick={() => {
            clearNeighbors();
            highlight.set(null);
          }}
        >
          Neighbors of #{data.neighborsOf}
          <IconClose />
        </button>
      {:else}
        <SortOrderControl
          value={spec.sort}
          onChange={(value) =>
            onSpecChange((draft) => {
              draft.sort = value;
            })}
        />
      {/if}
      {#if neighborsCandidate !== undefined}
        {@const id = neighborsCandidate}
        <button
          class="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded-md text-slate-500 dark:text-slate-400 select-none"
          title="Show the nearest neighbors of the selected point"
          onclick={() => showNeighborsOf(id)}
        >
          Show neighbors of #{id}
        </button>
      {/if}
    </div>
  </div>

  <div class="flex-1 min-h-0 overflow-auto" bind:this={viewContainer}>
    {#if data != null}
      {#if viewMode === "table"}
        <Table
          bind:this={contentView}
          context={context}
          data={data.data}
          columns={data.columns}
          columnDescs={context.tables[context.table]?.columns ?? []}
          columnStyles={columnStyles}
          defaultColumnWidths={defaultColumnWidths}
          highlight={$highlight}
          sort={spec.sort}
          sortable={data.neighborsOf == null}
          onRowClick={handleRowClick}
          onSortChange={(value) =>
            onSpecChange((draft) => {
              draft.sort = value;
            })}
        />

        {#if offset + pageSize < totalCount}
          <div class="p-3 flex justify-center">
            <button class="px-4 py-2 text-sm flex items-center gap-1" onclick={handleLoadNext}>
              Next Page
              <IconRight />
            </button>
          </div>
        {/if}
      {:else}
        <Cards
          bind:this={contentView}
          context={context}
          data={data.data}
          columns={data.columns}
          columnStyles={columnStyles}
          highlight={$highlight}
          cardTemplate={spec.cardTemplate}
          onRowClick={handleRowClick}
        />

        {#if offset + pageSize < totalCount}
          <div class="p-3 flex justify-center">
            <button class="px-4 py-2 text-sm flex items-center gap-1" onclick={handleLoadNext}>
              Next Page
              <IconRight />
            </button>
          </div>
        {/if}
      {/if}
    {:else}
      <div class="flex items-center justify-center h-full">
        <div class="text-slate-500 dark:text-slate-400">Loading...</div>
      </div>
    {/if}
  </div>
</div>

import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SummaryEntry } from "../controllers/summaries.ts";

export type SummariesProps = {
  loading: boolean;
  result: SummaryEntry[] | null;
  error: string | null;
  filterKey: string;
  filterQuery: string;
  filterFrom: string;
  filterTo: string;
  page: number;
  pageSize: number;
  onFiltersChange: (next: {
    filterKey: string;
    filterQuery: string;
    filterFrom: string;
    filterTo: string;
  }) => void;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
};

function formatDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) {
    return t("common.na");
  }
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateId(value: string): string {
  return value ? value.slice(0, 8) : "";
}

function extractSummaryText(summary: unknown): string {
  if (typeof summary === "string") {
    return summary;
  }
  if (summary && typeof summary === "object") {
    const obj = summary as Record<string, unknown>;
    if (typeof obj.summary === "string") {
      return obj.summary;
    }
    if (typeof obj.overview === "string") {
      return obj.overview;
    }
    if (typeof obj.topics === "string") {
      return obj.topics;
    }
    return JSON.stringify(summary, null, 2);
  }
  return summary == null ? "" : JSON.stringify(summary);
}

function getPagedResults(
  result: SummaryEntry[] | null,
  page: number,
  pageSize: number,
): SummaryEntry[] {
  if (!result?.length) {
    return [];
  }
  const start = page * pageSize;
  return result.slice(start, start + pageSize);
}

function getTotalPages(result: SummaryEntry[] | null, pageSize: number): number {
  if (!result?.length) {
    return 0;
  }
  return Math.ceil(result.length / pageSize);
}

function renderSummaryCard(row: SummaryEntry) {
  const text = extractSummaryText(row.summary);
  return html`
    <details class="card" style="padding: 14px; margin-top: 10px;">
      <summary
        style="cursor: pointer; display: flex; gap: 10px; flex-wrap: wrap; align-items: center;"
      >
        <span class="mono muted">${truncateId(row.sessionId)}</span>
        <span>${formatDate(row.endedAt || row.createdAt)}</span>
        <span>${t("summariesPage.messageCount", { count: String(row.messageCount) })}</span>
        <span class="mono muted">${row.sessionKey}</span>
      </summary>
      <div style="margin-top: 10px; white-space: pre-wrap; line-height: 1.55;">
        ${text || t("summariesPage.emptyFallback")}
      </div>
      <div class="muted" style="margin-top: 8px;">
        ${row.model
          ? html`${t("summariesPage.modelLabel")}: <span class="mono">${row.model}</span>`
          : nothing}
        ${row.summaryModel
          ? html`${row.model ? html` · ` : nothing}${t("summariesPage.summaryModelLabel")}:
              <span class="mono">${row.summaryModel}</span>`
          : nothing}
      </div>
    </details>
  `;
}

export function renderSummaries(props: SummariesProps) {
  const totalCount = props.result?.length ?? 0;
  const totalPages = getTotalPages(props.result, props.pageSize);
  const currentPage = totalPages === 0 ? 0 : Math.min(props.page, totalPages - 1);
  const rows = getPagedResults(props.result, currentPage, props.pageSize);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">${t("tabs.summaries")}</div>
          <div class="card-sub">
            ${totalCount > 0
              ? t("summariesPage.resultsFound", { count: String(totalCount) })
              : t("summariesPage.browseHint")}
          </div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
      </div>

      <div
        style="margin-top: 14px; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));"
      >
        <label class="field">
          <span>${t("summariesPage.sessionKey")}</span>
          <input
            .value=${props.filterKey}
            placeholder=${t("summariesPage.sessionKeyPlaceholder")}
            @input=${(event: Event) =>
              props.onFiltersChange({
                filterKey: (event.target as HTMLInputElement).value,
                filterQuery: props.filterQuery,
                filterFrom: props.filterFrom,
                filterTo: props.filterTo,
              })}
          />
        </label>
        <label class="field">
          <span>${t("common.search")}</span>
          <input
            .value=${props.filterQuery}
            placeholder=${t("summariesPage.queryPlaceholder")}
            @input=${(event: Event) =>
              props.onFiltersChange({
                filterKey: props.filterKey,
                filterQuery: (event.target as HTMLInputElement).value,
                filterFrom: props.filterFrom,
                filterTo: props.filterTo,
              })}
          />
        </label>
        <label class="field">
          <span>${t("summariesPage.fromLabel")}</span>
          <input
            .value=${props.filterFrom}
            placeholder=${t("summariesPage.fromPlaceholder")}
            @input=${(event: Event) =>
              props.onFiltersChange({
                filterKey: props.filterKey,
                filterQuery: props.filterQuery,
                filterFrom: (event.target as HTMLInputElement).value,
                filterTo: props.filterTo,
              })}
          />
        </label>
        <label class="field">
          <span>${t("summariesPage.toLabel")}</span>
          <input
            .value=${props.filterTo}
            placeholder=${t("summariesPage.toPlaceholder")}
            @input=${(event: Event) =>
              props.onFiltersChange({
                filterKey: props.filterKey,
                filterQuery: props.filterQuery,
                filterFrom: props.filterFrom,
                filterTo: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
      </div>

      <div class="muted" style="margin-top: 8px;">${t("summariesPage.wildcardHelp")}</div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}

      <div style="margin-top: 12px;">
        ${!props.loading && totalCount === 0
          ? html`<div class="muted">${t("summariesPage.noneFound")}</div>`
          : rows.map(renderSummaryCard)}
      </div>

      ${totalPages > 1
        ? html`
            <div
              style="margin-top: 16px; display: flex; gap: 12px; align-items: center; justify-content: center;"
            >
              <button
                class="btn btn--ghost"
                ?disabled=${currentPage === 0}
                @click=${() => props.onPageChange(currentPage - 1)}
              >
                ${t("summariesPage.prev")}
              </button>
              <span class="muted"
                >${t("summariesPage.pageOf", {
                  current: String(currentPage + 1),
                  total: String(totalPages),
                })}</span
              >
              <button
                class="btn btn--ghost"
                ?disabled=${currentPage >= totalPages - 1}
                @click=${() => props.onPageChange(currentPage + 1)}
              >
                ${t("summariesPage.next")}
              </button>
            </div>
          `
        : nothing}
    </section>
  `;
}

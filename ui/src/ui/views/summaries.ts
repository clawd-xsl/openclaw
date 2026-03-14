import { html, nothing } from "lit";
import type { SummaryEntry } from "../controllers/summaries.ts";
import { getPagedResults, getTotalPages } from "../controllers/summaries.ts";
import type { SummariesState } from "../controllers/summaries.ts";

export type SummariesProps = {
  state: SummariesState;
  loading: boolean;
  result: SummaryEntry[] | null;
  error: string | null;
  filterKey: string;
  filterQuery: string;
  filterFrom: string;
  filterTo: string;
  onFiltersChange: (next: {
    filterKey: string;
    filterQuery: string;
    filterFrom: string;
    filterTo: string;
  }) => void;
  onRefresh: () => void;
  onPageChange: (page: number) => void;
};

const SESSION_KEY_OPTIONS = [
  { value: "*", label: "All" },
  { value: "agent:main:main", label: "Main" },
  { value: "%subagent%", label: "Subagent" },
  { value: "%hook%", label: "Hook" },
  { value: "%cron%", label: "Cron" },
] as const;

function formatDate(ts: number): string {
  if (!ts) {
    return "n/a";
  }
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateId(id: string): string {
  return id ? id.slice(0, 8) : "";
}

function extractSummaryText(summary: unknown): string {
  if (typeof summary === "string") {
    return summary;
  }
  if (typeof summary === "object" && summary !== null) {
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
  return typeof summary === "undefined" ? "" : JSON.stringify(summary);
}

export function renderSummaries(props: SummariesProps) {
  const rows = getPagedResults(props.state);
  const totalPages = getTotalPages(props.state);
  const currentPage = props.state.summariesPage;
  const totalCount = props.state.summariesResult?.length ?? 0;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Session Summaries</div>
          <div class="card-sub">${totalCount > 0 ? `${totalCount} summaries found` : "Browse and search past session summaries."}</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px; display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
        <label class="field">
          <span>Session Type</span>
          <select
            @change=${(e: Event) =>
              props.onFiltersChange({
                filterKey: (e.target as HTMLSelectElement).value,
                filterQuery: props.filterQuery,
                filterFrom: props.filterFrom,
                filterTo: props.filterTo,
              })}
          >
            ${SESSION_KEY_OPTIONS.map(
              (opt) =>
                html`<option value=${opt.value} ?selected=${props.filterKey === opt.value}>
                  ${opt.label}
                </option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>Search</span>
          <input
            .value=${props.filterQuery}
            placeholder="keyword search…"
            @input=${(e: Event) =>
              props.onFiltersChange({
                filterKey: props.filterKey,
                filterQuery: (e.target as HTMLInputElement).value,
                filterFrom: props.filterFrom,
                filterTo: props.filterTo,
              })}
          />
        </label>
        <label class="field">
          <span>From</span>
          <input
            .value=${props.filterFrom}
            placeholder="7d or 2026-01-01"
            @input=${(e: Event) =>
              props.onFiltersChange({
                filterKey: props.filterKey,
                filterQuery: props.filterQuery,
                filterFrom: (e.target as HTMLInputElement).value,
                filterTo: props.filterTo,
              })}
          />
        </label>
        <label class="field">
          <span>To</span>
          <input
            .value=${props.filterTo}
            placeholder="now"
            @input=${(e: Event) =>
              props.onFiltersChange({
                filterKey: props.filterKey,
                filterQuery: props.filterQuery,
                filterFrom: props.filterFrom,
                filterTo: (e.target as HTMLInputElement).value,
              })}
          />
        </label>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      <div style="margin-top: 16px;">
        ${
          totalCount === 0 && !props.loading
            ? html`
                <div class="muted">No summaries found.</div>
              `
            : rows.map((row) => renderSummaryCard(row))
        }
      </div>

      ${
        totalPages > 1
          ? html`
        <div style="margin-top: 16px; display: flex; justify-content: center; align-items: center; gap: 12px;">
          <button class="btn" ?disabled=${currentPage === 0} @click=${() => props.onPageChange(currentPage - 1)}>← Prev</button>
          <span style="font-size: 0.9em; opacity: 0.7;">Page ${currentPage + 1} of ${totalPages}</span>
          <button class="btn" ?disabled=${currentPage >= totalPages - 1} @click=${() => props.onPageChange(currentPage + 1)}>Next →</button>
        </div>
      `
          : nothing
      }
    </section>
  `;
}

function renderSummaryCard(row: SummaryEntry) {
  const text = extractSummaryText(row.summary);
  return html`
    <details class="card" style="margin-bottom: 8px; padding: 12px;">
      <summary style="cursor: pointer; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <span class="mono" style="font-size: 0.85em; opacity: 0.7;">${truncateId(row.sessionId)}</span>
        <span style="font-size: 0.85em; opacity: 0.7;">${formatDate(row.createdAt)} — ${formatDate(row.endedAt)}</span>
        <span style="font-size: 0.85em; opacity: 0.7;">${row.messageCount} msgs</span>
        <span class="mono" style="font-size: 0.8em; opacity: 0.5;">${row.sessionKey}</span>
      </summary>
      <div style="margin-top: 10px; white-space: pre-wrap; font-size: 0.9em; line-height: 1.5;">
        ${text}
      </div>
      <div class="muted" style="margin-top: 6px; font-size: 0.8em;">
        <span class="mono">${row.sessionKey}</span>
        ${row.model ? html` · Model: ${row.model}` : nothing}
        ${row.summaryModel ? html` · Summary: ${row.summaryModel}` : nothing}
      </div>
    </details>
  `;
}

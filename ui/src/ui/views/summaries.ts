// Control UI view renders paginated session summary history.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { SessionSummaryHistoryItem } from "../controllers/summaries.ts";
import { formatDateTimeMs } from "../format.ts";

export type SessionSummaryAgentOption = {
  id: string;
  label: string;
};

export type SessionSummariesProps = {
  items: SessionSummaryHistoryItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  unavailable: boolean;
  nextCursor: string | null;
  selectedAgentId: string | null;
  agentOptions: SessionSummaryAgentOption[];
  searchInput: string;
  query: string;
  onSelectAgent: (agentId: string | null) => void;
  onSearchInput: (query: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onRefresh: () => void;
  onLoadMore: () => void;
};

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return formatDateTimeMs(
    timestamp,
    {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
    value,
  );
}

function renderSummaryState(props: {
  className: string;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return html`
    <div class="summaries-state ${props.className}" role="status">
      <div class="summaries-state__title">${props.title}</div>
      <div class="summaries-state__body">${props.body}</div>
      ${props.actionLabel && props.onAction
        ? html`
            <button class="btn btn--sm" type="button" @click=${props.onAction}>
              ${props.actionLabel}
            </button>
          `
        : nothing}
    </div>
  `;
}

function renderSummaryCard(item: SessionSummaryHistoryItem) {
  const statusLabel = t(`summaries.status.${item.status}`);
  const summaryText =
    item.summary ??
    (item.status === "pending"
      ? t("summaries.card.pendingSummary")
      : item.status === "failed"
        ? t("summaries.card.failedSummary")
        : t("summaries.card.missingSummary"));
  const lineage = item.nextSessionId
    ? `${item.sessionId} → ${item.nextSessionId}`
    : `${item.sessionId} → ${t("summaries.card.lineageEnd")}`;

  return html`
    <article class="summary-card summary-card--${item.status}">
      <header class="summary-card__header">
        <div class="summary-card__identity">
          <span class="summary-card__status summary-card__status--${item.status}">
            <span class="summary-card__status-dot" aria-hidden="true"></span>
            ${statusLabel}
          </span>
          <code class="summary-card__session-key" title=${item.sessionKey}>${item.sessionKey}</code>
        </div>
        <time class="summary-card__ended" datetime=${item.endedAt}>
          ${t("summaries.card.ended")}: ${formatTimestamp(item.endedAt)}
        </time>
      </header>

      <p class="summary-card__summary">${summaryText}</p>

      ${item.lastError
        ? html`
            <div class="summary-card__error" role="alert">
              <span>${t("summaries.card.lastError")}</span>
              <code>${item.lastError}</code>
            </div>
          `
        : nothing}

      <dl class="summary-card__meta">
        <div class="summary-card__meta-item summary-card__meta-item--lineage">
          <dt>${t("summaries.card.lineage")}</dt>
          <dd title=${lineage}>${lineage}</dd>
        </div>
        <div class="summary-card__meta-item">
          <dt>${t("summaries.card.agent")}</dt>
          <dd>${item.agentId}</dd>
        </div>
        <div class="summary-card__meta-item">
          <dt>${t("summaries.card.model")}</dt>
          <dd>${item.model ?? t("summaries.card.unknownModel")}</dd>
        </div>
        <div class="summary-card__meta-item">
          <dt>${t("summaries.card.messages")}</dt>
          <dd>${item.messageCount.toLocaleString()}</dd>
        </div>
        <div class="summary-card__meta-item">
          <dt>${t("summaries.card.attempts")}</dt>
          <dd>${item.attemptCount.toLocaleString()}</dd>
        </div>
        ${item.generatedAt
          ? html`
              <div class="summary-card__meta-item">
                <dt>${t("summaries.card.generated")}</dt>
                <dd>
                  <time datetime=${item.generatedAt}>${formatTimestamp(item.generatedAt)}</time>
                </dd>
              </div>
            `
          : nothing}
      </dl>
    </article>
  `;
}

export function renderSessionSummaries(props: SessionSummariesProps) {
  const hasItems = props.items.length > 0;
  const searchIsActive = props.query.trim().length > 0;
  return html`
    <section class="summaries" aria-busy=${props.loading || props.loadingMore ? "true" : "false"}>
      <form
        class="summaries-toolbar"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onSearch();
        }}
      >
        <label class="summaries-toolbar__field summaries-toolbar__field--agent">
          <span>${t("summaries.toolbar.agent")}</span>
          <select
            class="input"
            aria-label=${t("summaries.toolbar.agentAria")}
            .value=${props.selectedAgentId ?? ""}
            @change=${(event: Event) => {
              const value = (event.currentTarget as HTMLSelectElement).value.trim();
              props.onSelectAgent(value || null);
            }}
          >
            <option value="">${t("summaries.toolbar.defaultAgent")}</option>
            ${props.agentOptions.map(
              (option) => html`<option value=${option.id}>${option.label}</option>`,
            )}
          </select>
        </label>

        <label class="summaries-toolbar__field summaries-toolbar__field--search">
          <span>${t("summaries.toolbar.searchLabel")}</span>
          <input
            class="input"
            type="search"
            autocomplete="off"
            maxlength="512"
            placeholder=${t("summaries.toolbar.searchPlaceholder")}
            .value=${props.searchInput}
            @input=${(event: Event) =>
              props.onSearchInput((event.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <div class="summaries-toolbar__actions">
          <button class="btn btn--sm btn--primary" type="submit" ?disabled=${props.loading}>
            ${t("summaries.toolbar.search")}
          </button>
          ${props.searchInput || searchIsActive
            ? html`
                <button
                  class="btn btn--sm"
                  type="button"
                  ?disabled=${props.loading}
                  @click=${props.onClearSearch}
                >
                  ${t("summaries.toolbar.clear")}
                </button>
              `
            : nothing}
          <button
            class="btn btn--sm"
            type="button"
            ?disabled=${props.loading || props.loadingMore}
            @click=${props.onRefresh}
          >
            ${props.loading ? t("summaries.toolbar.refreshing") : t("summaries.toolbar.refresh")}
          </button>
        </div>
      </form>

      <div class="summaries-results-bar" aria-live="polite">
        <span>
          ${t("summaries.pagination.showing", { count: props.items.length.toLocaleString() })}
        </span>
        ${searchIsActive
          ? html`<span class="summaries-results-bar__query"
              >${t("summaries.pagination.searchingFor", { query: props.query })}</span
            >`
          : nothing}
      </div>

      ${props.unavailable
        ? renderSummaryState({
            className: "summaries-state--unavailable",
            title: t("summaries.states.unavailableTitle"),
            body: t("summaries.states.unavailableBody"),
          })
        : !hasItems && props.loading
          ? renderSummaryState({
              className: "summaries-state--loading",
              title: t("summaries.states.loadingTitle"),
              body: t("summaries.states.loadingBody"),
            })
          : !hasItems && props.error
            ? renderSummaryState({
                className: "summaries-state--error",
                title: t("summaries.states.errorTitle"),
                body: props.error,
                actionLabel: t("summaries.states.retry"),
                onAction: props.onRefresh,
              })
            : !hasItems
              ? renderSummaryState({
                  className: "summaries-state--empty",
                  title: searchIsActive
                    ? t("summaries.states.noResultsTitle")
                    : t("summaries.states.emptyTitle"),
                  body: searchIsActive
                    ? t("summaries.states.noResultsBody")
                    : t("summaries.states.emptyBody"),
                })
              : html`
                  ${props.error
                    ? html`<div class="summaries-inline-error" role="alert">${props.error}</div>`
                    : nothing}
                  <div class="summaries-grid">
                    ${props.items.map((item) => renderSummaryCard(item))}
                  </div>
                  ${props.nextCursor
                    ? html`
                        <div class="summaries-pagination">
                          <button
                            class="btn"
                            type="button"
                            ?disabled=${props.loading || props.loadingMore}
                            @click=${props.onLoadMore}
                          >
                            ${props.loadingMore
                              ? t("summaries.pagination.loadingMore")
                              : t("summaries.pagination.loadMore")}
                          </button>
                        </div>
                      `
                    : nothing}
                `}
    </section>
  `;
}

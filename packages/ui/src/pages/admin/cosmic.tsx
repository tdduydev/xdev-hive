// The three generic blocks of the Claude Design admin (template adminStats / adminCards / adminTable, R-72l): the
// operations tabs only choose the data, so they all read as one family. Sizes live in cosmic-admin-ops.css.
import type { CSSProperties, ReactNode } from "react";
import { type AdminTone } from "#ui/lib/admin-ops.ts";
import { Button } from "@xdev-hive/ui/components/ui/button";

/** A dot's colour is a tone, not a hex, so light and dark themes both get a readable one. */

const dotStyle = (tone: AdminTone = "neutral"): CSSProperties => ({ ["--dot" as string]: `var(--cx-tone-${tone})` });

export { toneForRatio, usedPercent, type AdminTone } from "#ui/lib/admin-ops.ts";

export interface AdminStat {
  key?: string;
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: AdminTone;
  /** Makes the tile a link (the overview's tiles open the page they count). */
  href?: string;
}

export function AdminStats({ stats }: { stats: AdminStat[] }) {
  return (
    <div className="cx-ops-stats">
      {stats.map((s) => {
        const body = (
          <>
            <span className="cx-ops-stat-label">
              <i className="cx-ops-dot cx-ops-dot-glow" style={dotStyle(s.tone)} />
              {s.label}
            </span>
            <strong>{s.value}</strong>
            {s.note ? <span className="cx-ops-stat-note">{s.note}</span> : null}
          </>
        );
        return s.href ? (
          <a key={s.key ?? s.label} href={s.href} className="cx-ops-stat" data-link>
            {body}
          </a>
        ) : (
          <div key={s.key ?? s.label} className="cx-ops-stat">
            {body}
          </div>
        );
      })}
    </div>
  );
}

export interface AdminCard {
  key: string;
  title: ReactNode;
  side?: ReactNode;
  body?: ReactNode;
  tone?: AdminTone;
  /** 0-100; the bar takes the card's tone. */
  bar?: number | null;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** More controls after the action (a second button, a toggle) that the design does not draw. */
  extra?: ReactNode;
  /** Dimmed: a closed incident, a paused rule. */
  dim?: boolean;
}

export function AdminCards({ cards }: { cards: AdminCard[] }) {
  return (
    <div className="cx-ops-cards">
      {cards.map((c) => (
        <div key={c.key} className="cx-ops-card" data-dim={c.dim || undefined}>
          <div className="cx-ops-card-head">
            <i className="cx-ops-dot cx-ops-dot-lg cx-ops-dot-glow" style={dotStyle(c.tone)} />
            <span className="cx-ops-card-title">{c.title}</span>
            {c.side ? <span className="cx-ops-card-side">{c.side}</span> : null}
          </div>
          {c.body ? <div className="cx-ops-card-body">{c.body}</div> : null}
          {typeof c.bar === "number" ? (
            <div className="cx-ops-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={c.bar}>
              <div style={{ width: `${c.bar}%`, ...dotStyle(c.tone) }} />
            </div>
          ) : null}
          {c.action || c.extra ? (
            <div className="cx-ops-card-actions">
              {c.action ? (
                <Button variant="glass" size="sm" disabled={c.action.disabled} onClick={c.action.onClick}>
                  {c.action.label}
                </Button>
              ) : null}
              {c.extra}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export interface AdminCell {
  text: ReactNode;
  sub?: ReactNode;
  tone?: AdminTone;
  /** Mono for ids and times, strong for the row's name. */
  mono?: boolean;
  strong?: boolean;
  title?: string;
}

export interface AdminRow {
  key: string;
  cells: AdminCell[];
  action?: { label: string; onClick: () => void; disabled?: boolean };
  /** Controls the design does not draw (a second button): sit with the row action. */
  extra?: ReactNode;
}

/**
 * `grid` is a grid-template-columns value (the last track, if the table has row actions, is the actions column);
 * `minWidth` is where the table stops shrinking and scrolls inside its own frame instead of widening the page.
 */
export function AdminTable({ cols, grid, minWidth = 720, rows, empty }: { cols: string[]; grid: string; minWidth?: number; rows: AdminRow[]; empty?: ReactNode }) {
  const hasActions = rows.some((r) => r.action || r.extra);
  const template = hasActions ? `${grid} auto` : grid;
  return (
    <div className="cx-ops-table" role="table">
      <div style={{ minWidth }}>
        <div className="cx-ops-table-head" role="row" style={{ gridTemplateColumns: template }}>
          {cols.map((c, i) => (
            <span key={`${i}-${c}`} role="columnheader">
              {c}
            </span>
          ))}
          {hasActions ? <span aria-hidden /> : null}
        </div>
        {rows.map((r) => (
          <div key={r.key} className="cx-ops-table-row" role="row" style={{ gridTemplateColumns: template }}>
            {r.cells.map((cell, i) => (
              <span key={i} role="cell" className="cx-ops-cell">
                {cell.tone ? <i className="cx-ops-dot" style={dotStyle(cell.tone)} /> : null}
                <span className="cx-ops-cell-text">
                  <span data-mono={cell.mono || undefined} data-strong={cell.strong || undefined} title={cell.title}>
                    {cell.text}
                  </span>
                  {cell.sub ? <small>{cell.sub}</small> : null}
                </span>
              </span>
            ))}
            {hasActions ? (
              <span role="cell" className="cx-ops-row-actions">
                {r.action ? (
                  <Button variant="ghost" size="sm" disabled={r.action.disabled} onClick={r.action.onClick}>
                    {r.action.label}
                  </Button>
                ) : null}
                {r.extra}
              </span>
            ) : null}
          </div>
        ))}
        {!rows.length && empty ? <div className="cx-ops-table-empty">{empty}</div> : null}
      </div>
    </div>
  );
}

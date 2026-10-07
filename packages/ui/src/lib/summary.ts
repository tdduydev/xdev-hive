// Pure rules of SummaryStrip and AttentionList, kept out of the .tsx so node --test can run them
// (the test runner here cannot load .tsx).
export const SUMMARY_MAX = 4;

/** The cap is a design rule, not a layout limit: a fifth number turns the strip back into a KPI grid. */
export const capSummary = <T>(items: T[]): T[] => items.slice(0, SUMMARY_MAX);

const RANK = { danger: 0, warning: 1, info: 2 } as const;

/** Worst first; items of the same level keep the order the caller gave. */
export const sortAttention = <T extends { level: keyof typeof RANK }>(items: T[]): T[] => [...items].sort((a, b) => RANK[a.level] - RANK[b.level]);

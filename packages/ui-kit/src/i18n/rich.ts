import { createElement, Fragment, type ReactNode } from "react";

/**
 * Puts React nodes into a translated sentence, so markup stays out of the catalogue:
 * rich(t("machines.duplicateHint"), { file: <code>config.json</code> }) for "… đổi {file} …".
 * Placeholders without a node are left as they are.
 */
export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name !== undefined && Object.hasOwn(nodes, name) ? createElement(Fragment, { key: i }, nodes[name]) : part;
  });
}

export function generateWhatsNew(repoRoot: string, tag: string): string;
export function readWhatsNewOverride(args: string[], readFile: (file: string, encoding: "utf8") => string): string | undefined;

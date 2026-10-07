/** Compare the actual renderer document, rather than a URL prefix that accepts other files or lookalike hosts. */
export function trustedRendererUrl(url: string, expected: string): boolean {
  try {
    const actual = new URL(url);
    const target = new URL(expected);
    return ["file:", "http:", "https:"].includes(target.protocol) &&
      actual.protocol === target.protocol && actual.host === target.host &&
      actual.pathname === target.pathname && !actual.username && !actual.password;
  } catch {
    return false;
  }
}

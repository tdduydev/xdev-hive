// Terminal Leader (specs/010 lát máy dùng chung) và phiên tương tác trên máy cá nhân (`hive chat`, specs/010 US1):
// phiên CLI tương tác trên máy worker, web xem qua /ws/terminal.
// Module khác chỉ import file này.
export { canOpenTerminal, TERMINAL_PERMISSION } from "./access.ts";
export { createTerminalHandlers } from "./gateway.ts";
export { maskSecrets } from "./mask.ts";
export { chainVerifiers, createTerminalTokenVerifier, sweepOnce } from "./mcp-tokens.ts";
export { type RemoteRouterDeps, remoteRouter, type TerminalRouterDeps, terminalRouter } from "./router.ts";
export { terminalChunks, terminalSessions } from "./schema.ts";
export type { TerminalDeps } from "./service.ts";
export { signTerminalToken, terminalTokenKey, verifyTerminalToken } from "./token.ts";
export { attachTerminalGateway, originAllowed, type TerminalGatewayOptions } from "./ws.ts";

// Cấu hình theo tầng (specs/033). Module khác chỉ import file này.
export { configVersion, type LayerInput, resolveConfig } from "./engine.ts";
export { findSetting, REGISTRY } from "./registry.ts";
export { layeredConfigRouter } from "./router.ts";
export { effectiveConfig } from "./service.ts";

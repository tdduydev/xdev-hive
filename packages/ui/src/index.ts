// WebApp (apps/web) and DesktopApp (apps/desktop) are the roots (roadmap 76h); what they share is exported here.
// LocalApp, the temporary app of a machine without a hub, is the "@xdev-hive/ui/local" subpath, so no root bundles it by accident.
export { Login } from "./Login.tsx";
export { HubSetup } from "./HubSetup.tsx";
export { I18nProvider, LOCALES, useI18n, useT, type Locale, type MessageKey } from "./i18n/index.tsx";
export { createHttpClient, hubSetupState, saveHubSetup, signIn, signInProviders, signOut, type HiveClient, type HttpClientOptions, type HubSetupState } from "./client.ts";

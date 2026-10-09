import assert from "node:assert/strict";
import { it } from "node:test";
import { register } from "tsx/esm/api";

register({ tsconfig: new URL("../tsconfig.json", import.meta.url).pathname });
const { I18nProvider: legacyProvider } = await import("#ui/i18n/index.tsx");
const { I18nProvider: kitProvider } = await import("@xdev-hive/ui-kit/i18n/index.tsx");
const { Button: legacyButton } = await import("#ui/components/ui/button.tsx");
const { Button: kitButton } = await import("@xdev-hive/ui-kit/components/ui/button.tsx");
const { DataTable: legacyTable } = await import("#ui/components/DataTable.tsx");
const { DataTable: kitTable } = await import("@xdev-hive/ui-kit/components/DataTable.tsx");

it("legacy paths share the ui-kit component and i18n instances", () => {
  assert.equal(legacyProvider, kitProvider);
  assert.equal(legacyButton, kitButton);
  assert.equal(legacyTable, kitTable);
});

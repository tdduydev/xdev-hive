import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

// deploy/lan-entrypoint.sh builds the HTTPS site addresses of Caddyfile.lan from HIVE_LAN_HOSTS.
const sh = (cmd: string) => execFileSync("sh", ["-c", `LAN_ENTRY_NO_EXEC=1; . deploy/lan-entrypoint.sh; ${cmd}`], { encoding: "utf8" }).trim();

describe("lan-entrypoint.sh", () => {
  it("one https site per host, comma or space separated", () => {
    assert.equal(sh(`lan_sites "192.0.2.52,my-server" 7743`), "https://192.0.2.52:7743, https://my-server:7743");
    assert.equal(sh(`lan_sites "192.0.2.52, my-server  hub.lan" 7743`), "https://192.0.2.52:7743, https://my-server:7743, https://hub.lan:7743");
  });
  it("the first host is the default name", () => {
    assert.equal(sh(`lan_first_host "192.0.2.52,my-server"`), "192.0.2.52");
  });
});

describe("lan_https_check (deploy/docker/lib.sh)", () => {
  it("does nothing when deploy/.env has no HIVE_LAN_HOSTS", () => {
    const out = execFileSync("bash", ["-c", `d=$(mktemp -d); mkdir $d/deploy; touch $d/deploy/.env; HIVE_REPO=$d HIVE_CONFIG=/nonexistent; . deploy/docker/lib.sh; HIVE_REPO=$d; lan_https_check; echo rc=$?`], { encoding: "utf8" });
    assert.match(out, /rc=0/);
  });
  it("fails when nothing answers on the LAN port", () => {
    const out = execFileSync("bash", ["-c", `d=$(mktemp -d); mkdir $d/deploy; echo 'HIVE_LAN_HOSTS=127.0.0.1' > $d/deploy/.env; echo 'HIVE_LAN_HTTPS_PORT=1' >> $d/deploy/.env; HIVE_CONFIG=/nonexistent; . deploy/docker/lib.sh; HIVE_REPO=$d; lan_https_check; echo rc=$?`], { encoding: "utf8" });
    assert.match(out, /rc=[1-9]/);
  });
});

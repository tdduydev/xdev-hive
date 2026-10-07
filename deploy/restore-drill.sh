#!/bin/bash
# Restore drill (goals OPS-2): the hub's newest backup and all stored files, put back into a new, empty SeaweedFS and
# opened by a hub of its own, then every database-referenced file read back and checked against its SHA-256. Nothing of the running
# hub is touched: its backups are only read, and the drill's containers (hive-drill-*), network and folder are removed
# at the end, never with prune (the server may be shared).
#   bash deploy/restore-drill.sh            on the server, after deploy/update.sh built the image
# HIVE_BACKUPS_VOLUME: the volume (or host folder) of /data/backups; HIVE_DRILL_IMAGE: the hub's image.
set -u
T0=$(date +%s)
D=$(mktemp -d /tmp/hive-drill-XXXX)
NET=hive-drill-net
IMG=${HIVE_DRILL_IMAGE:-xdev-hive-hub:latest}
BACKUPS=${HIVE_BACKUPS_VOLUME:-xdev-hive_hive-backups}
SEAWEED=${HIVE_SEAWEEDFS_IMAGE:-chrislusf/seaweedfs:4.48}
TOKEN=drill-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
cleanup() {
  docker rm -f -v hive-drill-hub hive-drill-sw >/dev/null 2>&1
  docker network rm $NET >/dev/null 2>&1
  docker run --rm -v $D:/d --entrypoint sh $IMG -c 'rm -rf /d/* /d/.[!.]*' >/dev/null 2>&1
  rmdir $D 2>/dev/null
}
trap cleanup EXIT
step() { echo "[$(( $(date +%s) - T0 ))s] $*"; }

step "1. copy the newest backup and its files from the backups volume"
docker run --rm -v "$BACKUPS":/b:ro -v $D:/out --entrypoint sh $IMG -c 'f=$(ls -t /b/hub-*.db | head -1); cp "$f" /out/hub.db && cp -r /b/files /out/files && echo "   $f, $(ls /out/files | wc -l) files" && chown -R 1000:1000 /out'
docker network create $NET >/dev/null

step "2. a new, empty SeaweedFS"
docker run -d --name hive-drill-sw --network $NET "$SEAWEED" server -dir=/data -filer -ip=127.0.0.1 -ip.bind=0.0.0.0 -master.volumeSizeLimitMB=64 -volume.max=0 >/dev/null
for i in $(seq 1 60); do docker exec hive-drill-sw curl -fs -o /dev/null http://127.0.0.1:8888/ && break; sleep 1; done

step "3. npm run files -- restore"
docker run --rm --network $NET -v $D:/drill -e HIVE_DB=/drill/hub.db -e HIVE_SEAWEEDFS_URL=http://hive-drill-sw:8888 -w /app/apps/web --entrypoint node $IMG src/cli.ts files restore /drill

step "4. a hub on the restored database and the new store"
docker run -d --name hive-drill-hub --network $NET -v $D:/drill -e HIVE_DB=/drill/hub.db -e HIVE_BACKUP_DIR= -e HIVE_SEAWEEDFS_URL=http://hive-drill-sw:8888 -e HIVE_BOOTSTRAP_TOKEN=$TOKEN -e HIVE_ALLOWED_HOSTS=127.0.0.1 $IMG >/dev/null
for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Running}}' hive-drill-hub)" = true ] || { echo "   the drill hub stopped:"; docker logs hive-drill-hub 2>&1 | tail -15; exit 1; }
  docker exec hive-drill-hub node -e 'fetch("http://127.0.0.1:7788/api/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' 2>/dev/null && break
  sleep 1
done

step "5. every database-referenced file reads back with the bytes its SHA-256 names"
docker exec -e TOKEN=$TOKEN hive-drill-hub node -e '
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/drill/hub.db", { readOnly: true });
const rpc = async (method, input) => (await (await fetch("http://127.0.0.1:7788/api/rpc", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.TOKEN }, body: JSON.stringify({ method, input }) })).json());
(async () => {
  const groups = [
    { kind: "document assets", rows: db.prepare("SELECT doc_key AS owner, name, sha256 FROM doc_assets WHERE sha256 IS NOT NULL").all(), method: "docs.assetGet", input: r => ({ key: r.owner, name: r.name }) },
    { kind: "run artifacts", rows: db.prepare("SELECT id, name, sha256 FROM artifacts WHERE sha256 IS NOT NULL").all(), method: "artifacts.get", input: r => ({ id: r.id }) },
  ];
  let total = 0, intact = 0, bad = [];
  for (const group of groups) {
    let ok = 0;
    for (const row of group.rows) {
      total++;
      const got = (await rpc(group.method, group.input(row))).result;
      const bytes = got?.data ? Buffer.from(got.data, "base64") : null;
      const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
      if (sha && sha === row.sha256) { ok++; intact++; }
      else bad.push(`${group.kind}/${row.name}`);
    }
    console.log(`   ${group.kind}: ${group.rows.length} referenced, ${ok} read back intact`);
  }
  db.close();
  const info = (await rpc("hub.info", {})).result;
  console.log(`   hub ${info?.version ?? "?"} · files ${JSON.stringify(info?.files ?? null).slice(0, 160)}`);
  console.log(`   total: ${total} referenced, ${intact} read back intact${bad.length ? ", BAD: " + bad.join(", ") : ""}`);
  process.exit(bad.length || !total ? 1 : 0);
})();'
R=$?
step "done (exit $R)"
exit $R

// The container's health check (Dockerfile HEALTHCHECK, deploy/podman Quadlet HealthCmd): exits 0 when this hub
// answers /api/health. A file rather than `node -e "…"`, because Quadlet drops the closing quote of such a command
// and the check then fails in /bin/sh before it ever asks the hub.
const port = process.env.HIVE_PORT ?? "7788";
fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) }).then(
  (r) => process.exit(r.ok ? 0 : 1),
  () => process.exit(1),
);

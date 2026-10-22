CREATE POLICY "ci_jenkins_connections_owner_select" ON "hive"."ci_jenkins_connections" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "ci_project_jobs_owner_select" ON "hive"."ci_project_jobs" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE POLICY "ci_runs_seen_owner_select" ON "hive"."ci_runs_seen" AS PERMISSIVE FOR SELECT TO "hive_owner" USING (true);--> statement-breakpoint
CREATE FUNCTION hive.delivery_active_orgs() RETURNS TABLE (org_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT c.org_id FROM hive.ci_jenkins_connections AS c
  WHERE c.watcher_user_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM hive.ci_project_jobs AS j WHERE j.connection_id = c.id)
  UNION
  SELECT r.org_id FROM hive.ci_runs_seen AS r WHERE r.source <> 'jenkins' AND r.status IN ('queued', 'running')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.delivery_active_orgs() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.delivery_active_orgs() TO hive_app;

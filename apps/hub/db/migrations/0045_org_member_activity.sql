-- Member activity needs only provider names and timestamps. A narrow function avoids granting hive_app
-- SELECT on auth.account or auth.session, which contain credentials and session tokens.
-- An empty search_path and explicit tenant predicate keep the definer from resolving untrusted objects
-- or exposing users outside the selected organization, including when ctx_org is NULL.
CREATE FUNCTION hive.org_member_activity()
RETURNS TABLE (user_id text, last_seen_at timestamptz, providers text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH members AS MATERIALIZED (
    SELECT m.user_id FROM hive.org_members AS m WHERE m.org_id = hive.ctx_org()
  ), accounts AS (
    SELECT a."userId" AS user_id, array_agg(DISTINCT a."providerId" ORDER BY a."providerId") AS providers
    FROM auth.account AS a INNER JOIN members AS m ON m.user_id = a."userId"
    GROUP BY a."userId"
  ), sessions AS (
    SELECT s."userId" AS user_id, max(greatest(s."createdAt", s."updatedAt")) AS last_seen_at
    FROM auth.session AS s INNER JOIN members AS m ON m.user_id = s."userId"
    GROUP BY s."userId"
  )
  SELECT m.user_id, s.last_seen_at, coalesce(a.providers, ARRAY[]::text[])
  FROM members AS m
  LEFT JOIN accounts AS a ON a.user_id = m.user_id
  LEFT JOIN sessions AS s ON s.user_id = m.user_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hive.org_member_activity() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION hive.org_member_activity() TO hive_app;

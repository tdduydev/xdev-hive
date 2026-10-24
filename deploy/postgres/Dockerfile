# Image Postgres của Hive: image gốc cộng pgBackRest cho backup liên tục (ADR 0035). Chưa đặt HIVE_BACKUP_REPO thì
# chạy y như image gốc, chỉ có backup.sh (pg_dump).
ARG POSTGRES_IMAGE=pgvector/pgvector:0.8.7-pg18-trixie
FROM ${POSTGRES_IMAGE}

# Image gốc đã có kho apt.postgresql.org nên pgBackRest khớp bản Postgres; ca-certificates cho kho S3 qua HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o postgres -g postgres -m 700 /etc/pgbackrest

# Không dùng COPY --chmod: builder cũ (không BuildKit) không hiểu.
COPY pgbackrest-conf.sh /usr/local/bin/hive-pgbackrest-conf
COPY hive-pgbackrest.sh /usr/local/bin/hive-pgbackrest
COPY entrypoint.sh /usr/local/bin/hive-postgres-entrypoint
RUN chmod 755 /usr/local/bin/hive-pgbackrest-conf /usr/local/bin/hive-pgbackrest /usr/local/bin/hive-postgres-entrypoint

ENTRYPOINT ["hive-postgres-entrypoint"]
CMD ["postgres"]

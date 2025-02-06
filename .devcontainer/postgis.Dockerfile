FROM postgres:16.6

# Install dependencies and PostGIS
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       postgis postgresql-16-postgis-3 postgresql-16-postgis-3-scripts \
    && rm -rf /var/lib/apt/lists/*

COPY initdb-postgis.sh /docker-entrypoint-initdb.d/
COPY update-postgis.sh /usr/local/bin
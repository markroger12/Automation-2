#!/usr/bin/env bash
# Development helper: create a new migration SQL from schema changes without
# touching data/app.db. Usage: bash scripts/dev-create-migration.sh <name>
set -euo pipefail
name="$1"
tmp="$(mktemp -d)"
DATABASE_URL="file:$tmp/shadow.db" npx prisma migrate deploy >/dev/null
stamp="$(date -u +%Y%m%d%H%M%S)"
dir="prisma/migrations/${stamp}_${name}"
mkdir -p "$dir"
npx prisma migrate diff --from-url "file:$tmp/shadow.db" --to-schema-datamodel prisma/schema.prisma --script > "$dir/migration.sql"
rm -rf "$tmp"
echo "Created $dir"
cat "$dir/migration.sql"

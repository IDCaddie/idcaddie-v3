#!/usr/bin/env bash
set -euo pipefail

# Run this outside the legacy repo.
npx create-next-app@latest idcaddie-v3 --typescript --tailwind --eslint --app --src-dir --import-alias '@/*'
cd idcaddie-v3
npm install @supabase/supabase-js @supabase/ssr zod
npm install -D playwright vitest
mkdir -p docs claude/prompts supabase/migrations supabase/tests

echo "Now copy the ID Caddie v3 start-pack contents into this repo."

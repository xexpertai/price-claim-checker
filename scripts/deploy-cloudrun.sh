#!/usr/bin/env bash
# Price-Claim Checker on Google Cloud Run, in RECORDED mode (replays real SerpApi responses; no API key
# in the image or the service, so the public demo can never spend SerpApi credits).
#
#   scripts/deploy-cloudrun.sh plan                     print what would be created, change nothing
#   CONFIRM_PUBLIC=1 scripts/deploy-cloudrun.sh deploy  build from source (Dockerfile) and deploy, public URL
#   scripts/deploy-cloudrun.sh verify                   health check + one recorded example end to end
#
# Needs: gcloud, logged in (`gcloud auth login`), project set (`gcloud config set project ID`).
# Billing protection: the project's alert-only budget (no auto-disable cap) covers this service too.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
REGION=${REGION:-us-central1}
SERVICE=${SERVICE:-price-claim-checker}
SA_NAME=pcc-run
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
[[ -n "$PROJECT" ]] || { echo "No project: run gcloud config set project <PROJECT_ID>" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }

plan() {
  cat <<EOF
Project        $PROJECT
Region         $REGION
Service        $SERVICE  (min 0, max 2 instances; 1 vCPU, 512 MiB; concurrency 40; public)
Image          built from ./Dockerfile by Cloud Build (node:22-slim; src, public, fixtures/recorded only)
Mode           PCC_MODE=recorded: the 4 recorded examples; no SERPAPI_API_KEY anywhere, 0 credits per visit
Service acct   $SA  (no roles: the app needs no Google APIs)
Secrets        none
Cost           scale-to-zero; expected within Cloud Run's free tier for judging traffic
EOF
}

deploy() {
  [[ "${CONFIRM_PUBLIC:-}" == 1 ]] || { echo "Refusing: set CONFIRM_PUBLIC=1 to deploy a public URL (needs Harsha's OK)." >&2; exit 1; }
  if grep -qs '^SERPAPI_API_KEY=' .env.local; then echo "(note: .env.local is excluded by .gcloudignore; the key is not uploaded)"; fi
  grep -q '^\.env' .gcloudignore || { echo ".gcloudignore must exclude .env*" >&2; exit 1; }
  say "APIs"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT"
  say "Service account (no roles)"
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$SA_NAME" --display-name "Price-Claim Checker (Cloud Run)" --project "$PROJECT"
  say "Build and deploy"
  gcloud run deploy "$SERVICE" --source . --project "$PROJECT" --region "$REGION" \
    --service-account "$SA" --allow-unauthenticated \
    --min-instances 0 --max-instances 2 --cpu 1 --memory 512Mi --concurrency 40 --timeout 30 \
    --set-env-vars "PCC_MODE=recorded,PCC_DATA_DIR=/tmp/pcc,HOST=0.0.0.0"
  verify
}

verify() {
  local url
  url=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')
  say "Verify $url"
  curl -fsS "$url/api/status" | grep -q '"mode":"recorded"' && echo "status: RECORDED mode OK"
  curl -fsS "$url/api/check" -H 'content-type: application/json' \
    -d '{"claim":{"product":"Philips GC1011/01 steam iron","price":999,"discountPct":20,"claimsLowest":true}}' |
    grep -q '"status":"holds"' && echo "example check: OK (steam iron -> holds, 0 credits)"
  curl -fsS -o /dev/null -w 'home page: HTTP %{http_code}\n' "$url/"
  echo "URL: $url"
}

case "${1:-plan}" in
  plan) plan ;;
  deploy) plan; deploy ;;
  verify) verify ;;
  *) echo "usage: $0 plan|deploy|verify" >&2; exit 1 ;;
esac

Woldecks Board Migration

1) Supabase
- Open SQL editor and run: supabase/schema.sql

2) Cloudflare Worker
- Deploy worker in worker/index.js
- Set environment variables:
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY
  - ADMIN_PASSWORD
  - TOKEN_PEPPER (random long secret)
  - ALLOWED_ORIGIN (Pages domain)
 - Optional: GitHub Actions auto-deploy
   - Add GitHub Secrets:
     - CLOUDFLARE_API_TOKEN
     - CLOUDFLARE_ACCOUNT_ID
     - SUPABASE_SERVICE_ROLE_KEY
     - ADMIN_PASSWORD
     - TOKEN_PEPPER
   - Workflow file: .github/workflows/deploy-worker.yml
   - Non-secret vars live in wrangler.toml:
     - SUPABASE_URL
     - ALLOWED_ORIGIN

3) Cloudflare Pages
- Deploy static files: index.html, styles.css, app.js
- Set window.API_BASE in index.html to Worker URL (if different domain)

4) Optional data import
- Transform woldecks-data.json into API inserts (script not included yet)

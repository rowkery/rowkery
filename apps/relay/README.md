# Report relay

A Cloudflare Worker that files reports from Rowkery's **Help > Report an Issue…** sheet as issues in the private repo `rowkery/reports` (`GITHUB_REPO` in `wrangler.toml`), labelled `user-report`. The GitHub token stays in the Worker as a secret, so the app never holds one, and users need no GitHub account. The Worker stores nothing.

`POST /report` takes JSON `{ description, app, database?, error?, query? }` (at most 20 KB) and answers `{ ok: true, number }` or `{ ok: false, error }`. Each IP may send 3 reports a minute (`[[ratelimits]]` in `wrangler.toml`).

Reports go to a private repo because they can carry a user's error text and query. Public issues on `rowkery/rowkery` stay open for anyone with a GitHub account (2026-10-16).

## Tests

```bash
cd apps/relay
npm test          # Node 22+, fake GitHub, nothing is filed
```

## Set up (once)

1. **Repo.** Create the private repo `rowkery/reports` (GitHub > New repository, owner `rowkery`, Private).
2. **Token.** GitHub > Settings > Developer settings > Fine-grained tokens > Generate new token. Resource owner: `rowkery`. Repository access: only `rowkery/reports`. Permissions: **Issues: Read and write** (nothing else).
3. **Labels** (optional; without them reports come in unlabelled): in `rowkery/reports`, Issues > Labels > New label `user-report`, and `feedback` (`bug` and `enhancement` come with a new repo).
4. **Cloudflare.** Make a free account, then:

   ```bash
   cd apps/relay
   npx wrangler@4 login
   npx wrangler@4 secret put GITHUB_TOKEN   # paste the token
   npm run deploy                           # prints https://rowkery-report-relay.<you>.workers.dev
   ```

5. **Point the app at it.** In `apps/rowkery-tauri/.env` (read at build time):

   ```bash
   VITE_ROWKERY_REPORT_URL=https://rowkery-report-relay.<you>.workers.dev/report
   ```

   Rebuild the app (`make dev`, `make dmg`). Without a URL the sheet still opens and offers Copy report.

   For the **Create DMG** workflow, add the same URL as a repository secret named `VITE_ROWKERY_REPORT_URL` (Settings > Secrets and variables > Actions > New repository secret).

Check it with `curl -X POST <url> -d '{"description":"relay test","app":"curl"}'`, which should file an issue in `rowkery/reports`.

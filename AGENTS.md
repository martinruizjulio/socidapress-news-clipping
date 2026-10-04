<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Login (request/verify code) and Claude OCR are TanStack server routes under src/routes/api/public/* with CORS, called by absolute URL from src/lib/api-urls.ts — the frontend is also deployed statically elsewhere, so it cannot rely on same-origin server functions.

# Shared AI coordination — SocidaPress
Canonical repo: `martinruizjulio/socidapress-news-clipping`. Project: SocidaPress. Keep it isolated from every other Julio project.

Before every development request, inspect the current default branch, read this file and `docs/CURRENT_STATE.md`, and review recent commits. Current code/data is the technical source of truth. If GitHub is unavailable, say so; never pretend to sync.

Priority: Julio's current instruction > current code/data > AGENTS/CURRENT_STATE > current docs > chat history. Preserve the deployment/API separation documented above unless Julio explicitly changes it.

For requested work you may audit/edit code, add necessary files, fix related defects and run available checks/builds. Ask before destructive production-data/schema changes, substantial auth/role changes, domain/DNS changes, removing features, replacing the main stack, or deleting production/repository resources. Never commit secrets or copy credentials between projects.

After meaningful changes, run reasonable checks, summarize changes/pending work, update `docs/CURRENT_STATE.md`, and use Git history as the detailed record. Never claim production verification from build-only checks.

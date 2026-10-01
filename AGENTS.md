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

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/ocr-claude")({
  server: {
    handlers: {
      OPTIONS: async () => (await import("@/lib/api-publica.server")).preflight(),
      POST: async ({ request }) => {
        const api = await import("@/lib/api-publica.server");
        try {
          return await api.ocrClaude(request, await request.json().catch(() => ({})));
        } catch (e) {
          console.error(e);
          return api.respuesta({ ok: false, error: "interno" }, 500);
        }
      },
    },
  },
});

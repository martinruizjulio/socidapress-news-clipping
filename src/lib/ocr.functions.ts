import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PROMPT =
  "Transcribe fielmente todo el texto visible en esta imagen, en español. Respeta los saltos de párrafo. " +
  "Une las palabras partidas por guion a final de línea. No añadas comentarios, títulos ni explicaciones: devuelve solo el texto.";

// OCR con Claude: recibe una imagen en base64 (o dataURL) y devuelve el texto
export const ocrClaude = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ imagen: z.string().min(100).max(15_000_000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: autorizado } = await context.supabase.rpc("is_email_authorized", {
      _email: String(context.claims.email ?? ""),
    });
    if (!autorizado) throw new Response("Forbidden", { status: 403 });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Falta ANTHROPIC_API_KEY");

    let mediaType = "image/png";
    let b64 = data.imagen;
    const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(data.imagen);
    if (m) { mediaType = m[1]; b64 = m[2]; }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 8000,
        stream: true,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
    });
    if (!res.ok || !res.body) {
      const cuerpo = await res.text();
      return { ok: false as const, status: res.status, error: cuerpo.slice(0, 500) };
    }

    // Lee el stream SSE y acumula el texto
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    let texto = "";
    let stop: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const partes = buffer.split("\n");
      buffer = partes.pop() ?? "";
      for (const l of partes) {
        if (!l.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(l.slice(5).trim());
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") texto += ev.delta.text;
          if (ev.type === "message_delta" && ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          if (ev.type === "error") return { ok: false as const, status: 500, error: ev.error?.message ?? "error" };
        } catch { /* fragmento incompleto */ }
      }
    }
    if (stop === "refusal") return { ok: false as const, status: 200, error: "El modelo ha rechazado la petición." };
    return { ok: true as const, texto: texto.trim() };
  });

// Lógica de servidor para los endpoints públicos (login con código y OCR con Claude)
import { z } from "zod";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
};

export const respuesta = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const preflight = () => new Response(null, { status: 204, headers: CORS });

async function sha256(texto: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const esquemaEmail = z.object({ email: z.string().trim().toLowerCase().email().max(255) });

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

// Genera el código de 6 dígitos y lo envía por Resend
export async function pedirCodigo(body: unknown) {
  const p = esquemaEmail.safeParse(body);
  if (!p.success) return respuesta({ ok: false, error: "email" }, 400);
  const email = p.data.email;
  const sb = await admin();
  const { data: autorizado } = await sb.rpc("is_email_authorized", { _email: email });
  if (!autorizado) return respuesta({ ok: false, error: "no-autorizado" });

  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  const codigo = String(n[0] % 1_000_000).padStart(6, "0");
  const tok = new Uint8Array(32);
  crypto.getRandomValues(tok);
  const tokenHash = Array.from(tok).map((b) => b.toString(16).padStart(2, "0")).join("");

  const { error: errIns } = await sb.from("login_codes").insert({
    email,
    code_hash: await sha256(`${email}:${codigo}`),
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (errIns) return respuesta({ ok: false, error: "interno" }, 500);

  const key = process.env.RESEND_API_KEY;
  if (!key) return respuesta({ ok: false, error: "config" }, 500);
  const texto = `Tu código de acceso a SocidaPress es:\n\n    ${codigo}\n\nCaduca en 10 minutos.\n\nSi no lo has pedido, ignora este correo.`;
  const html = `<div style="font-family:Arial,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
<p style="font-size:16px">Tu código de acceso a SocidaPress es:</p>
<p style="font-size:40px;font-weight:bold;letter-spacing:10px;margin:24px 0">${codigo}</p>
<p style="font-size:14px;color:#555">Caduca en 10 minutos.</p>
<p style="font-size:13px;color:#888">Si no lo has pedido, ignora este correo.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "SocidaPress <noreply@giepafs.net>",
      to: [email],
      subject: `Tu código de acceso: ${codigo}`,
      text: texto,
      html,
    }),
  });
  if (!res.ok) {
    console.error(`Resend [${res.status}]: ${await res.text()}`);
    return respuesta({ ok: false, error: "envio" }, 502);
  }
  return respuesta({ ok: true });
}

// Verifica el código y devuelve el token para abrir sesión
export async function verificarCodigo(body: unknown) {
  const p = esquemaEmail.extend({ code: z.string().regex(/^\d{6}$/) }).safeParse(body);
  if (!p.success) return respuesta({ ok: false, error: "codigo" }, 400);
  const { email, code } = p.data;
  const sb = await admin();
  const { data: fila } = await sb
    .from("login_codes")
    .select("id")
    .eq("email", email)
    .eq("code_hash", await sha256(`${email}:${code}`))
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!fila) return respuesta({ ok: false, error: "codigo" });

  const { data: autorizado } = await sb.rpc("is_email_authorized", { _email: email });
  if (!autorizado) return respuesta({ ok: false, error: "no-autorizado" });

  await sb.from("login_codes").update({ used_at: new Date().toISOString() }).eq("id", fila.id);
  await sb.auth.admin.createUser({ email, email_confirm: true });
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) return respuesta({ ok: false, error: "interno" }, 500);
  return respuesta({ ok: true, tokenHash: link.properties.hashed_token });
}

const PROMPT =
  "Transcribe fielmente todo el texto visible en esta imagen, en español. Respeta los saltos de párrafo. " +
  "Une las palabras partidas por guion a final de línea. No añadas comentarios, títulos ni explicaciones: devuelve solo el texto.";

// OCR con Claude: exige usuario con sesión y correo autorizado
export async function ocrClaude(request: Request, body: unknown) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token.split(".").length !== 3) return respuesta({ ok: false, error: "no-autenticado" }, 401);
  const sb = await admin();
  const { data: u, error: errU } = await sb.auth.getUser(token);
  if (errU || !u.user?.email) return respuesta({ ok: false, error: "no-autenticado" }, 401);
  const { data: autorizado } = await sb.rpc("is_email_authorized", { _email: u.user.email });
  if (!autorizado) return respuesta({ ok: false, error: "no-autorizado" }, 403);

  const p = z.object({ imagen: z.string().min(100).max(15_000_000) }).safeParse(body);
  if (!p.success) return respuesta({ ok: false, error: "imagen" }, 400);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return respuesta({ ok: false, error: "config" }, 500);

  let mediaType = "image/png";
  let b64 = p.data.imagen;
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/s.exec(b64);
  if (m) { mediaType = m[1]; b64 = m[2]; }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) return respuesta({ ok: false, status: res.status, error: (await res.text()).slice(0, 500) }, 502);
  const datos = (await res.json()) as { stop_reason?: string; content?: { type: string; text?: string }[] };
  if (datos.stop_reason === "refusal") return respuesta({ ok: false, error: "El modelo ha rechazado la petición." });
  const texto = (datos.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
  return respuesta({ ok: true, texto });
}

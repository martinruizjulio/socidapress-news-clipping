import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Hash SHA-256 en hexadecimal
async function sha256(texto: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const esquemaEmail = z.object({ email: z.string().trim().toLowerCase().email().max(255) });

// Genera un código de 6 dígitos y lo envía por correo con Resend
export const requestLoginCode = createServerFn({ method: "POST" })
  .inputValidator((d) => esquemaEmail.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: autorizado } = await supabaseAdmin.rpc("is_email_authorized", { _email: data.email });
    if (!autorizado) return { ok: false as const, error: "no-autorizado" };

    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    const codigo = String(n[0] % 1_000_000).padStart(6, "0");
    const tok = new Uint8Array(32);
    crypto.getRandomValues(tok);
    const tokenHash = Array.from(tok).map((b) => b.toString(16).padStart(2, "0")).join("");

    const { error: errIns } = await supabaseAdmin.from("login_codes").insert({
      email: data.email,
      code_hash: await sha256(`${data.email}:${codigo}`),
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (errIns) return { ok: false as const, error: "interno" };

    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false as const, error: "config" };
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
        to: [data.email],
        subject: `Tu código de acceso: ${codigo}`,
        text: texto,
        html,
      }),
    });
    if (!res.ok) {
      console.error(`Resend [${res.status}]: ${await res.text()}`);
      return { ok: false as const, error: "envio" };
    }
    return { ok: true as const };
  });

// Verifica el código y devuelve un token para abrir sesión
export const verifyLoginCode = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    esquemaEmail.extend({ code: z.string().regex(/^\d{6}$/) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const hash = await sha256(`${data.email}:${data.code}`);
    const { data: fila } = await supabaseAdmin
      .from("login_codes")
      .select("id")
      .eq("email", data.email)
      .eq("code_hash", hash)
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!fila) return { ok: false as const, error: "codigo" };

    const { data: autorizado } = await supabaseAdmin.rpc("is_email_authorized", { _email: data.email });
    if (!autorizado) return { ok: false as const, error: "no-autorizado" };

    await supabaseAdmin.from("login_codes").update({ used_at: new Date().toISOString() }).eq("id", fila.id);

    // Crea el usuario si no existe (ignora el error de duplicado)
    await supabaseAdmin.auth.admin.createUser({ email: data.email, email_confirm: true });

    const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: data.email,
    });
    if (error || !link?.properties?.hashed_token) return { ok: false as const, error: "interno" };
    return { ok: true as const, tokenHash: link.properties.hashed_token };
  });

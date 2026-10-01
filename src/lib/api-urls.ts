import { supabase } from "@/integrations/supabase/client";

// Dirección fija donde se alojan las funciones (Lovable). Absoluta para que
// funcione igual cuando la app se sirve desde Apache. Se puede sobrescribir
// en el build con VITE_SOCIDAPRESS_API_BASE.
export const API_BASE: string =
  import.meta.env.VITE_SOCIDAPRESS_API_BASE ||
  "https://project--2991dd0e-6d43-4c76-bff9-038fb036e9cf.lovable.app";

export const URL_PEDIR_CODIGO = `${API_BASE}/api/public/request-login-code`;
export const URL_VERIFICAR_CODIGO = `${API_BASE}/api/public/verify-login-code`;
export const URL_OCR_CLAUDE = `${API_BASE}/api/public/ocr-claude`;

type Resp = { ok: boolean; error?: string; tokenHash?: string; texto?: string };

async function post(url: string, body: unknown, token?: string): Promise<Resp> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => ({ ok: false, error: "interno" }))) as Resp;
}

export const pedirCodigo = (email: string) => post(URL_PEDIR_CODIGO, { email });
export const verificarCodigo = (email: string, code: string) => post(URL_VERIFICAR_CODIGO, { email, code });

// OCR con Claude usando la sesión actual
export async function ocrConClaude(imagen: string) {
  const { data } = await supabase.auth.getSession();
  return post(URL_OCR_CLAUDE, { imagen }, data.session?.access_token);
}

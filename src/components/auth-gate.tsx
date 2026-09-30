import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { requestLoginCode, verifyLoginCode } from "@/lib/login.functions";

type Estado = "cargando" | "sin-sesion" | "no-autorizado" | "ok";

// Hook de sesión + autorización contra la lista de correos autorizados
export function useAcceso() {
  const [session, setSession] = useState<Session | null>(null);
  const [estado, setEstado] = useState<Estado>("cargando");
  const [esAdmin, setEsAdmin] = useState(false);

  useEffect(() => {
    const comprobar = async (s: Session | null) => {
      setSession(s);
      if (!s?.user.email) {
        setEstado("sin-sesion");
        setEsAdmin(false);
        return;
      }
      const { data: autorizado } = await supabase.rpc("is_email_authorized", { _email: s.user.email });
      if (!autorizado) {
        setEstado("no-autorizado");
        await supabase.auth.signOut();
        return;
      }
      const { data: admin } = await supabase.rpc("is_admin");
      setEsAdmin(!!admin);
      setEstado("ok");
    };
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setTimeout(() => void comprobar(s), 0);
    });
    supabase.auth.getSession().then(({ data }) => comprobar(data.session));
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, estado, esAdmin, setEstado };
}

const input =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";
const boton =
  "w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";

function Login({ noAutorizado }: { noAutorizado: boolean }) {
  const [email, setEmail] = useState("");
  const [codigo, setCodigo] = useState("");
  const [paso, setPaso] = useState<"email" | "codigo">("email");
  const [error, setError] = useState<string | null>(
    noAutorizado ? "Tu correo no tiene acceso todavía. Contacta con el administrador." : null,
  );
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOcupado(true);
    try {
      const r = await requestLoginCode({ data: { email: email.trim().toLowerCase() } });
      if (r.ok) setPaso("codigo");
      else if (r.error === "no-autorizado") setError("Tu correo no tiene acceso todavía. Contacta con el administrador.");
      else setError("No se pudo enviar el código. Inténtalo de nuevo en unos minutos.");
    } catch {
      setError("No se pudo enviar el código. Inténtalo de nuevo en unos minutos.");
    }
    setOcupado(false);
  };

  const verificar = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOcupado(true);
    try {
      const r = await verifyLoginCode({ data: { email: email.trim().toLowerCase(), code: codigo.trim() } });
      if (!r.ok) {
        setError(r.error === "no-autorizado" ? "Tu correo no tiene acceso todavía." : "Código incorrecto o caducado.");
      } else {
        const { error } = await supabase.auth.verifyOtp({ token_hash: r.tokenHash, type: "magiclink" });
        if (error) setError("No se pudo abrir la sesión. Pide un código nuevo.");
      }
    } catch {
      setError("Código incorrecto o caducado.");
    }
    setOcupado(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-2xl font-bold text-foreground">SocidaPress</h1>
        <p className="mt-1 text-sm text-muted-foreground">Acceso solo para usuarios autorizados.</p>
        {paso === "email" ? (
          <form onSubmit={enviar} className="mt-6 space-y-3">
            <input type="email" required placeholder="tu@correo.es" value={email}
              onChange={(e) => setEmail(e.target.value)} className={input} />
            <button disabled={ocupado} className={boton}>{ocupado ? "Enviando…" : "Enviar código"}</button>
          </form>
        ) : (
          <form onSubmit={verificar} className="mt-6 space-y-3">
            <p className="text-sm text-muted-foreground">Hemos enviado un código de 6 dígitos a {email}.</p>
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required placeholder="123456"
              value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ""))}
              className={`${input} tracking-[0.5em] text-center text-lg`} />
            <button disabled={ocupado || codigo.length !== 6} className={boton}>{ocupado ? "Comprobando…" : "Entrar"}</button>
            <button type="button" onClick={() => { setPaso("email"); setCodigo(""); }}
              className="w-full text-sm text-muted-foreground hover:text-foreground">Cambiar correo</button>
          </form>
        )}
        {error && <p className="mt-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

// Bloquea todo el contenido hasta tener sesión autorizada
export function AuthGate({ children, soloAdmin = false }: { children: ReactNode; soloAdmin?: boolean }) {
  const { session, estado, esAdmin } = useAcceso();

  if (estado === "cargando")
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Cargando…</div>;
  if (estado !== "ok") return <Login noAutorizado={estado === "no-autorizado"} />;
  if (soloAdmin && !esAdmin)
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        No tienes permiso para ver esta página.
        <Link to="/" className="text-primary underline">Volver</Link>
      </div>
    );

  return (
    <>
      <div className="flex items-center justify-end gap-4 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground">
        <span>{session?.user.email}</span>
        {esAdmin && (soloAdmin
          ? <Link to="/" className="text-primary hover:underline">Aplicación</Link>
          : <Link to="/admin" className="text-primary hover:underline">Administración</Link>)}
        <button onClick={() => supabase.auth.signOut()} className="hover:text-foreground">Salir</button>
      </div>
      {children}
    </>
  );
}

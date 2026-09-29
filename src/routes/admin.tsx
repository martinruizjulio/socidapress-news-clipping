import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AuthGate } from "@/components/auth-gate";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Administración · SocidaPress" },
      { name: "description", content: "Gestión de correos autorizados en SocidaPress." },
      { property: "og:title", content: "Administración · SocidaPress" },
      { property: "og:description", content: "Gestión de correos autorizados en SocidaPress." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <ClientOnly fallback={null}>
      <AuthGate soloAdmin>
        <Admin />
      </AuthGate>
    </ClientOnly>
  ),
});

type Fila = { email: string; is_admin: boolean; created_at: string };

function Admin() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [nuevo, setNuevo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cargar = async () => {
    const { data } = await supabase.from("authorized_emails").select("*").order("email");
    setFilas(data ?? []);
  };
  useEffect(() => { void cargar(); }, []);

  const añadir = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const email = nuevo.trim().toLowerCase();
    const { error } = await supabase.from("authorized_emails").insert({ email });
    if (error) setError(error.code === "23505" ? "Ese correo ya está autorizado." : "No se pudo añadir.");
    else { setNuevo(""); void cargar(); }
  };

  const quitar = async (email: string) => {
    if (!confirm(`¿Quitar acceso a ${email}?`)) return;
    await supabase.from("authorized_emails").delete().eq("email", email);
    void cargar();
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-2xl font-bold text-foreground">Correos autorizados</h1>
      <form onSubmit={añadir} className="mt-6 flex gap-2">
        <input type="email" required value={nuevo} onChange={(e) => setNuevo(e.target.value)} placeholder="correo@ejemplo.es"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Añadir</button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <ul className="mt-6 divide-y divide-border rounded-md border border-border">
        {filas.map((f) => (
          <li key={f.email} className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="text-foreground">{f.email}{f.is_admin && <span className="ml-2 text-xs text-muted-foreground">(administrador)</span>}</span>
            {!f.is_admin && (
              <button onClick={() => quitar(f.email)} className="text-destructive hover:underline">Quitar</button>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

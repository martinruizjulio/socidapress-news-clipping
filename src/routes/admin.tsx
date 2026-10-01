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

type Fila = {
  email: string;
  is_admin: boolean;
  created_at: string;
  nombre: string | null;
  apellidos: string | null;
};

function Admin() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [nuevo, setNuevo] = useState("");
  const [nuevoNombre, setNuevoNombre] = useState("");
  const [nuevoApellidos, setNuevoApellidos] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Correo cuyo nombre/apellidos se está editando en la lista (null = ninguno).
  const [editandoEmail, setEditandoEmail] = useState<string | null>(null);
  const [editNombre, setEditNombre] = useState("");
  const [editApellidos, setEditApellidos] = useState("");

  const cargar = async () => {
    const { data } = await supabase.from("authorized_emails").select("*").order("email");
    setFilas(data ?? []);
  };
  useEffect(() => { void cargar(); }, []);

  const añadir = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const email = nuevo.trim().toLowerCase();
    const { error } = await supabase.from("authorized_emails").insert({
      email,
      nombre: nuevoNombre.trim() || null,
      apellidos: nuevoApellidos.trim() || null,
    });
    if (error) setError(error.code === "23505" ? "Ese correo ya está autorizado." : "No se pudo añadir.");
    else {
      setNuevo("");
      setNuevoNombre("");
      setNuevoApellidos("");
      void cargar();
    }
  };

  const quitar = async (email: string) => {
    if (!confirm(`¿Quitar acceso a ${email}?`)) return;
    await supabase.from("authorized_emails").delete().eq("email", email);
    void cargar();
  };

  const empezarEdicion = (f: Fila) => {
    setEditandoEmail(f.email);
    setEditNombre(f.nombre ?? "");
    setEditApellidos(f.apellidos ?? "");
  };

  const guardarEdicion = async (email: string) => {
    await supabase
      .from("authorized_emails")
      .update({ nombre: editNombre.trim() || null, apellidos: editApellidos.trim() || null })
      .eq("email", email);
    setEditandoEmail(null);
    void cargar();
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-2xl font-bold text-foreground">Correos autorizados</h1>
      <form onSubmit={añadir} className="mt-6 space-y-2">
        <input type="email" required value={nuevo} onChange={(e) => setNuevo(e.target.value)} placeholder="correo@ejemplo.es"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <div className="flex gap-2">
          <input value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} placeholder="Nombre"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <input value={nuevoApellidos} onChange={(e) => setNuevoApellidos(e.target.value)} placeholder="Apellidos"
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Añadir</button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <ul className="mt-6 divide-y divide-border rounded-md border border-border">
        {filas.map((f) => (
          <li key={f.email} className="flex flex-col gap-2 px-4 py-3 text-sm">
            {editandoEmail === f.email ? (
              <div className="flex flex-wrap items-center gap-2">
                <input value={editNombre} onChange={(e) => setEditNombre(e.target.value)} placeholder="Nombre"
                  className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm" />
                <input value={editApellidos} onChange={(e) => setEditApellidos(e.target.value)} placeholder="Apellidos"
                  className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm" />
                <button onClick={() => guardarEdicion(f.email)} className="text-primary hover:underline">Guardar</button>
                <button onClick={() => setEditandoEmail(null)} className="text-muted-foreground hover:underline">Cancelar</button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <span className="text-foreground">
                  {[f.nombre, f.apellidos].filter(Boolean).join(" ") || f.email}
                  <span className="ml-2 text-xs text-muted-foreground">{f.email}</span>
                  {f.is_admin && <span className="ml-2 text-xs text-muted-foreground">(administrador)</span>}
                </span>
                <div className="flex gap-3">
                  <button onClick={() => empezarEdicion(f)} className="text-muted-foreground hover:underline">Editar</button>
                  {!f.is_admin && (
                    <button onClick={() => quitar(f.email)} className="text-destructive hover:underline">Quitar</button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

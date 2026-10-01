// Biblioteca de noticias compartida entre todas las personas autorizadas
// (tabla "noticias" en Supabase), con migración automática de lo que
// hubiera guardado antes en localStorage (versión anterior, un solo
// navegador).
import { supabase } from "@/integrations/supabase/client";
import type { SavedNoticia } from "@/components/socida-press";

const STORAGE_KEY = "socidapress:noticias";
const MIGRADO_KEY = "socidapress:migrado-a-nube";

function cargarNoticiasLocal(): SavedNoticia[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type FilaNoticia = {
  id: string;
  data: SavedNoticia;
  fecha_noticia: string | null;
  editado: boolean;
  terminado: boolean;
  creado_por: string;
  creado_en: string;
  editado_por: string | null;
  editado_en: string | null;
  terminado_por: string | null;
  terminado_en: string | null;
};

function filaANoticia(f: FilaNoticia): SavedNoticia {
  return {
    ...f.data,
    id: f.id,
    terminado: f.terminado,
    creadoPor: f.creado_por,
    creadoEn: f.creado_en,
    editadoPor: f.editado_por,
    editadoEn: f.editado_en,
    terminadoPor: f.terminado_por,
    terminadoEn: f.terminado_en,
  };
}

// Mismo criterio que "estaEditada" en socida-press.tsx (updatedAt se
// adelanta a createdAt al guardar cambios), duplicado aquí como columna
// de la fila para poder filtrar por SQL sin traer el jsonb completo.
function pareceEditada(n: SavedNoticia): boolean {
  return n.updatedAt - n.createdAt > 1000;
}

function filaParaGuardar(
  n: SavedNoticia,
  email: string,
  extra: { creando?: boolean; marcandoTerminado?: boolean | null } = {},
): Omit<FilaNoticia, "creado_en"> & { creado_en?: string } {
  const ahora = new Date().toISOString();
  return {
    id: n.id,
    data: n,
    fecha_noticia: /^\d{4}-\d{2}-\d{2}$/.test(n.fecha) ? n.fecha : null,
    editado: pareceEditada(n),
    terminado: !!n.terminado,
    creado_por: n.creadoPor || email,
    ...(extra.creando ? { creado_en: ahora } : {}),
    editado_por: email,
    editado_en: ahora,
    terminado_por:
      extra.marcandoTerminado === undefined
        ? (n.terminadoPor ?? null)
        : extra.marcandoTerminado
          ? email
          : null,
    terminado_en:
      extra.marcandoTerminado === undefined
        ? (n.terminadoEn ?? null)
        : extra.marcandoTerminado
          ? ahora
          : null,
  };
}

export async function cargarNoticiasRemoto(): Promise<SavedNoticia[]> {
  const { data, error } = await supabase
    .from("noticias")
    .select("*")
    .order("creado_en", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as FilaNoticia[]).map(filaANoticia);
}

// Sube a la nube, una sola vez por navegador, las noticias que hubiera
// guardadas localmente de la versión anterior (sin esto se "perderían"
// de vista al pasar a la biblioteca compartida). No borra nada local ni
// repite la subida si ya se hizo.
export async function migrarLocalANubeSiHaceFalta(email: string): Promise<number> {
  if (localStorage.getItem(MIGRADO_KEY)) return 0;
  const locales = cargarNoticiasLocal();
  if (locales.length === 0) {
    localStorage.setItem(MIGRADO_KEY, "1");
    return 0;
  }
  const { data: existentes } = await supabase.from("noticias").select("id");
  const idsExistentes = new Set((existentes ?? []).map((r) => r.id as string));
  const nuevas = locales.filter((n) => !idsExistentes.has(n.id));
  if (nuevas.length > 0) {
    // Las imágenes de esta migración puntual (datos de antes de la
    // biblioteca compartida) se descartan a propósito: son prescindibles
    // y evita filas enormes en la base de datos. El texto se conserva
    // íntegro.
    const sinImagenes = nuevas.map((n) => ({
      ...n,
      imagenes: [],
      bloques: n.bloques.map((b) => ({
        ...b,
        imagenPagina: null,
        imagenSeleccion: null,
        imagenFoto: null,
      })),
    }));
    const filas = sinImagenes.map((n) =>
      filaParaGuardar(n, email, { creando: true, marcandoTerminado: n.terminado ? true : undefined }),
    );
    const { error } = await supabase.from("noticias").insert(filas as never);
    if (error) throw error;
  }
  localStorage.setItem(MIGRADO_KEY, "1");
  return nuevas.length;
}

export async function crearNoticiasRemoto(
  noticias: SavedNoticia[],
  email: string,
): Promise<SavedNoticia[]> {
  const filas = noticias.map((n) =>
    filaParaGuardar(n, email, { creando: true, marcandoTerminado: n.terminado ? true : undefined }),
  );
  const { data, error } = await supabase.from("noticias").insert(filas as never).select("*");
  if (error) throw error;
  return ((data ?? []) as unknown as FilaNoticia[]).map(filaANoticia);
}

export async function actualizarNoticiaRemoto(
  n: SavedNoticia,
  email: string,
): Promise<SavedNoticia> {
  const fila = filaParaGuardar(n, email);
  const { data, error } = await supabase
    .from("noticias")
    .update(fila as never)
    .eq("id", n.id)
    .select("*")
    .single();
  if (error) throw error;
  return filaANoticia(data as unknown as FilaNoticia);
}

export async function alternarTerminadoRemoto(
  n: SavedNoticia,
  email: string,
): Promise<SavedNoticia> {
  const fila = filaParaGuardar(n, email, { marcandoTerminado: !n.terminado });
  const { data, error } = await supabase
    .from("noticias")
    .update({ terminado: !n.terminado, terminado_por: fila.terminado_por, terminado_en: fila.terminado_en } as never)
    .eq("id", n.id)
    .select("*")
    .single();
  if (error) throw error;
  return filaANoticia(data as unknown as FilaNoticia);
}

export async function eliminarNoticiaRemoto(id: string): Promise<void> {
  const { error } = await supabase.from("noticias").delete().eq("id", id);
  if (error) throw error;
}

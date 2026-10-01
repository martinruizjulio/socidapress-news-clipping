-- Lista de periódicos disponibles para el selector "Periódico" de cada
-- bloque. Antes era texto libre; ahora es un desplegable con esta lista,
-- editable desde /admin (solo administradores) por si se amplía el número.

CREATE TABLE IF NOT EXISTS public.periodicos (
  nombre text PRIMARY KEY,
  creado_en timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON public.periodicos TO authenticated;
GRANT ALL ON public.periodicos TO service_role;
ALTER TABLE public.periodicos ENABLE ROW LEVEL SECURITY;

-- Cualquier persona autorizada puede ver la lista (la necesita el
-- selector), pero solo un administrador puede añadir o quitar periódicos.
DROP POLICY IF EXISTS "autorizados_ven_periodicos" ON public.periodicos;
CREATE POLICY "autorizados_ven_periodicos" ON public.periodicos FOR SELECT TO authenticated
  USING (public.is_email_authorized(coalesce(auth.jwt()->>'email','')));

DROP POLICY IF EXISTS "admin_anade_periodicos" ON public.periodicos;
CREATE POLICY "admin_anade_periodicos" ON public.periodicos FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "admin_quita_periodicos" ON public.periodicos;
CREATE POLICY "admin_quita_periodicos" ON public.periodicos FOR DELETE TO authenticated
  USING (public.is_admin());

INSERT INTO public.periodicos (nombre) VALUES ('AS'), ('Marca'), ('Sport'), ('Superdeporte')
  ON CONFLICT (nombre) DO NOTHING;

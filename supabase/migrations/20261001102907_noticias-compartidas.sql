-- Biblioteca de noticias compartida entre todas las personas autorizadas
-- (hasta ahora solo se guardaba en localStorage, un navegador por
-- persona). También añade nombre/apellidos a authorized_emails para
-- poder mostrar quién edita/termina cada noticia, y permite que
-- cualquier persona autorizada (no solo administradores) lea ese
-- directorio para mostrar nombres y poder filtrar por persona.

ALTER TABLE public.authorized_emails
  ADD COLUMN IF NOT EXISTS nombre text,
  ADD COLUMN IF NOT EXISTS apellidos text;

CREATE TABLE IF NOT EXISTS public.noticias (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  fecha_noticia date,
  editado boolean NOT NULL DEFAULT false,
  terminado boolean NOT NULL DEFAULT false,
  creado_por text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  editado_por text,
  editado_en timestamptz,
  terminado_por text,
  terminado_en timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.noticias TO authenticated;
GRANT ALL ON public.noticias TO service_role;
ALTER TABLE public.noticias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "autorizados_ven_noticias" ON public.noticias;
CREATE POLICY "autorizados_ven_noticias" ON public.noticias FOR SELECT TO authenticated
  USING (public.is_email_authorized(coalesce(auth.jwt()->>'email','')));

DROP POLICY IF EXISTS "autorizados_crean_noticias" ON public.noticias;
CREATE POLICY "autorizados_crean_noticias" ON public.noticias FOR INSERT TO authenticated
  WITH CHECK (public.is_email_authorized(coalesce(auth.jwt()->>'email','')));

DROP POLICY IF EXISTS "autorizados_actualizan_noticias" ON public.noticias;
CREATE POLICY "autorizados_actualizan_noticias" ON public.noticias FOR UPDATE TO authenticated
  USING (public.is_email_authorized(coalesce(auth.jwt()->>'email','')))
  WITH CHECK (public.is_email_authorized(coalesce(auth.jwt()->>'email','')));

DROP POLICY IF EXISTS "autorizados_borran_noticias" ON public.noticias;
CREATE POLICY "autorizados_borran_noticias" ON public.noticias FOR DELETE TO authenticated
  USING (public.is_email_authorized(coalesce(auth.jwt()->>'email','')));

CREATE INDEX IF NOT EXISTS noticias_fecha_idx ON public.noticias (fecha_noticia);
CREATE INDEX IF NOT EXISTS noticias_editado_por_idx ON public.noticias (editado_por);
CREATE INDEX IF NOT EXISTS noticias_terminado_idx ON public.noticias (terminado);

-- Cualquier persona autorizada puede leer el directorio (nombre/apellidos
-- por correo) de authorized_emails, no solo los administradores: hace
-- falta para mostrar nombres y filtrar por persona en la biblioteca.
-- (La política "Admin ve la lista" ya existente sigue activa; esta se
-- suma, no la sustituye.)
DROP POLICY IF EXISTS "autorizados_ven_directorio" ON public.authorized_emails;
CREATE POLICY "autorizados_ven_directorio" ON public.authorized_emails FOR SELECT TO authenticated
  USING (public.is_email_authorized(coalesce(auth.jwt()->>'email','')));

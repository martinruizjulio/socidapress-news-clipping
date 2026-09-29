CREATE TABLE public.authorized_emails (
  email text PRIMARY KEY CHECK (email = lower(email)),
  is_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.authorized_emails TO authenticated;
GRANT ALL ON public.authorized_emails TO service_role;
ALTER TABLE public.authorized_emails ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.authorized_emails
    WHERE email = lower(coalesce(auth.jwt()->>'email','')) AND is_admin);
$$;

CREATE OR REPLACE FUNCTION public.is_email_authorized(_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.authorized_emails WHERE email = lower(trim(_email)));
$$;
GRANT EXECUTE ON FUNCTION public.is_email_authorized(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

CREATE POLICY "Admin ve la lista" ON public.authorized_emails FOR SELECT TO authenticated
  USING (public.is_admin() OR email = lower(coalesce(auth.jwt()->>'email','')));
CREATE POLICY "Admin añade" ON public.authorized_emails FOR INSERT TO authenticated
  WITH CHECK (public.is_admin() AND is_admin = false);
CREATE POLICY "Admin quita" ON public.authorized_emails FOR DELETE TO authenticated
  USING (public.is_admin() AND is_admin = false);

INSERT INTO public.authorized_emails (email, is_admin) VALUES ('julio.martin@ucv.es', true);
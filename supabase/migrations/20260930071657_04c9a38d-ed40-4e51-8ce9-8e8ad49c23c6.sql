CREATE TABLE IF NOT EXISTS public.login_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  code_hash text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.login_codes TO service_role;
ALTER TABLE public.login_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "login_codes_no_client_access" ON public.login_codes
  FOR SELECT TO authenticated USING (false);
CREATE INDEX IF NOT EXISTS login_codes_email_created_idx ON public.login_codes (lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS login_codes_expires_idx ON public.login_codes (expires_at);
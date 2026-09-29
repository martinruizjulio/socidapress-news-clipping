import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { Toaster } from "sonner";
import { AuthGate } from "@/components/auth-gate";

const SocidaPressApp = lazy(() => import("@/components/socida-press"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SocidaPress · Importa noticias de periódico en PDF" },
      {
        name: "description",
        content:
          "SocidaPress importa noticias en PDF, separa imágenes y texto por OCR y te permite elegir qué conservar.",
      },
      {
        property: "og:title",
        content: "SocidaPress · Importa noticias de periódico en PDF",
      },
      {
        property: "og:description",
        content:
          "Digitaliza noticias de periódico: extrae fotos y texto por OCR y elige qué conservar.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <>
      <ClientOnly
        fallback={
          <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
            Cargando SocidaPress…
          </div>
        }
      >
        {(
          <Suspense
            fallback={
              <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
                Cargando SocidaPress…
              </div>
            }
          >
            <AuthGate>
              <SocidaPressApp />
            </AuthGate>
          </Suspense>
        )}
      </ClientOnly>
      <Toaster richColors position="top-right" />
    </>
  );
}

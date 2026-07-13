import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("../../pages/prod-view/ProdViewPage").then((m) => ({ default: m.ProdViewPage })));

export const Route = createFileRoute("/view/$prodViewId")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <Page />
    </Suspense>
  ),
});

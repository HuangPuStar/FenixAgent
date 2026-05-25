import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const ChannelsPage = lazy(() => import("../../pages/ChannelsPage").then((m) => ({ default: m.ChannelsPage })));

export const Route = createFileRoute("/_app/channels")({
  component: () => (
    <Suspense>
      <ChannelsPage />
    </Suspense>
  ),
});

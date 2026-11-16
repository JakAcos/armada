import { createFileRoute } from "@tanstack/react-router";

import { CaptainsPage } from "../components/captains/CaptainsPage";

export const Route = createFileRoute("/_chat/captains")({
  component: CaptainsPage,
});

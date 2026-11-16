import { createCaptainEnvironmentAtoms } from "@t3tools/client-runtime/state/captains";

import { connectionAtomRuntime } from "../connection/runtime";

export const captainEnvironment = createCaptainEnvironmentAtoms(connectionAtomRuntime);

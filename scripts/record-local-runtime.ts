// Writes deployments/local.runtime.json for the running Yaci devnet (zero time and
// slot config), dropping data left over from an earlier devnet.
import { currentLocalRuntime, LOCAL_RUNTIME_FILE } from "./lib/local-runtime.js";

currentLocalRuntime()
  .then((runtime) => console.log(`deployments/${LOCAL_RUNTIME_FILE}: devnet start ${runtime.devnetStartTime}, zeroTime ${runtime.slotConfig.zeroTime}`))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

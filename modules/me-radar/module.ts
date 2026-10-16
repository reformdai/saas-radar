// What me-radar says about its addresses: /me/* is answered by the api process (see server.ts).
import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "me-radar",
  apiPaths: [/^me\//],
});

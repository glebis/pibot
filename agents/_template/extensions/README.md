# Private plugins for this agent

Drop `.ts` pi-extension files here and they load into **this agent only**.

```ts
// extensions/my-plugin.ts
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const plugin: InlineExtension = {
  name: "my-plugin",
  factory: (pi) => {
    pi.registerTool({
      name: "my_tool",
      label: "My tool",
      description: "…",
      parameters: Type.Object({ input: Type.String() }),
      execute: async (_id, params) => ({
        content: [{ type: "text", text: `got ${params.input}` }],
        details: {},
      }),
    });
  },
};
```

Shared plugins (scheduler, memory, calendar, promises) are provided by the host
and enabled for every agent — see src/plugins/.
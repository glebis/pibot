import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AvatarArtifactStore, AvatarProviderRegistry } from "../core/avatar.js";

export interface AvatarPluginOptions {
  agentId: string;
  transport: string;
  providers: AvatarProviderRegistry;
  store: AvatarArtifactStore;
  confirm: (description: string) => Promise<boolean>;
  applyProfilePhoto: (transport: string, filePath: string) => Promise<void>;
}

export function avatarPlugin(options: AvatarPluginOptions): InlineExtension {
  return {
    name: "avatar",
    factory: (pi) => {
      pi.registerTool({
        name: "avatar_generate",
        label: "Generate Avatar",
        description: "Generate and select a bot avatar. This never changes the Telegram profile photo.",
        parameters: Type.Object({
          provider: Type.String({ description: "Avatar provider id (local, openai, or nano-banana)" }),
          seed: Type.String({ minLength: 1, maxLength: 500 }),
          label: Type.Optional(Type.String({ maxLength: 12 })),
        }),
        async execute(_toolCallId, params) {
          const generated = await options.providers.generate(params.provider, { seed: params.seed, label: params.label });
          const artifact = await options.store.save({
            agentId: options.agentId,
            transport: options.transport,
            providerId: params.provider,
            bytes: generated.bytes,
            mimeType: generated.mimeType,
          });
          return {
            content: [{ type: "text", text: `Avatar generated and ready for review. Artifact: ${artifact.id}. It has not been applied.` }],
            details: { artifactId: artifact.id, provider: artifact.providerId },
          };
        },
      });

      pi.registerTool({
        name: "avatar_apply",
        label: "Apply Avatar",
        description: "Apply a previously generated avatar to this Telegram bot after explicit owner confirmation.",
        parameters: Type.Object({ artifactId: Type.String({ description: "Selected avatar artifact id" }) }),
        async execute(_toolCallId, params) {
          const artifact = await options.store.resolve(params.artifactId, {
            agentId: options.agentId,
            transport: options.transport,
          });
          const confirmed = await options.confirm(`Apply the selected avatar as this bot's Telegram profile photo?`);
          if (!confirmed) {
            return {
              content: [{ type: "text", text: "Cancelled: the avatar was not applied." }],
              details: { artifactId: artifact.id, applied: false },
            };
          }
          await options.applyProfilePhoto(options.transport, artifact.filePath);
          return {
            content: [{ type: "text", text: "Telegram profile photo updated with the selected avatar." }],
            details: { artifactId: artifact.id, applied: true },
          };
        },
      });
    },
  };
}

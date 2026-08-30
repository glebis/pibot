import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SpeechArtifactStore, SpeechKind, SpeechProviderRegistry } from "../core/speech.js";

export interface SpeechPluginOptions {
  agentId: string;
  transport: string;
  chatId: string;
  providers: SpeechProviderRegistry;
  store: SpeechArtifactStore;
  send: (transport: string, chatId: string, kind: SpeechKind, filePath: string, caption?: string) => Promise<void>;
}

export function speechPlugin(options: SpeechPluginOptions): InlineExtension {
  const scope = { agentId: options.agentId, transport: options.transport, chatId: options.chatId };
  return {
    name: "speech",
    factory: (pi) => {
      pi.registerTool({
        name: "speech_generate",
        label: "Generate Speech",
        description: "Generate a private local speech artifact. This never sends a Telegram message. Use only after the owner explicitly asks for voice or audio.",
        parameters: Type.Object({
          text: Type.String({ minLength: 1, maxLength: 2000 }),
          kind: Type.Union([Type.Literal("voice"), Type.Literal("audio")]),
          provider: Type.Optional(Type.Literal("local", { default: "local" })),
          voice: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        }),
        async execute(_toolCallId, params) {
          const providerId = params.provider ?? "local";
          const generated = await options.providers.generate(providerId, { text: params.text, kind: params.kind, voice: params.voice });
          const artifact = await options.store.save({
            ...scope,
            providerId,
            kind: params.kind,
            bytes: generated.bytes,
            mimeType: generated.mimeType,
            extension: generated.extension,
          });
          return {
            content: [{ type: "text", text: `Speech generated locally. Artifact: ${artifact.id}. It has not been sent.` }],
            details: { artifactId: artifact.id, kind: artifact.kind, provider: artifact.providerId, sent: false },
          };
        },
      });

      pi.registerTool({
        name: "speech_send",
        label: "Send Speech",
        description: "Send a previously generated speech artifact to this exact invoking Telegram chat. Never use from heartbeat, schedules, replay, or without an explicit owner request.",
        parameters: Type.Object({
          artifactId: Type.String(),
          caption: Type.Optional(Type.String({ maxLength: 1024 })),
        }),
        async execute(_toolCallId, params) {
          const artifact = await options.store.resolve(params.artifactId, scope);
          await options.send(options.transport, options.chatId, artifact.kind, artifact.filePath, params.caption);
          // Delivery success is authoritative. A cleanup failure must not turn a
          // sent message into an apparent failure that invites a duplicate send.
          await options.store.remove(artifact.id, scope).catch(() => {
            console.warn("[speech] post-send artifact cleanup failed; retention sweep will retry");
          });
          return {
            content: [{ type: "text", text: `Telegram ${artifact.kind} message sent.` }],
            details: { artifactId: artifact.id, kind: artifact.kind, sent: true },
          };
        },
      });
    },
  };
}

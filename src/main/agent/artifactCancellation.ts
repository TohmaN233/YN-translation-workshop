export class ArtifactCancelledError extends Error {
  readonly code = "YN_ARTIFACT_CANCELLED";
  constructor(message = "Artifact operation cancelled.") {
    super(message.startsWith("[YN_ARTIFACT_CANCELLED]") ? message : `[YN_ARTIFACT_CANCELLED] ${message}`);
    this.name = "ArtifactCancelledError";
  }
}
export interface ArtifactErrorPacket { message: string; code?: string; errors?: ArtifactErrorPacket[] }
export function serializeArtifactError(value: unknown): ArtifactErrorPacket {
  const error = value instanceof Error ? value : new Error(String(value));
  return { message: error.message, code: (error as Error & { code?: string }).code,
    ...(error instanceof AggregateError ? { errors: error.errors.map(serializeArtifactError) } : {}) };
}
export function deserializeArtifactError(packet: ArtifactErrorPacket): Error {
  if (packet.errors) return new AggregateError(packet.errors.map(deserializeArtifactError), packet.message);
  if (packet.code === "YN_ARTIFACT_CANCELLED") return new ArtifactCancelledError(packet.message);
  return Object.assign(new Error(packet.message), { code: packet.code });
}

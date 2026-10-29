/** Ephemeral visual context. Not a permission or a durable memory. */
export interface WakeImage {
  readonly mediaType: "image/jpeg";
  readonly base64: string;
  readonly capturedAt: string;
  readonly width: number;
  readonly height: number;
  readonly surface: "primary" | "wake-window";
}

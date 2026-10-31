/** Private host ports. Never expose these through model tools or the desktop bridge. */
export interface NotionGrant {
  readonly generation: string;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly credentialRef: string;
  readonly rootPageIds: readonly string[];
  readonly readContent: boolean;
  readonly mode: "internal" | "public" | "pat";
  readonly includeDescendants: boolean;
  /** Host aborts this on Pause, Force-off, policy change, disconnect or revocation. */
  readonly signal: AbortSignal;
}

export interface NotionHost {
  /** Fail closed unless installed, configured, explicitly authorized AND currently allowed. */
  currentGrant(): NotionGrant | null;
  /** OS vault binding must match all three identifiers, not just the presence of a token. */
  withCredential<T>(
    binding: { accountId: string; workspaceId: string; credentialRef: string },
    use: (token: string) => Promise<T>,
  ): Promise<T>;
}

export type NotionKind = "page" | "block" | "database" | "data_source";
export interface NotionTarget {
  readonly kind: NotionKind;
  readonly id: string;
}

/** Explicit path starting at a granted page. Each edge is revalidated against Notion. */
export type NotionPath = readonly NotionTarget[];

export interface NotionResult {
  readonly trust: "untrusted_source_content";
  readonly provenance: {
    readonly provider: "notion";
    readonly apiVersion: "2026-03-11";
    readonly accountId: string;
    readonly workspaceId: string;
    readonly id: string;
    readonly url: string;
    readonly readAt: string;
    readonly sourceCreatedAt: string | null;
    readonly sourceEditedAt: string | null;
  };
  readonly content: Record<string, unknown>;
}

export interface NotionList {
  readonly items: readonly NotionResult[];
  /** No cursor leaves the adapter; another call starts a new bounded exploration. */
  readonly truncated: boolean;
}

/** Supplied by the common connector's state reader, never inferred from a token here. */
export interface NotionState {
  readonly installed: boolean;
  readonly configured: boolean;
  readonly authorized: boolean;
  readonly available: boolean;
  readonly availabilityMeaning:
    "local_eligibility_not_provider_probe" | "recent_success_and_current_controls";
  readonly scope?: unknown;
}

export type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;

export type OutboundMediaAccess = {
  localRoots?: readonly string[];
  readFile?: OutboundMediaReadFile;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
  /** Allow host-local outbound attachment sends for any file type. */
  allowAllHostSendFileTypes?: boolean;
};

export type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  readFile?: (filePath: string) => Promise<Buffer>;
  hostReadCapability?: boolean;
  hostReadAllowAllFileTypes?: boolean;
  optimizeImages?: boolean;
  /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};

export function resolveOutboundMediaLocalRoots(
  mediaLocalRoots?: readonly string[],
): readonly string[] | undefined {
  return mediaLocalRoots && mediaLocalRoots.length > 0 ? mediaLocalRoots : undefined;
}

export function resolveOutboundMediaAccess(
  params: {
    mediaAccess?: OutboundMediaAccess;
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: OutboundMediaReadFile;
  } = {},
): OutboundMediaAccess | undefined {
  const localRoots = resolveOutboundMediaLocalRoots(
    params.mediaAccess?.localRoots ?? params.mediaLocalRoots,
  );
  const readFile = params.mediaAccess?.readFile ?? params.mediaReadFile;
  const workspaceDir = params.mediaAccess?.workspaceDir;
  const allowAllHostSendFileTypes = params.mediaAccess?.allowAllHostSendFileTypes;
  if (!localRoots && !readFile && !workspaceDir && !allowAllHostSendFileTypes) {
    return undefined;
  }
  return {
    ...(localRoots ? { localRoots } : {}),
    ...(readFile ? { readFile } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(allowAllHostSendFileTypes ? { allowAllHostSendFileTypes } : {}),
  };
}

export function buildOutboundMediaLoadOptions(
  params: OutboundMediaLoadParams = {},
): OutboundMediaLoadOptions {
  const mediaAccess = resolveOutboundMediaAccess(params);
  const workspaceDir = mediaAccess?.workspaceDir ?? params.workspaceDir;
  if (mediaAccess?.readFile) {
    return {
      ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
      localRoots: "any",
      readFile: mediaAccess.readFile,
      hostReadCapability: true,
      ...(mediaAccess.allowAllHostSendFileTypes ? { hostReadAllowAllFileTypes: true } : {}),
      ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }
  const localRoots = mediaAccess?.localRoots;
  return {
    ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
    ...(localRoots ? { localRoots } : {}),
    ...(mediaAccess?.allowAllHostSendFileTypes ? { hostReadAllowAllFileTypes: true } : {}),
    ...(params.optimizeImages !== undefined ? { optimizeImages: params.optimizeImages } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
  };
}

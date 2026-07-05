/** Shared startup policy for gateway binds that do not resolve to loopback. */
import type { GatewayAuthMode, GatewayBindMode } from "../config/types.gateway.js";

/**
 * Returns true when startup must reject a non-loopback bind for missing auth.
 *
 * The sole no-auth exception is the explicit local-fork contract: operators
 * must choose both a custom bind and auth mode none. Auto/LAN/tailnet binds
 * never inherit this exception, and token/password modes still require a
 * resolved secret.
 */
export function shouldBlockGatewayBindWithoutAuth(params: {
  bindMode: GatewayBindMode;
  isLoopback: boolean;
  hasSharedSecret: boolean;
  authMode: GatewayAuthMode;
}): boolean {
  if (params.isLoopback || params.hasSharedSecret || params.authMode === "trusted-proxy") {
    return false;
  }
  return !(params.bindMode === "custom" && params.authMode === "none");
}

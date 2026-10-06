/** Routes the browser may reach through /api/v1. Admin writes and outbound quote fan-out stay on the operator machine. */
export function isAllowedRoute(method: string, path: string): boolean {
  if (path.includes("..")) return false;
  if (method === "GET") return path.startsWith("/v1/") || path === "/health";
  return method === "POST" && path === "/v1/tx/preview";
}

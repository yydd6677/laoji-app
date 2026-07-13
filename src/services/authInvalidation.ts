type UnauthorizedHandler = (accessToken: string) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

export function notifyUnauthorized(accessToken: string): void {
  if (accessToken) unauthorizedHandler?.(accessToken);
}

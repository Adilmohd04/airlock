/// <reference types="vite/client" />

declare module "*?url" {
  const src: string;
  export default src;
}

declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

interface Navigator {
  /** Present in the Chrome WebMCP preview and via @mcp-b/webmcp-polyfill's testing shim. */
  modelContextTesting?: {
    listTools: () => { name: string; description?: string }[];
    executeTool: (name: string, argsJson: string) => Promise<unknown>;
  };
}

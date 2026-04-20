export function deriveWsUrl(rpcUrl: string): string {
  return rpcUrl
    .replace(/^https:\/\//, 'wss://')
    .replace(/^http:\/\//, 'ws://');
}

export function isHeliusUrl(rpcUrl: string): boolean {
  return rpcUrl.includes('helius-rpc.com') || rpcUrl.includes('helius.dev');
}

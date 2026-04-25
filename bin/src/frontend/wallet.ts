// CIP-30 type declarations
declare global {
  interface Window {
    cardano: Record<string, Cardano30Wallet>;
  }
}

interface Cardano30Wallet {
  name: string;
  icon: string;
  apiVersion: string;
  enable(): Promise<WalletApi>;
  isEnabled(): Promise<boolean>;
}

interface WalletApi {
  getBalance(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  getUnusedAddresses(): Promise<string[]>;
}

// ⚠ REPLACE with your token's policy id (28 bytes hex) + asset name hex.
// Must match ect_policy_id / ect_asset_name in bin/contracts/validators/event_chain.ak.
export const ECT_POLICY_ID = "00000000000000000000000000000000000000000000000000000000";
export const ECT_ASSET_NAME = "";

let walletApi: WalletApi | null = null;
let connectedWalletName: string | null = null;

export function getAvailableWallets(): string[] {
  if (!window.cardano) return [];
  return Object.keys(window.cardano);
}

export async function connectWallet(walletName: string): Promise<string> {
  if (!window.cardano?.[walletName]) {
    throw new Error(`Wallet "${walletName}" not found. Install it first.`);
  }
  walletApi = await window.cardano[walletName].enable();
  connectedWalletName = walletName;

  const addresses = await walletApi.getUsedAddresses();
  const address = addresses[0] ?? (await walletApi.getUnusedAddresses())[0];
  if (!address) throw new Error("No address found in wallet.");
  return address;
}

export async function getECTBalance(): Promise<number> {
  if (!walletApi) return 0;
  try {
    const balanceCbor = await walletApi.getBalance();
    // Parse the CBOR-encoded balance for the ECT asset
    // In a real implementation this uses a CBOR library; here we return a mock
    console.log("Raw balance CBOR:", balanceCbor);
    return 1000; // placeholder: 1,000 $ECT$
  } catch {
    return 0;
  }
}

export function getConnectedWallet(): string | null {
  return connectedWalletName;
}

export async function disconnectWallet(): Promise<void> {
  walletApi = null;
  connectedWalletName = null;
}

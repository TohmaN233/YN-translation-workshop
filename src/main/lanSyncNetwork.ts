import { createSocket } from "node:dgram";

export interface LanNetworkAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

export type LanNetworkInterfaces = Record<string, LanNetworkAddress[] | undefined>;

export function buildLanSyncUrls(
  token: string,
  port: number,
  interfaces: LanNetworkInterfaces,
  preferredAddress?: string
): { localUrl: string; lanUrls: string[] } {
  const pathPart = `/s/${encodeURIComponent(token)}`;
  const addresses: string[] = [];
  for (const items of Object.values(interfaces)) {
    for (const item of items ?? []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }
  const uniqueAddresses = [...new Set(addresses)];
  const primaryAddress = preferredAddress && uniqueAddresses.includes(preferredAddress)
    ? preferredAddress
    : uniqueAddresses[0];
  return {
    localUrl: `http://127.0.0.1:${port}${pathPart}`,
    lanUrls: primaryAddress ? [`http://${primaryAddress}:${port}${pathPart}`] : []
  };
}

export async function detectDefaultRouteIpv4Address(): Promise<string | undefined> {
  const socket = createSocket("udp4");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (address?: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // An error may arrive before the UDP socket has entered its running state.
      }
      resolve(address);
    };
    socket.once("error", () => finish());
    try {
      socket.connect(9, "192.0.2.1", () => {
        const selected = socket.address();
        finish(typeof selected === "object" ? selected.address : undefined);
      });
    } catch {
      finish();
    }
  });
}

import assert from "node:assert/strict";

import { buildLanSyncUrls } from "../../src/main/lanSyncNetwork.ts";

const urls = buildLanSyncUrls("session/token", 43123, {
  "vEthernet (WSL (Hyper-V firewall))": [
    { address: "172.22.16.1", family: "IPv4", internal: false }
  ],
  "Wi-Fi": [
    { address: "192.168.2.13", family: "IPv4", internal: false }
  ],
  "VMware Network Adapter VMnet8": [
    { address: "192.168.202.1", family: "IPv4", internal: false }
  ]
}, "192.168.2.13");

assert.equal(urls.localUrl, "http://127.0.0.1:43123/s/session%2Ftoken");
assert.equal(
  urls.lanUrls[0],
  "http://192.168.2.13:43123/s/session%2Ftoken",
  "the OS-selected default-route address must be the primary LAN URL even when a virtual adapter enumerates first"
);
assert.deepEqual(urls.lanUrls, ["http://192.168.2.13:43123/s/session%2Ftoken"]);

console.log("ok LAN URL selection exposes only the OS-selected primary address");

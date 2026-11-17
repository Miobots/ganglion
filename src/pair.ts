import { randomInt } from "node:crypto";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { decode, encode, Kind, newEnvelope, ProtocolDefaults, SequenceCounter, Topics, type AckPayload } from "@miobots/protocol";
import { approvedFolders, configDir, savePairing } from "./pairing.ts";

/**
 * `bun run pair --folder ~/Documents/Mio` — pair this laptop with Brain (G0.2, G0.3).
 *
 * Shows a six-digit code, waits for a human to type it into the app, then saves this laptop's own
 * token and the approved folders. Run it again to re-pair; the old token stops working.
 */
const { values } = parseArgs({
  options: {
    folder: { type: "string", multiple: true, default: [] },
    brain: { type: "string" },
    "device-id": { type: "string" },
    name: { type: "string" },
  },
});

const brainUrl = values.brain ?? process.env.BRAIN_WS_URL ?? ProtocolDefaults.DEFAULT_BRAIN_URL;
const name = values.name ?? hostname();
const deviceId = values["device-id"] ?? `ganglion-${hostname()}`;
const filesystem = await approvedFolders(values.folder ?? []);
const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

const ack = await new Promise<AckPayload>((resolve, reject) => {
  const socket = new WebSocket(brainUrl);
  const request = newEnvelope({
    kind: Kind.CMD,
    topic: Topics.SYS_PAIR,
    seq: new SequenceCounter(),
    payload: { device_id: deviceId, code, name, protocol_version: ProtocolDefaults.PROTOCOL_VERSION },
  });
  socket.on("open", () => {
    socket.send(encode(request));
    console.log("Ganglion is not paired yet.");
    console.log(`Pairing code:  ${code.slice(0, 3)} ${code.slice(3)}     (expires in ${ProtocolDefaults.PAIRING_CODE_TTL_MS / 60_000} minutes)`);
    console.log("Enter it in the MioBots app → Devices → Pair a laptop");
  });
  socket.on("message", (raw) => {
    const envelope = decode(raw.toString());
    if (envelope.kind === Kind.ACK && envelope.corr_id === request.corr_id) resolve(envelope.payload as AckPayload);
  });
  socket.on("close", () => reject(new Error("Brain closed the connection before pairing finished.")));
  socket.on("error", (error) => reject(new Error(`Could not reach Brain at ${brainUrl}: ${error.message}`)));
}).catch((error: Error) => ({ accepted: false, reason: error.message }) satisfies AckPayload);

if (!ack.accepted || !ack.token) {
  console.error(`Pairing failed: ${ack.reason ?? "no token was issued"}`);
  process.exit(1);
}

await savePairing({ brain_url: brainUrl, device_id: deviceId, token: ack.token }, filesystem ? { filesystem } : {});
console.log(`Paired as "${ack.name ?? name}". Saved to ${configDir()}.`);
console.log(filesystem
  ? `Approved folders (read-only): ${filesystem.approvedDirectories.map((d) => d.path).join(", ")}`
  : "No approved folders: file tools are off. Re-pair with --folder to add some.");
console.log("Start Ganglion with: bun start");
process.exit(0);

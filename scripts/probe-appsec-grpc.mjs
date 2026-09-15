// Read-only probe for the official SourceCraft AppSec gRPC endpoint.
// It never prints report payloads or the authorization token: only protocol
// status and byte counters are emitted.
import http2 from "node:http2";

const [gitRepo, repoPublicUuid, engineName, reportTypeArg = "1", servicePath = "/v1.results.FileDownloadService/DownloadFileStream"] = process.argv.slice(2);
if (!gitRepo || !repoPublicUuid || !engineName) {
  console.error("usage: node --env-file=.env scripts/probe-appsec-grpc.mjs <git-repo> <repo-uuid> <engine-name> [report-type]");
  process.exit(2);
}
const token = process.env.SOURCECRAFT_TOKEN;
if (!token) throw new Error("SOURCECRAFT_TOKEN is required");
const reportType = Number(reportTypeArg);

function varint(value) {
  const bytes = [];
  let current = Number(value);
  do {
    let byte = current & 0x7f;
    current = Math.floor(current / 128);
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function stringField(number, value) {
  const data = Buffer.from(value, "utf8");
  return Buffer.concat([varint((number << 3) | 2), varint(data.length), data]);
}

function enumField(number, value) {
  return Buffer.concat([varint(number << 3), varint(value)]);
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7;
  }
  return null;
}

function contentBytes(message) {
  let offset = 0;
  let total = 0;
  while (offset < message.length) {
    const tag = readVarint(message, offset);
    if (!tag) break;
    offset = tag.next;
    const wire = tag.value & 7;
    const field = tag.value >> 3;
    if (wire === 2) {
      const length = readVarint(message, offset);
      if (!length) break;
      offset = length.next;
      if (field === 1) total += length.value;
      offset += length.value;
    } else if (wire === 0) {
      const value = readVarint(message, offset);
      if (!value) break;
      offset = value.next;
    } else {
      break;
    }
  }
  return total;
}

const message = Buffer.concat([
  stringField(1, gitRepo),
  stringField(3, engineName),
  enumField(4, reportType),
  stringField(5, repoPublicUuid),
]);
const frame = Buffer.alloc(5 + message.length);
frame.writeUInt8(0, 0);
frame.writeUInt32BE(message.length, 1);
message.copy(frame, 5);

const client = http2.connect("https://appsec.sourcecraft.tech");
const request = client.request({
  ":method": "POST",
  ":path": servicePath,
  "content-type": "application/grpc",
  te: "trailers",
  authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
});

let httpStatus = null;
let grpcStatus = null;
let grpcMessage = null;
let pending = Buffer.alloc(0);
let frames = 0;
let payloadBytes = 0;
let reportBytes = 0;

request.on("response", (headers) => {
  httpStatus = headers[":status"] ?? null;
  grpcStatus = headers["grpc-status"] ?? grpcStatus;
  grpcMessage = headers["grpc-message"] ?? grpcMessage;
});
request.on("trailers", (headers) => {
  grpcStatus = headers["grpc-status"] ?? grpcStatus;
  grpcMessage = headers["grpc-message"] ?? grpcMessage;
});
request.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    const payload = pending.subarray(5, 5 + length);
    frames++;
    payloadBytes += payload.length;
    reportBytes += contentBytes(payload);
    pending = pending.subarray(5 + length);
  }
});
request.on("end", () => {
  console.log(JSON.stringify({
    endpoint: "appsec.sourcecraft.tech:443",
    service: servicePath,
    httpStatus,
    grpcStatus,
    grpcMessage,
    frames,
    payloadBytes,
    reportBytes,
    trailingBytes: pending.length,
  }));
  client.close();
});
request.on("error", (error) => {
  console.error(JSON.stringify({ error: error.message }));
  client.close();
  process.exitCode = 1;
});
request.end(frame);

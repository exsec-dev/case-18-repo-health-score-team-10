// Read-only gRPC reflection probe for the official SourceCraft AppSec host.
// Prints only protocol status and advertised service-like identifiers.
import http2 from "node:http2";

const token = process.env.SOURCECRAFT_TOKEN;
if (!token) throw new Error("SOURCECRAFT_TOKEN is required");

const paths = [
  "/grpc.reflection.v1.ServerReflection/ServerReflectionInfo",
  "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
];

function probe(path) {
  return new Promise((resolve) => {
    const client = http2.connect("https://appsec.sourcecraft.tech");
    const request = client.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/grpc",
      te: "trailers",
      authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}`,
    });
    let httpStatus = null;
    let grpcStatus = null;
    let grpcMessage = null;
    const chunks = [];
    request.on("response", (headers) => {
      httpStatus = headers[":status"] ?? null;
      grpcStatus = headers["grpc-status"] ?? grpcStatus;
      grpcMessage = headers["grpc-message"] ?? grpcMessage;
    });
    request.on("trailers", (headers) => {
      grpcStatus = headers["grpc-status"] ?? grpcStatus;
      grpcMessage = headers["grpc-message"] ?? grpcMessage;
    });
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const identifiers = [...new Set(
        (body.toString("latin1").match(/[A-Za-z][A-Za-z0-9_.]{3,}/g) ?? [])
          .filter((value) => value.includes(".")),
      )].slice(0, 100);
      client.close();
      resolve({ path, httpStatus, grpcStatus, grpcMessage, bodyBytes: body.length, identifiers });
    });
    request.on("error", (error) => {
      client.close();
      resolve({ path, error: error.message });
    });
    // gRPC frame containing ServerReflectionRequest.list_services = "".
    request.end(Buffer.from([0, 0, 0, 0, 2, 0x3a, 0]));
  });
}

for (const path of paths) console.log(JSON.stringify(await probe(path)));

import { createServer } from "node:http";
import { getActivePayment, getPolicy } from "./near-rpc.js";

const port = Number(process.env.PORT ?? 3000);

const server = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.method !== "GET") {
    response.writeHead(405, { allow: "GET" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  if (request.url === "/health") {
    response.writeHead(200);
    response.end(JSON.stringify({ name: "tapproved", status: "ok", network: "testnet" }));
    return;
  }
  try {
    if (request.url === "/policy") {
      const policy = await getPolicy();
      response.writeHead(200);
      response.end(JSON.stringify({ network: "testnet", policy }));
      return;
    }
    if (request.url === "/active-payment") {
      const payment = await getActivePayment();
      response.writeHead(200);
      response.end(JSON.stringify({ network: "testnet", payment }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    response.writeHead(502);
    response.end(JSON.stringify({ error: "near_rpc_failed", message: error.message }));
  }
});

server.listen(port, () => {
  console.log(`Tapproved testnet read-only relay listening on port ${port}`);
});

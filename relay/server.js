import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    name: "tapproved",
    status: "scaffold",
    message: "Relay implementation is planned."
  }));
});

server.listen(port, () => {
  console.log(`Tapproved scaffold listening on port ${port}`);
});

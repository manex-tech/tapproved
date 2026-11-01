import { generateKeyPairSync, sign } from "node:crypto";
import { createInterface } from "node:readline";
import { encodeApprovalMessage } from "./protocol.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

function rawPublicKey(publicKey) {
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
}

async function main() {
  console.log("Tapproved approval simulator (LOCAL ONLY; not connected to NEAR).");
  console.log("Paste a payment JSON object, then submit an empty line:");
  const lines = [];
  for await (const line of rl) {
    if (line.trim() === "") break;
    lines.push(line);
  }

  try {
    const payment = JSON.parse(lines.join("\n"));
    const message = encodeApprovalMessage(payment);
    const pair = generateKeyPairSync("ed25519");
    console.log("\n=== PAYMENT APPROVAL REQUEST ===");
    console.log("Contract:  " + payment.contract_id);
    console.log("Network:   " + payment.network_id);
    console.log("Payment:   " + payment.payment_id);
    console.log("Recipient: " + payment.recipient_id);
    console.log("Amount:    " + payment.amount_yocto + " yoctoNEAR");
    console.log("Expiry:    " + payment.expires_at_ns + " ns");
    console.log("\nAn ephemeral simulator key was generated.");
    console.log("Its public key is NOT registered on-chain and cannot authorize a real payment.");
    const approval = await ask("Type APPROVE to simulate the physical button press: ");
    if (approval !== "APPROVE") {
      console.log(JSON.stringify({ status: "rejected" }));
      return;
    }
    const signature = sign(null, message, pair.privateKey);
    console.log(JSON.stringify({
      status: "simulated_signature",
      public_key_hex: rawPublicKey(pair.publicKey),
      message_hex: message.toString("hex"),
      signature_hex: signature.toString("hex")
    }, null, 2));
  } catch (error) {
    console.error("Simulation failed: " + error.message);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  await main();
}

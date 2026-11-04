import { SerialPort } from "serialport";
import { randomUUID } from "node:crypto";

const portPath = process.env.SERIAL_PORT || "COM11";
const baudRate = Number(process.env.SERIAL_BAUD_RATE || 115200);

console.log("\n=======================================================");
console.log("  TAPPROVED ESP32 HARDWARE BUTTON VERIFICATION TEST");
console.log("=======================================================");
console.log(`Target Port: ${portPath} @ ${baudRate} baud\n`);

let port;
try {
  port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
} catch (err) {
  console.error(`❌ Failed to initialize serial port object: ${err.message}`);
  process.exit(1);
}

port.open((err) => {
  if (err) {
    if (err.message.includes("Access denied")) {
      console.error(`❌ ERROR: ACCESS DENIED on ${portPath}!`);
      console.error(`   Another application currently has ${portPath} open.`);
      console.error(`   Please CLOSE the Serial Monitor in Arduino IDE or VS Code / PlatformIO.`);
      console.error(`   Then re-run this command: npm run test:hardware\n`);
    } else {
      console.error(`❌ Error opening ${portPath}: ${err.message}`);
    }
    process.exit(1);
  }

  console.log(`✅ Successfully opened ${portPath}!\n`);
  console.log("⏳ Initializing device (waiting 1.5s for ESP32 boot/reset)...");

  // Allow DTR/RTS to settle
  setTimeout(() => {
    const requestId = randomUUID();
    const payload = JSON.stringify({
      frame_version: 1,
      request_id: requestId,
      contract_id: "manextech.testnet",
      network_id: "testnet",
      agent_id: "manex-agent.testnet",
      status: "pending",
      payment_id: "1",
      recipient_id: "manex-agent.testnet",
      amount_yocto: "50000000000000000000000",
      nonce: "1",
      expires_at_ns: "1800000000000000000"
    }) + "\n";

    console.log("📤 Sending payment authorization frame to ESP32...");
    port.write(payload, (writeErr) => {
      if (writeErr) {
        console.error(`❌ Write failed: ${writeErr.message}`);
        port.close();
        process.exit(1);
      }

      console.log("\n-------------------------------------------------------");
      console.log("👉 PRESS AND RELEASE THE GPIO25 BUTTON ON YOUR ESP32 NOW!");
      console.log("   (Waiting up to 30 seconds for physical button actuation)");
      console.log("-------------------------------------------------------\n");
    });
  }, 1500);
});

let buffer = "";

port.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  process.stdout.write(text);
  buffer += text;

  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const msg = JSON.parse(trimmed);
      if (msg.status === "signed") {
        console.log("\n=======================================================");
        console.log("🎉 SUCCESS! HARDWARE BUTTON CONFIRMED & WORKING!");
        console.log("=======================================================");
        console.log(`Public Key:    ${msg.public_key_hex}`);
        console.log(`Ed25519 Sig:   ${msg.signature_hex}`);
        console.log(`Request ID:    ${msg.request_id}`);
        console.log("\nYour GPIO25 wiring and button actuation are 100% OPERATIONAL!");
        console.log("=======================================================\n");
        port.close(() => process.exit(0));
        return;
      } else if (msg.status === "rejected_or_timed_out") {
        console.log("\n⚠️ TIMEOUT: 30 seconds elapsed without a physical button press.");
        console.log("Check that your button connects GPIO 25 to GND.");
        port.close(() => process.exit(1));
        return;
      } else if (msg.error) {
        console.log(`\n❌ ESP32 reported error: ${msg.error}`);
        port.close(() => process.exit(1));
        return;
      }
    } catch {
      // Ignore non-json debug text
    }
  }
});

port.on("error", (err) => {
  console.error(`\n❌ Serial port error: ${err.message}`);
});

// Overall timeout fallback
setTimeout(() => {
  console.log("\n❌ Script timeout reached.");
  if (port.isOpen) port.close();
  process.exit(1);
}, 38000);

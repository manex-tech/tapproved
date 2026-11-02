#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Ed25519.h>
#include <esp_system.h>
#include <cstring>
#include "amount_format.h"
#include "button_approval.h"
#include "approval_protocol.h"
#include "request_id_guard.h"
#include "zeroizing_buffer.h"
#include "key_record_policy.h"

namespace {
constexpr uint8_t APPROVAL_BUTTON_PIN = 25;
constexpr char NVS_NAMESPACE[] = "tapproved";
constexpr char NVS_SEED_KEY[] = "ed25519_seed";
constexpr char CONFIGURED_CONTRACT_ID[] = "manextech.testnet";
constexpr char CONFIGURED_NETWORK_ID[] = "testnet";
constexpr size_t MAX_MESSAGE_SIZE = tapproved_protocol::MAX_APPROVAL_MESSAGE_SIZE;
constexpr size_t MAX_SERIAL_LINE_BYTES = 2048;

Preferences preferences;
uint8_t public_key[32];
bool key_ready = false;
char serial_line[MAX_SERIAL_LINE_BYTES + 1];
size_t serial_line_length = 0;
bool serial_line_overflow = false;
LastRequestIdGuard request_id_guard;

bool isValidRequestId(const char* value) {
  if (!value || strlen(value) != 36) return false;
  for (size_t i = 0; i < 36; ++i) {
    const bool separator = i == 8 || i == 13 || i == 18 || i == 23;
    if (separator) {
      if (value[i] != '-') return false;
    } else if (!((value[i] >= '0' && value[i] <= '9') ||
                 (value[i] >= 'a' && value[i] <= 'f') ||
                 (value[i] >= 'A' && value[i] <= 'F'))) {
      return false;
    }
  }
  return true;
}

void printEnvelopeError(const char* request_id, const char* code) {
  if (isValidRequestId(request_id)) {
    Serial.printf("{\"frame_version\":1,\"request_id\":\"%s\",\"error\":\"%s\"}\n", request_id, code);
  } else {
    Serial.printf("{\"error\":\"%s\"}\n", code);
  }
}

bool isValidAccountId(const char* value) {
  if (!value) return false;
  const size_t length = strlen(value);
  if (length < 2 || length > 64) return false;
  bool previous_separator = false;
  for (size_t i = 0; i < length; ++i) {
    const char character = value[i];
    const bool alphanumeric = (character >= 'a' && character <= 'z') ||
                              (character >= '0' && character <= '9');
    if (alphanumeric) {
      previous_separator = false;
      continue;
    }
    const bool separator = character == '.' || character == '-' || character == '_';
    if (!separator || i == 0 || i + 1 == length || previous_separator) return false;
    previous_separator = true;
  }
  return true;
}

bool encodeApproval(const JsonDocument& doc, uint8_t* out, size_t& out_len) {
  const char* contract_id = doc["contract_id"] | "";
  const char* network_id = doc["network_id"] | "";
  const char* request_id = doc["request_id"] | "";
  const char* agent_id = doc["agent_id"] | "";
  const char* status = doc["status"] | "";
  if ((doc["frame_version"] | 0) != 1 || !isValidRequestId(request_id) ||
      strcmp(agent_id, "manex-agent.testnet") != 0 || strcmp(status, "pending") != 0) return false;
  const char* recipient_id = doc["recipient_id"] | "";
  if (strcmp(contract_id, CONFIGURED_CONTRACT_ID) != 0 ||
      strcmp(network_id, CONFIGURED_NETWORK_ID) != 0 ||
      !isValidAccountId(recipient_id)) return false;

  return tapproved_protocol::encodeApprovalMessage(
    contract_id,
    network_id,
    doc["payment_id"] | "",
    recipient_id,
    doc["amount_yocto"] | "",
    doc["nonce"] | "",
    doc["expires_at_ns"] | "",
    out,
    MAX_MESSAGE_SIZE,
    out_len
  );
}

bool loadOrCreateKey() {
  ZeroizingBuffer<32> seed;
  if (!preferences.begin(NVS_NAMESPACE, false)) return false;

  const bool key_exists = preferences.isKey(NVS_SEED_KEY);
  const size_t stored_length = preferences.getBytesLength(NVS_SEED_KEY);
  const KeyRecordAction action = decideKeyRecordAction(
    key_exists,
    stored_length,
    seed.size()
  );

  if (action == KeyRecordAction::RejectMalformed) {
    preferences.end();
    return false;
  }

  if (action == KeyRecordAction::LoadExisting) {
    const size_t loaded = preferences.getBytes(
      NVS_SEED_KEY,
      seed.data(),
      seed.size()
    );
    if (loaded != seed.size()) {
      preferences.end();
      return false;
    }
  } else {
    esp_fill_random(seed.data(), seed.size());
    const size_t written = preferences.putBytes(
      NVS_SEED_KEY,
      seed.data(),
      seed.size()
    );
    if (written != seed.size()) {
      preferences.end();
      return false;
    }
  }

  preferences.end();
  Ed25519::derivePublicKey(public_key, seed.data());
  key_ready = true;
  return true;
}

bool loadExistingKey(uint8_t* output_seed, size_t output_size) {
  if (!output_seed || output_size != 32) return false;
  if (!preferences.begin(NVS_NAMESPACE, true)) return false;

  const bool key_exists = preferences.isKey(NVS_SEED_KEY);
  const size_t stored_length = preferences.getBytesLength(NVS_SEED_KEY);
  const KeyRecordAction action = decideKeyRecordAction(
    key_exists,
    stored_length,
    output_size
  );
  if (action != KeyRecordAction::LoadExisting) {
    preferences.end();
    return false;
  }

  const size_t loaded = preferences.getBytes(NVS_SEED_KEY, output_seed, output_size);
  preferences.end();
  return loaded == output_size;
}

void printHex(const uint8_t* bytes, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    if (bytes[i] < 16) Serial.print('0');
    Serial.print(bytes[i], HEX);
  }
}

bool waitForFreshButtonPress(uint32_t timeout_ms) {
  const uint32_t started = millis();
  FreshPressDetector detector(50);
  detector.begin(digitalRead(APPROVAL_BUTTON_PIN) == HIGH, started);
  while (static_cast<uint32_t>(millis() - started) < timeout_ms) {
    if (detector.update(digitalRead(APPROVAL_BUTTON_PIN) == HIGH, millis())) {
      return true;
    }
    delay(5);
  }
  return false;
}

void handleRequest(const char* line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) {
    Serial.println("{\"error\":\"invalid_json\"}");
    return;
  }
  const char* request_id = doc["request_id"] | "";
  if (!isValidRequestId(request_id)) {
    printEnvelopeError(request_id, "invalid_request_id");
    return;
  }
  if (!request_id_guard.accept(request_id)) {
    printEnvelopeError(request_id, "duplicate_request");
    return;
  }
  ZeroizingBuffer<MAX_MESSAGE_SIZE> message;
  size_t message_len = 0;
  if (!encodeApproval(doc, message.data(), message_len)) {
    printEnvelopeError(request_id, "invalid_or_wrong_network_request");
    return;
  }

  const char* amount_yocto = doc["amount_yocto"] | "";
  char amount_display[64];
  if (!formatYoctoNear(amount_yocto, amount_display, sizeof(amount_display))) {
    printEnvelopeError(request_id, "invalid_amount_display");
    return;
  }

  Serial.println("\n=== PAYMENT APPROVAL SUMMARY ===");
  Serial.printf("Payment ID: %s\n", doc["payment_id"].as<const char*>());
  Serial.printf("Recipient:  %s\n", doc["recipient_id"].as<const char*>());
  Serial.printf("Amount:     %s\n", amount_display);
  Serial.printf("Exact:      %s yoctoNEAR\n", amount_yocto);
  Serial.printf("Contract:   %s\n", doc["contract_id"].as<const char*>());
  Serial.printf("Network:    %s\n", doc["network_id"].as<const char*>());
  Serial.printf("Expires at: %s ns\n", doc["expires_at_ns"].as<const char*>());
  Serial.println("USB serial output is host-controlled and is NOT a trusted display.");
  Serial.println("If held, release the button first. Then make one fresh press and release to approve.");
  Serial.println("A held button or contact bounce cannot approve. Wait 30 seconds to reject.");

  if (!waitForFreshButtonPress(30000)) {
    Serial.printf("{\"frame_version\":1,\"request_id\":\"%s\",\"status\":\"rejected_or_timed_out\"}\n", request_id);
    return;
  }

  ZeroizingBuffer<32> signing_seed;
  ZeroizingBuffer<32> signing_public_key;
  if (!loadExistingKey(signing_seed.data(), signing_seed.size())) {
    printEnvelopeError(request_id, "device_key_unavailable");
    return;
  }
  Ed25519::derivePublicKey(signing_public_key.data(), signing_seed.data());
  if (memcmp(signing_public_key.data(), public_key, sizeof(public_key)) != 0) {
    printEnvelopeError(request_id, "device_key_identity_mismatch");
    return;
  }

  ZeroizingBuffer<64> signature;
  Ed25519::sign(
    signature.data(),
    signing_seed.data(),
    signing_public_key.data(),
    message.data(),
    message_len
  );
  Serial.printf("{\"frame_version\":1,\"request_id\":\"%s\",\"status\":\"signed\",\"public_key_hex\":\"", request_id);
  printHex(public_key, sizeof(public_key));
  Serial.print("\",\"signature_hex\":\"");
  printHex(signature.data(), signature.size());
  Serial.println("\"}");
}
} // namespace

void setup() {
  Serial.begin(115200);
  pinMode(APPROVAL_BUTTON_PIN, INPUT_PULLUP);
  delay(300);
  if (!loadOrCreateKey()) {
    Serial.println("FATAL: device key storage unavailable or malformed; refusing identity replacement.");
    return;
  }
  Serial.println("\nTapproved ESP32 prototype ready.");
  Serial.print("Device public key (register with testnet contract): ");
  printHex(public_key, sizeof(public_key));
  Serial.println();
  Serial.println("Send one JSON payment request per line. Testnet-only prototype.");
}

void loop() {
  if (!key_ready) { delay(10); return; }
  while (Serial.available() > 0) {
    const int incoming = Serial.read();
    if (incoming < 0) break;
    if (incoming == '\r') continue;
    if (incoming == '\n') {
      if (serial_line_overflow) {
        Serial.println("{\"error\":\"frame_too_large\"}");
      } else if (serial_line_length > 0) {
        serial_line[serial_line_length] = '\0';
        handleRequest(serial_line);
      }
      serial_line_length = 0;
      serial_line_overflow = false;
      continue;
    }
    if (serial_line_overflow) continue;
    if (serial_line_length >= MAX_SERIAL_LINE_BYTES) {
      serial_line_overflow = true;
      continue;
    }
    serial_line[serial_line_length++] = static_cast<char>(incoming);
  }
  delay(10);
}

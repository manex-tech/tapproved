#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <Ed25519.h>
#include <esp_system.h>
#include <cstring>

namespace {
constexpr uint8_t APPROVAL_BUTTON_PIN = 25;
constexpr char NVS_NAMESPACE[] = "tapproved";
constexpr char NVS_SEED_KEY[] = "ed25519_seed";
constexpr char CONFIGURED_CONTRACT_ID[] = "tapproved.testnet";
constexpr char CONFIGURED_NETWORK_ID[] = "testnet";
constexpr size_t MAX_MESSAGE_SIZE = 512;

Preferences preferences;
uint8_t private_seed[32];
uint8_t public_key[32];
bool key_ready = false;

bool parseU64(const char* text, uint64_t& out) {
  if (!text || !*text) return false;
  uint64_t value = 0;
  for (const char* p = text; *p; ++p) {
    if (*p < '0' || *p > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(*p - '0');
    if (value > (UINT64_MAX - digit) / 10) return false;
    value = value * 10 + digit;
  }
  out = value;
  return true;
}

// Decimal u128 parser: emits 16 little-endian bytes without compiler-specific __int128.
bool parseU128LE(const char* text, uint8_t out[16]) {
  if (!text || !*text) return false;
  memset(out, 0, 16);
  for (const char* p = text; *p; ++p) {
    if (*p < '0' || *p > '9') return false;
    uint16_t carry = static_cast<uint16_t>(*p - '0');
    for (size_t i = 0; i < 16; ++i) {
      const uint16_t value = static_cast<uint16_t>(out[i]) * 10U + carry;
      out[i] = static_cast<uint8_t>(value & 0xffU);
      carry = value >> 8;
    }
    if (carry != 0) return false;
  }
  return true;
}

void appendU32LE(uint8_t* out, uint32_t value) {
  for (int i = 0; i < 4; ++i) out[i] = static_cast<uint8_t>(value >> (8 * i));
}
void appendU64LE(uint8_t* out, uint64_t value) {
  for (int i = 0; i < 8; ++i) out[i] = static_cast<uint8_t>(value >> (8 * i));
}
bool appendString(uint8_t* out, size_t& offset, const char* value) {
  if (!value || !*value) return false;
  const size_t length = strlen(value);
  if (length > UINT32_MAX || offset + 4 + length > MAX_MESSAGE_SIZE) return false;
  appendU32LE(out + offset, static_cast<uint32_t>(length));
  offset += 4;
  memcpy(out + offset, value, length);
  offset += length;
  return true;
}

bool encodeApproval(const JsonDocument& doc, uint8_t* out, size_t& out_len) {
  const char* contract_id = doc["contract_id"] | "";
  const char* network_id = doc["network_id"] | "";
  const char* recipient_id = doc["recipient_id"] | "";
  const char* amount = doc["amount_yocto"] | "";
  uint64_t payment_id, nonce, expires_at_ns;
  uint8_t amount_le[16];
  if (strcmp(contract_id, CONFIGURED_CONTRACT_ID) != 0 ||
      strcmp(network_id, CONFIGURED_NETWORK_ID) != 0 ||
      !parseU64(doc["payment_id"] | "", payment_id) ||
      !parseU64(doc["nonce"] | "", nonce) ||
      !parseU64(doc["expires_at_ns"] | "", expires_at_ns) ||
      !parseU128LE(amount, amount_le)) return false;

  size_t offset = 0;
  const uint8_t domain[] = {'T','A','P','P','R','O','V','E','D',0,1};
  memcpy(out + offset, domain, sizeof(domain)); offset += sizeof(domain);
  if (!appendString(out, offset, contract_id) ||
      !appendString(out, offset, network_id)) return false;
  appendU64LE(out + offset, payment_id); offset += 8;
  if (!appendString(out, offset, recipient_id)) return false;
  memcpy(out + offset, amount_le, sizeof(amount_le)); offset += sizeof(amount_le);
  appendU64LE(out + offset, nonce); offset += 8;
  appendU64LE(out + offset, expires_at_ns); offset += 8;
  if (offset > MAX_MESSAGE_SIZE) return false;
  out_len = offset;
  return true;
}

bool loadOrCreateKey() {
  if (!preferences.begin(NVS_NAMESPACE, false)) return false;
  const size_t stored = preferences.getBytesLength(NVS_SEED_KEY);
  if (stored == sizeof(private_seed)) {
    preferences.getBytes(NVS_SEED_KEY, private_seed, sizeof(private_seed));
  } else {
    esp_fill_random(private_seed, sizeof(private_seed));
    if (preferences.putBytes(NVS_SEED_KEY, private_seed, sizeof(private_seed)) != sizeof(private_seed)) {
      memset(private_seed, 0, sizeof(private_seed));
      preferences.end();
      return false;
    }
  }
  preferences.end();
  Ed25519::derivePublicKey(public_key, private_seed);
  key_ready = true;
  return true;
}

void printHex(const uint8_t* bytes, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    if (bytes[i] < 16) Serial.print('0');
    Serial.print(bytes[i], HEX);
  }
}

void handleRequest(const String& line) {
  JsonDocument doc;
  if (deserializeJson(doc, line)) {
    Serial.println("{\"error\":\"invalid_json\"}");
    return;
  }
  uint8_t message[MAX_MESSAGE_SIZE];
  size_t message_len = 0;
  if (!encodeApproval(doc, message, message_len)) {
    Serial.println("{\"error\":\"invalid_or_wrong_network_request\"}");
    return;
  }

  Serial.println("\n=== PAYMENT APPROVAL REQUEST ===");
  Serial.printf("Contract: %s\n", doc["contract_id"].as<const char*>());
  Serial.printf("Network:  %s\n", doc["network_id"].as<const char*>());
  Serial.printf("Payment:  %s\n", doc["payment_id"].as<const char*>());
  Serial.printf("Recipient: %s\n", doc["recipient_id"].as<const char*>());
  Serial.printf("Amount:   %s yoctoNEAR\n", doc["amount_yocto"].as<const char*>());
  Serial.printf("Expires:  %s ns\n", doc["expires_at_ns"].as<const char*>());
  Serial.println("Press and release the physical APPROVE button to sign.");
  Serial.println("Wait 30 seconds to reject.");

  const uint32_t started = millis();
  bool pressed = false;
  while (millis() - started < 30000) {
    if (digitalRead(APPROVAL_BUTTON_PIN) == LOW) {
      pressed = true;
      while (digitalRead(APPROVAL_BUTTON_PIN) == LOW) delay(10);
      break;
    }
    delay(10);
  }
  if (!pressed) {
    Serial.println("{\"status\":\"rejected_or_timed_out\"}");
    return;
  }

  uint8_t signature[64];
  Ed25519::sign(signature, private_seed, public_key, message, message_len);
  Serial.print("{\"status\":\"signed\",\"public_key_hex\":\"");
  printHex(public_key, sizeof(public_key));
  Serial.print("\",\"signature_hex\":\"");
  printHex(signature, sizeof(signature));
  Serial.println("\"}");
  memset(signature, 0, sizeof(signature));
  memset(message, 0, sizeof(message));
}
} // namespace

void setup() {
  Serial.begin(115200);
  pinMode(APPROVAL_BUTTON_PIN, INPUT_PULLUP);
  delay(300);
  if (!loadOrCreateKey()) {
    Serial.println("FATAL: unable to load/create device key.");
    return;
  }
  Serial.println("\nTapproved ESP32 prototype ready.");
  Serial.print("Device public key (register with testnet contract): ");
  printHex(public_key, sizeof(public_key));
  Serial.println();
  Serial.println("Send one JSON payment request per line. Testnet-only prototype.");
}

void loop() {
  if (!key_ready || !Serial.available()) { delay(10); return; }
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() > 0) handleRequest(line);
}

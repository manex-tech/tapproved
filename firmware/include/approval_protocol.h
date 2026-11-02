#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace tapproved_protocol {

constexpr size_t MAX_APPROVAL_MESSAGE_SIZE = 512;

namespace detail {

inline bool parseU64(const char* text, uint64_t& output) {
  if (!text || !*text || (text[0] == '0' && text[1] != '\0')) return false;
  uint64_t value = 0;
  for (const char* current = text; *current; ++current) {
    if (*current < '0' || *current > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(*current - '0');
    if (value > (UINT64_MAX - digit) / 10) return false;
    value = value * 10 + digit;
  }
  output = value;
  return true;
}

inline bool parseU128LE(const char* text, uint8_t output[16]) {
  if (!text || !*text || (text[0] == '0' && text[1] != '\0')) return false;
  memset(output, 0, 16);
  for (const char* current = text; *current; ++current) {
    if (*current < '0' || *current > '9') return false;
    uint16_t carry = static_cast<uint16_t>(*current - '0');
    for (size_t i = 0; i < 16; ++i) {
      const uint16_t value = static_cast<uint16_t>(output[i]) * 10U + carry;
      output[i] = static_cast<uint8_t>(value & 0xffU);
      carry = value >> 8;
    }
    if (carry != 0) return false;
  }
  return true;
}

inline bool isNonZero(const uint8_t value[16]) {
  for (size_t i = 0; i < 16; ++i) {
    if (value[i] != 0) return true;
  }
  return false;
}

inline void appendU32LE(uint8_t* output, uint32_t value) {
  for (int i = 0; i < 4; ++i) output[i] = static_cast<uint8_t>(value >> (8 * i));
}

inline void appendU64LE(uint8_t* output, uint64_t value) {
  for (int i = 0; i < 8; ++i) output[i] = static_cast<uint8_t>(value >> (8 * i));
}

inline bool appendString(uint8_t* output, size_t capacity, size_t& offset, const char* value) {
  if (!value || !*value) return false;
  const size_t length = strlen(value);
  if (length > UINT32_MAX || offset > capacity || capacity - offset < 4 ||
      length > capacity - offset - 4) return false;
  appendU32LE(output + offset, static_cast<uint32_t>(length));
  offset += 4;
  memcpy(output + offset, value, length);
  offset += length;
  return true;
}

}  // namespace detail

inline bool encodeApprovalMessage(
    const char* contract_id,
    const char* network_id,
    const char* payment_id_text,
    const char* recipient_id,
    const char* amount_yocto_text,
    const char* nonce_text,
    const char* expires_at_ns_text,
    uint8_t* output,
    size_t output_capacity,
    size_t& output_length) {
  if (!output || !contract_id || !network_id || !recipient_id) return false;

  uint64_t payment_id = 0;
  uint64_t nonce = 0;
  uint64_t expires_at_ns = 0;
  uint8_t amount_le[16];

  if (!detail::parseU64(payment_id_text, payment_id) || payment_id == 0 ||
      !detail::parseU64(nonce_text, nonce) ||
      !detail::parseU64(expires_at_ns_text, expires_at_ns) || expires_at_ns == 0 ||
      !detail::parseU128LE(amount_yocto_text, amount_le) || !detail::isNonZero(amount_le)) {
    return false;
  }

  size_t offset = 0;
  const uint8_t domain[] = {'T','A','P','P','R','O','V','E','D',0,1};
  if (sizeof(domain) > output_capacity) return false;
  memcpy(output + offset, domain, sizeof(domain));
  offset += sizeof(domain);

  if (!detail::appendString(output, output_capacity, offset, contract_id) ||
      !detail::appendString(output, output_capacity, offset, network_id)) return false;

  if (output_capacity - offset < 8) return false;
  detail::appendU64LE(output + offset, payment_id);
  offset += 8;

  if (!detail::appendString(output, output_capacity, offset, recipient_id)) return false;
  if (output_capacity - offset < sizeof(amount_le) + 16) return false;
  memcpy(output + offset, amount_le, sizeof(amount_le));
  offset += sizeof(amount_le);
  detail::appendU64LE(output + offset, nonce);
  offset += 8;
  detail::appendU64LE(output + offset, expires_at_ns);
  offset += 8;

  output_length = offset;
  return true;
}

}  // namespace tapproved_protocol

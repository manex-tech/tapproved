#include "key_record_policy.h"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <vector>

int main() {
  constexpr size_t seed_length = 32;
  assert(decideKeyRecordAction(false, 0, seed_length) == KeyRecordAction::GenerateNew);
  assert(decideKeyRecordAction(true, seed_length, seed_length) == KeyRecordAction::LoadExisting);
  assert(decideKeyRecordAction(true, 0, seed_length) == KeyRecordAction::RejectMalformed);
  assert(decideKeyRecordAction(true, 31, seed_length) == KeyRecordAction::RejectMalformed);
  assert(decideKeyRecordAction(true, 33, seed_length) == KeyRecordAction::RejectMalformed);

  // Model the persisted NVS record across boot boundaries. This exercises the
  // record policy, not the ESP-IDF Preferences implementation itself.
  std::vector<uint8_t> nvs_record;
  bool key_exists = false;
  std::array<uint8_t, seed_length> generated_seed{};
  for (size_t i = 0; i < generated_seed.size(); ++i) {
    generated_seed[i] = static_cast<uint8_t>(i + 1);
  }

  // First boot: absent record generates and persists one complete seed.
  assert(decideKeyRecordAction(key_exists, nvs_record.size(), seed_length) ==
         KeyRecordAction::GenerateNew);
  nvs_record.assign(generated_seed.begin(), generated_seed.end());
  key_exists = true;

  // Reset after a successful write: next boot loads exactly the same identity.
  assert(decideKeyRecordAction(key_exists, nvs_record.size(), seed_length) ==
         KeyRecordAction::LoadExisting);
  assert(nvs_record.size() == generated_seed.size());
  for (size_t i = 0; i < generated_seed.size(); ++i) {
    assert(nvs_record[i] == generated_seed[i]);
  }

  // If an interrupted write leaves a present, short record, it must fail
  // closed rather than silently generate and register a different key.
  nvs_record.assign(generated_seed.begin(), generated_seed.begin() + 13);
  assert(decideKeyRecordAction(true, nvs_record.size(), seed_length) ==
         KeyRecordAction::RejectMalformed);
  assert(nvs_record.size() == 13);

  // An absent record is treated as first boot. This is also indistinguishable
  // from a fully erased NVS record and can produce a new, unregistered key.
  nvs_record.clear();
  key_exists = false;
  assert(decideKeyRecordAction(key_exists, nvs_record.size(), seed_length) ==
         KeyRecordAction::GenerateNew);

  // Power loss after the full seed write but before public-key derivation is
  // safe: the complete record is loaded on the next boot.
  nvs_record.assign(generated_seed.begin(), generated_seed.end());
  key_exists = true;
  assert(decideKeyRecordAction(key_exists, nvs_record.size(), seed_length) ==
         KeyRecordAction::LoadExisting);
  assert(nvs_record[0] == generated_seed[0]);
  assert(nvs_record[seed_length - 1] == generated_seed[seed_length - 1]);

  return 0;
}

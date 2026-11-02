#include "key_record_policy.h"

#include <cassert>
#include <cstddef>

int main() {
  constexpr size_t seed_length = 32;
  assert(decideKeyRecordAction(false, 0, seed_length) == KeyRecordAction::GenerateNew);
  assert(decideKeyRecordAction(true, seed_length, seed_length) == KeyRecordAction::LoadExisting);
  assert(decideKeyRecordAction(true, 0, seed_length) == KeyRecordAction::RejectMalformed);
  assert(decideKeyRecordAction(true, 31, seed_length) == KeyRecordAction::RejectMalformed);
  assert(decideKeyRecordAction(true, 33, seed_length) == KeyRecordAction::RejectMalformed);
  return 0;
}

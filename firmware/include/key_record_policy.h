#pragma once

#include <cstddef>

enum class KeyRecordAction {
  GenerateNew,
  LoadExisting,
  RejectMalformed
};

inline KeyRecordAction decideKeyRecordAction(
    bool key_exists,
    size_t stored_length,
    size_t expected_length) {
  if (!key_exists) return KeyRecordAction::GenerateNew;
  return stored_length == expected_length
      ? KeyRecordAction::LoadExisting
      : KeyRecordAction::RejectMalformed;
}

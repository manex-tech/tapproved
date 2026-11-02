#pragma once

#include <cstdint>

class FreshPressDetector {
 public:
  explicit FreshPressDetector(uint32_t debounce_ms = 50)
      : debounce_ms_(debounce_ms) {}

  void begin(bool released, uint32_t now_ms) {
    raw_released_ = released;
    stable_released_ = released;
    last_raw_change_ms_ = now_ms;
    armed_ = false;
    saw_press_ = false;
    approved_ = false;
  }

  bool update(bool released, uint32_t now_ms) {
    if (released != raw_released_) {
      raw_released_ = released;
      last_raw_change_ms_ = now_ms;
    }

    if (static_cast<uint32_t>(now_ms - last_raw_change_ms_) < debounce_ms_) {
      return approved_;
    }

    if (stable_released_ != raw_released_) {
      stable_released_ = raw_released_;
      if (!armed_) {
        if (stable_released_) armed_ = true;
      } else if (!saw_press_ && !stable_released_) {
        saw_press_ = true;
      } else if (saw_press_ && stable_released_) {
        approved_ = true;
      }
    }

    // A button already released when the request arrives must remain released
    // for the full debounce interval before the detector can arm.
    if (!armed_ && stable_released_) armed_ = true;
    return approved_;
  }

  bool approved() const { return approved_; }
  bool armed() const { return armed_; }
  bool sawPress() const { return saw_press_; }

 private:
  uint32_t debounce_ms_;
  uint32_t last_raw_change_ms_ = 0;
  bool raw_released_ = false;
  bool stable_released_ = false;
  bool armed_ = false;
  bool saw_press_ = false;
  bool approved_ = false;
};

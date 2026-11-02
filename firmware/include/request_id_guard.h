#pragma once

#include <cstddef>
#include <cstring>

class LastRequestIdGuard {
 public:
  static constexpr size_t HISTORY_SIZE = 32;

  bool accept(const char* request_id) {
    if (!request_id || std::strlen(request_id) != 36) return false;
    for (size_t i = 0; i < count_; ++i) {
      if (std::strcmp(history_[i], request_id) == 0) return false;
    }
    std::memcpy(history_[next_], request_id, 36);
    history_[next_][36] = '\0';
    next_ = (next_ + 1) % HISTORY_SIZE;
    if (count_ < HISTORY_SIZE) ++count_;
    return true;
  }

 private:
  char history_[HISTORY_SIZE][37] = {};
  size_t count_ = 0;
  size_t next_ = 0;
};

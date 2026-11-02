#pragma once

#include <cstring>

class LastRequestIdGuard {
 public:
  bool accept(const char* request_id) {
    if (!request_id || strlen(request_id) != 36) return false;
    if (last_request_id_[0] != '\0' && std::strcmp(last_request_id_, request_id) == 0) {
      return false;
    }
    std::memcpy(last_request_id_, request_id, 36);
    last_request_id_[36] = '\0';
    return true;
  }

 private:
  char last_request_id_[37] = {};
};

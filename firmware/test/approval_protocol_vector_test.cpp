#include "approval_protocol.h"

#include <cstdio>
#include <cstdint>

int main(int argc, char** argv) {
  if (argc != 8) return 2;
  uint8_t message[tapproved_protocol::MAX_APPROVAL_MESSAGE_SIZE];
  size_t message_length = 0;
  if (!tapproved_protocol::encodeApprovalMessage(
        argv[1], argv[2], argv[3], argv[4], argv[5], argv[6], argv[7],
        message, sizeof(message), message_length)) {
    return 3;
  }
  for (size_t i = 0; i < message_length; ++i) {
    std::printf("%02x", message[i]);
  }
  std::printf("\n");
  return 0;
}
